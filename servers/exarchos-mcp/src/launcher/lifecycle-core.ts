/**
 * Launcher lifecycle orchestration — spawn → place → observe → teardown (DR-1, DR-6).
 *
 * This is the harness-AGNOSTIC integrator that composes the launcher building
 * blocks into one supervised launch. It contains NO per-harness branching: every
 * per-harness difference lives in the declarative {@link HarnessDescriptor} the
 * registry resolves, so the same seven-step flow drives all five Tier-1
 * harnesses:
 *
 *   1. **Resolve** the {@link HarnessDescriptor} via {@link resolveHarness}.
 *   2. **Create** the top-level, task-less worktree via
 *      {@link LauncherWlm.createWorktree} (guard → reserve → create pair). The
 *      canonical `worktreeId` + on-disk `worktreePath` come back from here.
 *   3. **Place** — overlay `descriptor.cwd` with the created worktree path so the
 *      child runs *in* the created worktree (the chdir/place step).
 *   4. **Claim** — emit `launch.executing_started` (liveness) carrying the
 *      canonical `worktreeId` + the launcher/supervisor `holderPid`
 *      (`process.pid`) + `holderStartedAt`, so task-016's dead-holder reconciler
 *      is expressible against a live supervisor PID.
 *   5. **Spawn** the child via {@link spawnHarnessChild} → a {@link ChildHandle}.
 *   6. **Observe** — await the child's `exit`.
 *   7. **Teardown exactly once** — emit the guaranteed `launch.executed` terminal
 *      via the idempotent Task-006 {@link emitLaunchExecuted} seam and release. No
 *      process, timer, or handle outlives the child.
 *
 * ## Guaranteed-terminal-once
 *
 * The teardown body runs AT MOST ONCE per launch: {@link once} memoizes the first
 * invocation's promise, so the normal-exit path AND the defensive `finally`
 * (which guarantees the terminal even if a throw slips between the claim and the
 * observe) collapse to a single teardown. The terminal itself additionally rides
 * the idempotent {@link emitLaunchExecuted} seam, so even a second teardown that
 * somehow ran could never persist a second `launch.executed` row.
 *
 * ## Injectable teardown seam (scope: later tasks extend, not reshape)
 *
 * {@link RunLifecycleDeps.teardown} is an overridable seam defaulting to
 * {@link defaultTeardown} (emit the terminal). Teardown-safety edges — never
 * `reset --hard`, recoveryError, crash / cwd-drift / origin — extend teardown
 * WITHOUT reshaping this core. Signal trapping/forwarding rides a SEPARATE
 * default-noop extension point, {@link RunLifecycleDeps.installSignals}
 * (defaulting to {@link noopInstallSignals}), invoked right after a successful
 * spawn and uninstalled in the `finally`: production wires the real
 * `signals#installSignalHandlers` there so a catchable interruption forwards to
 * the child, runs the same guaranteed-once teardown + terminal, and reaps — no
 * orphan. Orientation injection and the phantom reconciler likewise compose
 * around these seams; none of those concerns live here.
 */

import { rmSync } from 'node:fs';
import type { EventStore } from '../events/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  resolveHarness,
  type HarnessResolution,
  type HarnessTarget,
  type InjectionCandidate,
  type RuntimeId,
} from './harness-registry.js';
import {
  spawnCommandSync,
  spawnHarnessChild,
  SpawnError,
  type AsyncSpawnRequest,
  type ChildHandle,
  type SpawnDeps,
} from '../utils/process.js';
import {
  applyOrientationChannel,
  describeChannel,
  loadStandardBlockContent,
  type ChannelApplyDeps,
  type ResolvedInjectionChannel,
} from './injection-seam.js';
import { LauncherWlm, createLauncherWlm } from './wlm-compose.js';
import {
  emitLaunchExecutingStarted,
  emitLaunchExecuted,
  type EmitLaunchExecutedResult,
} from './liveness.js';
import type {
  CreateLauncherWorktreeDeps,
  CreateLauncherWorktreeResult,
} from './create-worktree.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from '../orchestrate/worktree/pure/process-identity.js';
import type { ResolvedLaunch, LifecycleRunner } from './verb.js';

// ============================================================
// Injectable seam types
// ============================================================

/** The async harness-spawn primitive (task 003) — injectable for deterministic tests. */
export type SpawnHarnessChildFn = (
  request: AsyncSpawnRequest,
  deps?: SpawnDeps,
) => Promise<ChildHandle>;

/** The liveness CLAIM emitter (task 006). */
export type EmitExecutingStartedFn = typeof emitLaunchExecutingStarted;

/** The idempotent liveness TERMINAL emitter (task 006). */
export type EmitExecutedFn = typeof emitLaunchExecuted;

/**
 * The context handed to the teardown seam. Carries the terminal correlator
 * (`worktreeId`), the observed `exitCode`, and the idempotent terminal emitter so
 * an override (tasks 011/012) can still route the guaranteed `launch.executed`
 * through the Task-006 seam.
 */
export interface LifecycleTeardownContext {
  readonly eventStore: EventStore;
  /** Canonical `worktrees@v1` key of the launch worktree — the terminal correlator. */
  readonly worktreeId: string;
  /** On-disk path of the created worktree the child ran in. */
  readonly worktreePath: string;
  /** Child exit code, or `null` when terminated by signal / not captured. */
  readonly exitCode: number | null;
  /** The idempotent Task-006 terminal emitter (guaranteed at-most-once). */
  readonly emitExecuted: EmitExecutedFn;
}

/**
 * The teardown seam — the guaranteed-terminal path. Defaults to
 * {@link defaultTeardown}; overridable so signal (task 011) and teardown-safety
 * (task 012) work extends it WITHOUT reshaping {@link runLifecycle}.
 */
export type LifecycleTeardown = (ctx: LifecycleTeardownContext) => Promise<void>;

/**
 * Default teardown: emit the guaranteed `launch.executed` terminal through the
 * idempotent Task-006 seam. Kept minimal on purpose — later tasks compose extra
 * teardown-safety edges around it, they do not replace this emit.
 */
export async function defaultTeardown(ctx: LifecycleTeardownContext): Promise<void> {
  await ctx.emitExecuted(ctx.eventStore, {
    worktreeId: ctx.worktreeId,
    exitCode: ctx.exitCode,
  });
}

// ============================================================
// Signal-install seam (DR-6) — default no-op extension point
// ============================================================

/**
 * The context the signal-install seam receives right after a successful spawn.
 * It exposes exactly what the DR-6 signal path needs — the live child (to
 * forward the terminating signal to + reap), the guaranteed-once teardown to run
 * on parent interruption, and a pre-bound idempotent terminal emitter — WITHOUT
 * this core importing the signal module. The production `lifecycleDeps` wires the
 * real `signals#installSignalHandlers` into it; everything else defaults to
 * {@link noopInstallSignals}.
 *
 * `teardown`/`emitTerminal` are the SAME guaranteed-once seams the normal-exit
 * path uses (`teardown` collapses onto the memoized {@link once} body;
 * `emitTerminal` rides the idempotent Task-006 seam), so a signal-driven teardown
 * and a normal-exit teardown can never persist two terminals.
 */
export interface LifecycleSignalContext {
  /** The live supervised child — forward the terminating signal + reap. */
  readonly child: Pick<ChildHandle, 'kill' | 'exit'>;
  /** Guaranteed-once teardown to run on a trapped SIGINT/SIGTERM. */
  readonly teardown: (signal: 'SIGINT' | 'SIGTERM') => void | Promise<void>;
  /** Pre-bound idempotent Task-006 terminal emitter (`worktreeId` + `exitCode: null`). */
  readonly emitTerminal: () => Promise<EmitLaunchExecutedResult>;
}

/**
 * Signal-install seam: trap + forward + reap the child, returning an UNINSTALLER
 * the core calls once the launch is over so no handler outlives the child.
 * Defaults to {@link noopInstallSignals} (installs nothing — the unit-test /
 * no-supervisor case); the production `lifecycleDeps` wires the real
 * `signals#installSignalHandlers`. A default-noop extension point does not
 * reshape the core observe→teardown flow.
 */
export type InstallSignals = (ctx: LifecycleSignalContext) => () => void;

/** No-op {@link InstallSignals}: installs no handler; its uninstaller is a no-op. */
export const noopInstallSignals: InstallSignals = () => noopUninstall;

/** Shared no-op uninstaller for {@link noopInstallSignals}. */
function noopUninstall(): void {
  /* intentionally empty — nothing was installed */
}

// ============================================================
// Spawn-time injection-channel probe (DR-6) — cached per process
// ============================================================

/**
 * Injectable help-probe seam: run `<command> --help` and return the combined
 * help text, or `null` when the CLI is absent / unspawnable (the fail-open
 * signal). Injected in tests so the probe path is deterministic without a real
 * CLI on the host.
 */
export type HelpProbe = (command: string) => string | null;

/** Per-process cache of help-probe OUTPUT keyed by command — the DR-6 "cached-per-process" store. */
const helpProbeCache = new Map<string, string | null>();

/** Clear the per-process help-probe cache. Test seam only (hermetic per-file isolation). */
export function clearHelpProbeCache(): void {
  helpProbeCache.clear();
}

/**
 * Default win32-safe help probe. Runs `<command> --help` through the
 * `.cmd`-shim-safe {@link spawnCommandSync} (the non-throwing sibling of
 * `runCommandSync`) — NEVER a raw `execFileSync`/`spawnSync` of a shim, which
 * breaks on win32 for `.cmd` shims (#1623). Returns combined stdout+stderr, or
 * `null` when the CLI is absent/unspawnable (a set `.error`, e.g. `ENOENT`).
 */
function defaultHelpProbe(command: string): string | null {
  const result = spawnCommandSync(command, ['--help'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.error) return null;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** Run (or cache-hit) the help probe for `command`; caches null (missing CLI) too. */
function cachedHelpProbe(command: string, probe: HelpProbe): string | null {
  if (helpProbeCache.has(command)) return helpProbeCache.get(command) ?? null;
  const output = probe(command);
  helpProbeCache.set(command, output);
  return output;
}

/**
 * Whether a CLI's help text advertises `flag` as a WHOLE token — a boundary match
 * so `--append-system-prompt` does NOT falsely match inside
 * `--append-system-prompt-file` (the char after the flag must not continue a flag
 * name). Order-independent, so the preference-ordered walk is robust either way.
 */
function helpMentionsFlag(helpText: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9-])`).test(helpText);
}

/** Outcome of the spawn-time channel probe. */
export interface ChannelResolution {
  /** The resolved native channel (a supported `flag`/`env`, or `none`). */
  readonly channel: ResolvedInjectionChannel;
  /** True when the launch will proceed WITHOUT native orientation (DR-8 fail-open). */
  readonly degraded: boolean;
  /** Human/log-safe degradation reason — present iff {@link degraded}. */
  readonly degradation?: string;
}

/** Injectable seams for {@link resolveInjectionChannel}. */
export interface ResolveInjectionChannelDeps {
  /** Help-probe seam; defaults to the win32-safe `<command> --help` probe. */
  readonly helpProbe?: HelpProbe;
}

/**
 * Resolve the injection channel AT SPAWN TIME (DR-6). Walks the descriptor's
 * preference-ordered candidate list front-to-back:
 *   - a `flag` candidate is selected iff the live CLI's `--help` output advertises
 *     its flag token (help probed once, cached per process);
 *   - an `env` candidate is a contract channel the harness auto-loads — selected
 *     directly (no help probe);
 *   - a `none` candidate is the documented out-of-band fallback — resolved to
 *     `none` WITHOUT degradation (it is declared, not a failure).
 *
 * CLI absent / probe failure (all flag candidates unverifiable), or a present CLI
 * advertising none of the declared flags, ⇒ `none` + a degradation (composes with
 * DR-8 fail-open). Never throws.
 */
export function resolveInjectionChannel(
  candidates: readonly InjectionCandidate[],
  command: string,
  deps: ResolveInjectionChannelDeps = {},
): ChannelResolution {
  const probe = deps.helpProbe ?? defaultHelpProbe;
  let help: string | null | undefined; // probed lazily only when a flag candidate needs it
  let probeFailed = false;

  for (const candidate of candidates) {
    switch (candidate.kind) {
      case 'env':
        return { channel: { kind: 'env', candidate }, degraded: false };
      case 'none':
        return { channel: { kind: 'none', reason: candidate.note }, degraded: false };
      case 'flag': {
        if (help === undefined) help = cachedHelpProbe(command, probe);
        if (help === null) {
          probeFailed = true;
          continue;
        }
        if (helpMentionsFlag(help, candidate.flag)) {
          return { channel: { kind: 'flag', candidate }, degraded: false };
        }
        continue;
      }
    }
  }

  const reason = probeFailed
    ? `injection channel probe failed: '${command}' CLI not spawnable`
    : `no declared injection flag advertised by '${command} --help'`;
  return { channel: { kind: 'none', reason }, degraded: true, degradation: reason };
}

// ============================================================
// Orientation injection wiring (DR-6 / DR-8) — fail-open
// ============================================================

/**
 * Injectable dependencies controlling spawn-time orientation injection. All
 * default to the live path (block-content loader + win32-safe probe + native
 * applier), so PRODUCTION injects by default — this is the first live wiring of
 * the injection seam. Tests inject deterministic seams (or `disabled`) to stay
 * hermetic.
 */
export interface OrientationInjectionDeps {
  /** Skip orientation injection entirely (deterministic launches that don't exercise it). */
  readonly disabled?: boolean;
  /** Explicit orientation content; overrides {@link loadContent}. */
  readonly content?: string;
  /** Content loader; defaults to reading `binding/standard/block.md` best-effort. */
  readonly loadContent?: () => string | undefined;
  /** Help-probe seam threaded to {@link resolveInjectionChannel}. */
  readonly helpProbe?: HelpProbe;
  /** Resolved-channel applier; defaults to {@link applyOrientationChannel}. */
  readonly apply?: (
    base: AsyncSpawnRequest,
    channel: ResolvedInjectionChannel,
    content: string,
  ) => AsyncSpawnRequest;
  /** Filesystem seams for the native `file`/`dir` applier forms. */
  readonly applyDeps?: ChannelApplyDeps;
}

/** The injection outcome threaded onto the spawn descriptor + the lifecycle result. */
interface InjectionOutcome {
  /** The (possibly orientation-augmented) descriptor to spawn. */
  readonly descriptor: AsyncSpawnRequest;
  /** The resolved-channel label surfaced on the result (`flag:…`/`env:…`/`none`/`disabled`). */
  readonly channel: string;
  /** True when the launch proceeds WITHOUT native orientation (DR-8 fail-open). */
  readonly degraded: boolean;
  /** Degradation reason — present iff {@link degraded}. */
  readonly degradation?: string;
  /** Ephemeral temp file/dir materialized for a `file`/`dir` channel, if any — the caller removes it on teardown. */
  readonly tempPath?: string;
}

/**
 * Resolve + apply spawn-time orientation for the placed descriptor (DR-6),
 * failing OPEN at every edge (DR-8): missing content, a `none`/failed channel, or
 * a construction throw all yield the UNMODIFIED descriptor + a degradation — the
 * launch always proceeds. Never throws.
 */
function resolveOrientationInjection(
  placed: AsyncSpawnRequest,
  candidates: readonly InjectionCandidate[],
  deps: OrientationInjectionDeps | undefined,
): InjectionOutcome {
  const o = deps ?? {};
  if (o.disabled) return { descriptor: placed, channel: 'disabled', degraded: false };

  const content = o.content ?? (o.loadContent ?? loadStandardBlockContent)();
  if (content === undefined || content.length === 0) {
    const degradation = 'orientation content unavailable (binding/standard/block.md not found)';
    return { descriptor: placed, channel: 'none', degraded: true, degradation };
  }

  const resolution = resolveInjectionChannel(
    candidates,
    placed.command,
    o.helpProbe ? { helpProbe: o.helpProbe } : {},
  );
  if (resolution.channel.kind === 'none') {
    return {
      descriptor: placed,
      channel: 'none',
      degraded: resolution.degraded,
      ...(resolution.degradation ? { degradation: resolution.degradation } : {}),
    };
  }

  try {
    let tempPath: string | undefined;
    const apply =
      o.apply ??
      ((b, c, ct) =>
        applyOrientationChannel(b, c, ct, {
          ...(o.applyDeps ?? {}),
          onTempPathCreated: (p) => {
            tempPath = p;
            o.applyDeps?.onTempPathCreated?.(p);
          },
        }));
    const descriptor = apply(placed, resolution.channel, content);
    return {
      descriptor,
      channel: describeChannel(resolution.channel),
      degraded: false,
      ...(tempPath !== undefined ? { tempPath } : {}),
    };
  } catch (err) {
    const degradation = `orientation injection construction failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    return { descriptor: placed, channel: 'none', degraded: true, degradation };
  }
}

// ============================================================
// Lifecycle deps + result
// ============================================================

/** Injectable dependencies for {@link runLifecycle}. */
export interface RunLifecycleDeps {
  /**
   * Dispatch context whose `eventStore` is the append substrate every lifecycle
   * event lands on, and whose seams the composed {@link LauncherWlm} threads. In
   * tests this is a `{ stateDir, eventStore, enableTelemetry: false }` literal
   * over a real SQLite store.
   */
  readonly ctx: DispatchContext;
  /** WLM composition facade; defaults to a fresh one over `ctx`. */
  readonly wlm?: LauncherWlm;
  /** Async harness-spawn primitive; defaults to the real {@link spawnHarnessChild}. */
  readonly spawnChild?: SpawnHarnessChildFn;
  /** Harness resolver; defaults to the real {@link resolveHarness}. */
  readonly resolveHarness?: (target: string) => HarnessResolution;
  /** Liveness CLAIM emitter; defaults to the real {@link emitLaunchExecutingStarted}. */
  readonly emitExecutingStarted?: EmitExecutingStartedFn;
  /** Idempotent terminal emitter; defaults to the real {@link emitLaunchExecuted}. */
  readonly emitExecuted?: EmitExecutedFn;
  /** Teardown seam; defaults to {@link defaultTeardown}. */
  readonly teardown?: LifecycleTeardown;
  /**
   * Signal-install seam invoked right after a successful spawn (DR-6). Defaults
   * to {@link noopInstallSignals}; the production `lifecycleDeps` wires the real
   * `signals#installSignalHandlers` so a trapped SIGINT/SIGTERM is forwarded to
   * the child, teardown + the guaranteed terminal run, and the child is reaped —
   * no orphan survives a catchable interruption of the launcher.
   */
  readonly installSignals?: InstallSignals;
  /**
   * The launcher/supervisor PID recorded on the liveness CLAIM (task-016's
   * dead-holder anchor). Defaults to `process.pid` — the long-lived supervisor
   * that owns the child's lifecycle and emits the terminal.
   */
  readonly holderPid?: number;
  /**
   * Supervisor create-time fingerprint (defeats PID reuse). Defaults to a probed
   * value — `null` (NEVER `''`) when the platform cannot resolve it, so the
   * emitted claim honors the null-ready `holderStartedAt` schema contract.
   */
  readonly holderStartedAt?: string | null;
  /** Process-identity source for the holder start-time probe. Defaults to the OS source. */
  readonly processSource?: ProcessSource;
  /** New branch for the created worktree (`git worktree add -b`). Omit to let git derive it. */
  readonly newBranch?: string;
  /** Start-point commit-ish for the created worktree. */
  readonly startPoint?: string;
  /** Repo root `git worktree add` runs from. Defaults to the base worktree. */
  readonly repoRoot?: string;
  /**
   * Extra create-worktree seams (git runner / guard / realpath). The reserve
   * owner defaults to the holder identity ({@link holderPid} /
   * {@link holderStartedAt}); anything here overrides.
   */
  readonly createDeps?: CreateLauncherWorktreeDeps;
  /**
   * Spawn-time orientation-injection seams (DR-6). Absent → the live default
   * path (block-content loader + win32-safe help probe + native applier), so a
   * production launch injects orientation into the resolved native channel and
   * records a degradation on any fail-open edge. Tests inject deterministic
   * seams (or `{ disabled: true }`).
   */
  readonly orientation?: OrientationInjectionDeps;
}

/**
 * The spawn-time orientation-injection record surfaced on a completed launch
 * (DR-6 / DR-8). Carries the resolved channel and, when the launch fell open,
 * the degradation reason — recorded at the `launch.executing_started` phase.
 */
export interface LaunchInjectionInfo {
  /** Resolved-channel label — `flag:<flag>` / `env:<var>` / `none` / `disabled`. */
  readonly channel: string;
  /** True when the launch proceeded WITHOUT native orientation (fail-open). */
  readonly degraded: boolean;
  /** Degradation reason — present iff {@link degraded}. */
  readonly degradation?: string;
}

/** Structured success payload of a completed launch. */
export interface LifecycleResultData {
  readonly harness: HarnessTarget;
  readonly runtimeId: RuntimeId;
  /** Canonical `worktrees@v1` key of the created launch worktree. */
  readonly worktreeId: string;
  /** On-disk path the child ran in (the placed cwd). */
  readonly worktreePath: string;
  /** PID of the spawned child, when the spawn primitive reported one. */
  readonly childPid: number | undefined;
  /** The child's exit code, or `null` when terminated by signal / not captured. */
  readonly exitCode: number | null;
  /** Spawn-time orientation-injection record (resolved channel + any fail-open degradation). */
  readonly injection: LaunchInjectionInfo;
}

// ============================================================
// Lifecycle core
// ============================================================

/**
 * Run one supervised harness launch end-to-end: resolve → create → place →
 * claim → spawn → observe → teardown-once. Harness-agnostic; see the module
 * header for the DR-1/DR-6 contract and the guaranteed-terminal-once guarantee.
 */
export async function runLifecycle(
  params: ResolvedLaunch,
  deps: RunLifecycleDeps,
): Promise<ToolResult> {
  const eventStore = deps.ctx.eventStore;
  const resolveHarnessFn = deps.resolveHarness ?? resolveHarness;
  const spawnChild = deps.spawnChild ?? spawnHarnessChild;
  const emitExecutingStarted = deps.emitExecutingStarted ?? emitLaunchExecutingStarted;
  const emitExecuted = deps.emitExecuted ?? emitLaunchExecuted;
  const teardown = deps.teardown ?? defaultTeardown;
  const installSignals = deps.installSignals ?? noopInstallSignals;
  const processSource = deps.processSource ?? defaultProcessSource;
  const wlm = deps.wlm ?? createLauncherWlm({ ctx: deps.ctx });

  // ── (1) Resolve the declarative descriptor. ────────────────────────────────
  const resolution = resolveHarnessFn(params.harness);
  if (!resolution.success) {
    return {
      success: false,
      error: {
        code: resolution.code,
        message: resolution.message,
        validTargets: resolution.validTargets,
      },
    };
  }

  // ── (2) Create the top-level, task-less worktree (guard + reserve + pair). ──
  const holderPid = deps.holderPid ?? process.pid;
  const holderStartedAt =
    deps.holderStartedAt ?? resolveHolderStartedAt(holderPid, processSource);

  const created = await wlm.createWorktree(
    {
      baseWorktree: params.base,
      id: params.worktreeId,
      featureId: params.feature,
      ...(deps.newBranch !== undefined ? { newBranch: deps.newBranch } : {}),
      ...(deps.startPoint !== undefined ? { startPoint: deps.startPoint } : {}),
      ...(deps.repoRoot !== undefined ? { repoRoot: deps.repoRoot } : {}),
    },
    {
      selfPid: holderPid,
      selfStartedAt: holderStartedAt,
      ...deps.createDeps,
    },
  );
  if (!created.ok) {
    return createFailureResult(created);
  }
  const { worktreeId, worktreePath } = created;

  // ── (3) Place: overlay the descriptor cwd so the child runs IN the worktree. ─
  const placed: AsyncSpawnRequest = { ...resolution.descriptor, cwd: worktreePath };

  // ── (3b) Resolve + apply spawn-time orientation (DR-6), failing OPEN (DR-8). ─
  // The channel is probed at spawn time (cached per process) and applied via the
  // injection seam. Any edge — missing content, none/failed channel, construction
  // throw — yields the unmodified descriptor + a degradation; the launch proceeds.
  const injection = resolveOrientationInjection(
    placed,
    resolution.descriptor.injection,
    deps.orientation,
  );
  const descriptor = injection.descriptor;

  // The guaranteed-terminal-once teardown: memoized so the normal-exit path and
  // the defensive `finally` collapse to a single teardown body invocation.
  const teardownOnce = once((exitCode: number | null) =>
    teardown({ eventStore, worktreeId, worktreePath, exitCode, emitExecuted }),
  );

  let exitCode: number | null = null;
  let childPid: number | undefined;
  // Signal handlers are installed only AFTER a successful spawn (they need the
  // live child); the uninstaller is called in the `finally` so no handler
  // outlives the launch. Undefined until installed (spawn-failure path).
  let uninstallSignals: (() => void) | undefined;
  // The live child, tracked so the `finally` can guarantee it is reaped even when
  // a post-spawn step throws. Set right after a successful spawn and CLEARED the
  // instant its exit is cleanly observed — so the finally kills it ONLY on the
  // post-spawn error path (see the finally below).
  let liveChild: ChildHandle | undefined;
  try {
    // ── (4) Liveness CLAIM (supervisor holderPid), BEFORE the spawn. ──────────
    await emitExecutingStarted(eventStore, { worktreeId, holderPid, holderStartedAt });

    // ── (5) Spawn the child into the placed worktree. ─────────────────────────
    let child: ChildHandle;
    try {
      child = await spawnChild(descriptor);
    } catch (err) {
      // Spawn never started: close the launch (terminal) and report structured.
      await teardownOnce(null);
      return spawnFailureResult(err);
    }
    childPid = child.pid;
    liveChild = child;

    // ── (5b) Install signal handlers over the live child (DR-6). ──────────────
    // A trapped SIGINT/SIGTERM forwards to the child, runs the SAME guaranteed-
    // once teardown (memoized `teardownOnce`, `null` exit for a signalled child),
    // guarantees the idempotent terminal, and reaps — no orphan if the launcher
    // is interrupted. Defaults to a no-op; production wires the real installer.
    uninstallSignals = installSignals({
      child,
      teardown: () => teardownOnce(null),
      emitTerminal: () => emitExecuted(eventStore, { worktreeId, exitCode: null }),
    });

    // ── (6) Observe: await the child's exit. ──────────────────────────────────
    const exit = await child.exit;
    exitCode = exit.code;
    // Cleanly observed → the child is gone; the finally must NOT kill it.
    liveChild = undefined;

    // ── (7) Teardown exactly once: emit the guaranteed terminal + release. ────
    await teardownOnce(exitCode);

    const data: LifecycleResultData = {
      harness: resolution.target,
      runtimeId: resolution.runtimeId,
      worktreeId,
      worktreePath,
      childPid,
      exitCode,
      injection: {
        channel: injection.channel,
        degraded: injection.degraded,
        ...(injection.degradation ? { degradation: injection.degradation } : {}),
      },
    };
    return { success: true, data };
  } finally {
    // Uninstall the signal handlers so none outlives the launch.
    uninstallSignals?.();
    // Guard the post-spawn failure path: if `installSignals` or `await child.exit`
    // threw/rejected with the child still live, neither the normal-exit nor the
    // signal path reaped it — kill and reap it here so no orphan survives an error
    // path. A cleanly-observed exit cleared `liveChild`, so this runs ONLY on the
    // failure path; it also drops the child before teardown's occupancy probe.
    if (liveChild !== undefined) {
      await killAndReapChild(liveChild);
    }
    // THEN guarantee the terminal-once even if a throw slipped between claim and
    // observe (idempotent; a no-op if the try body or signal path already fired).
    await teardownOnce(exitCode);
    // Remove the ephemeral orientation temp file/dir (if a `file`/`dir` channel
    // materialized one) now that the child is done with it — best-effort, since a
    // launch must never fail on cleanup of a scratch path.
    if (injection.tempPath !== undefined) {
      try {
        rmSync(injection.tempPath, { recursive: true, force: true });
      } catch {
        /* best-effort — an orphaned temp path is a disk-space nit, not a launch failure. */
      }
    }
  }
}

/**
 * Best-effort kill-and-reap of a still-live child on the post-spawn ERROR path
 * (an `installSignals` throw or an `await child.exit` rejection). SIGKILL is
 * uncatchable so the child terminates promptly; awaiting `exit` afterwards
 * collects it so THIS parent reaps it rather than leaving an orphan reparented to
 * init. Both steps swallow their own errors — the exit promise may already be the
 * rejection that brought us here — so the ORIGINAL failure still propagates and
 * teardown still runs.
 */
async function killAndReapChild(child: Pick<ChildHandle, 'kill' | 'exit'>): Promise<void> {
  try {
    child.kill('SIGKILL');
  } catch {
    /* the child may already be gone — best-effort. */
  }
  try {
    await child.exit;
  } catch {
    /* exit may itself reject (the failure that brought us here); swallow it. */
  }
}

/**
 * Adapt {@link runLifecycle} to the verb's {@link LifecycleRunner} seam by
 * binding the deps. This is what `verb.ts` wires as the real non-dry-run default.
 */
export function makeLifecycleRunner(deps: RunLifecycleDeps): LifecycleRunner {
  return (launch) => runLifecycle(launch, deps);
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Memoize a single-argument async body so it runs AT MOST ONCE: the first call
 * records the promise; every later call returns that same promise (its argument
 * ignored). This is the guaranteed-terminal-once guard — the normal-exit path
 * and the defensive `finally` both call it, and only the first actually tears down.
 */
function once(
  body: (exitCode: number | null) => Promise<void>,
): (exitCode: number | null) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (exitCode) => (pending ??= body(exitCode));
}

/**
 * Resolve the supervisor create-time via the injected source; `null` (NEVER the
 * empty string `''`) when the platform cannot resolve it. `null` threads through
 * the launcher's null-ready `holderStartedAt` claim contract
 * (`z.string().min(1).nullable()`); `''` would be the `''`-vs-`.min(1)`
 * invalid-raw-event class. Mirrors `merge-serializer`'s `resolveSelfStartedAt`.
 */
function resolveHolderStartedAt(pid: number, source: ProcessSource): string | null {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' ? probe.startedAt : null;
}

/** Map a non-`ok` {@link CreateLauncherWorktreeResult} to a structured ToolResult. */
function createFailureResult(
  created: Extract<CreateLauncherWorktreeResult, { ok: false }>,
): ToolResult {
  switch (created.reason) {
    case 'containment-refused':
      return {
        success: false,
        error: { code: 'WORKTREE_CONTAINMENT_REFUSED', message: created.refusal.message },
      };
    case 'reserve-conflict':
      return {
        success: false,
        error: {
          code: 'WORKTREE_RESERVE_CONFLICT',
          message: 'launcher worktree is already reserved by a live owner',
        },
      };
    case 'git-add-failed':
      return {
        success: false,
        error: { code: 'WORKTREE_CREATE_FAILED', message: created.stderr },
      };
  }
}

/** Map a spawn failure to a structured ToolResult (never a thrown, uncaught error). */
function spawnFailureResult(err: unknown): ToolResult {
  const code = err instanceof SpawnError ? err.code : 'SPAWN_FAILED';
  const message = err instanceof Error ? err.message : String(err);
  return { success: false, error: { code, message } };
}

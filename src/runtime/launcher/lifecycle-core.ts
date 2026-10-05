/**
 * The launcher lifecycle. It has no per-harness branch. Each per-harness
 * difference lives in the {@link HarnessDescriptor}, so one flow drives all
 * five Tier-1 harnesses:
 *
 *   1. Resolve the descriptor with {@link resolveHarness}.
 *   2. Create the task-less worktree with {@link LauncherWlm.createWorktree}.
 *   3. Place the child: replace `descriptor.cwd` with the worktree path.
 *   4. Claim: emit `launch.executing_started` with the `worktreeId`, the
 *      supervisor `holderPid` and `holderStartedAt`.
 *   5. Spawn the child with {@link spawnHarnessChild}, and observe its `exit`.
 *   6. Tear down once: emit the `launch.executed` terminal.
 *
 * The teardown body runs at most once, through {@link once}. The terminal
 * emitter is also idempotent, so the store never gets a second terminal row.
 */

import { rmSync } from 'node:fs';
import type { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
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
} from '../../utils/process.js';
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
} from '../../verbs/worktree/pure/process-identity.js';
import type { ResolvedLaunch, LifecycleRunner } from './verb.js';

/** The async harness-spawn primitive. Tests inject it. */
export type SpawnHarnessChildFn = (
  request: AsyncSpawnRequest,
  deps?: SpawnDeps,
) => Promise<ChildHandle>;

/** The liveness claim emitter. */
export type EmitExecutingStartedFn = typeof emitLaunchExecutingStarted;

/** The idempotent liveness terminal emitter. */
export type EmitExecutedFn = typeof emitLaunchExecuted;

/**
 * The context of the teardown seam. It carries the `worktreeId` correlator, the
 * `exitCode`, and the idempotent terminal emitter. Thus an override can still
 * emit `launch.executed`.
 */
export interface LifecycleTeardownContext {
  readonly eventStore: EventStore;
  /** Canonical `worktrees@v1` key of the launch worktree — the terminal correlator. */
  readonly worktreeId: string;
  /** On-disk path of the created worktree the child ran in. */
  readonly worktreePath: string;
  /** Child exit code, or `null` when terminated by signal / not captured. */
  readonly exitCode: number | null;
  /** The idempotent terminal emitter. It persists at most one row. */
  readonly emitExecuted: EmitExecutedFn;
}

/**
 * The teardown seam, the path that emits the terminal. It defaults to
 * {@link defaultTeardown}. An override adds teardown steps without a change to
 * {@link runLifecycle}.
 */
export type LifecycleTeardown = (ctx: LifecycleTeardownContext) => Promise<void>;

/** Emit the `launch.executed` terminal through the idempotent emitter. */
export async function defaultTeardown(ctx: LifecycleTeardownContext): Promise<void> {
  await ctx.emitExecuted(ctx.eventStore, {
    worktreeId: ctx.worktreeId,
    exitCode: ctx.exitCode,
  });
}

/**
 * The context of the signal-install seam after a successful spawn: the live
 * child, the once-only teardown, and a bound terminal emitter. Thus this core
 * does not import the signal module. `teardown` and `emitTerminal` are the same
 * once-only paths as the normal exit, so a launch cannot persist two terminals.
 */
export interface LifecycleSignalContext {
  /** The live child. The handler forwards the signal to it and reaps it. */
  readonly child: Pick<ChildHandle, 'kill' | 'exit'>;
  /** The once-only teardown to run on a trapped SIGINT or SIGTERM. */
  readonly teardown: (signal: 'SIGINT' | 'SIGTERM') => void | Promise<void>;
  /** The bound idempotent terminal emitter, with `exitCode: null`. */
  readonly emitTerminal: () => Promise<EmitLaunchExecutedResult>;
}

/**
 * The signal-install seam. It traps signals, forwards them to the child, and
 * reaps it. It returns an uninstaller that the core calls at the end of the
 * launch. It defaults to {@link noopInstallSignals}, and `production-deps.ts`
 * wires `installSignalHandlers`.
 */
export type InstallSignals = (ctx: LifecycleSignalContext) => () => void;

/** An {@link InstallSignals} that installs no handler and returns a no-op uninstaller. */
export const noopInstallSignals: InstallSignals = () => noopUninstall;

/** Shared no-op uninstaller for {@link noopInstallSignals}. */
function noopUninstall(): void {
}

/**
 * Run `<command> --help` and return the combined help text, or `null` when the
 * CLI is absent or cannot spawn. Tests inject it.
 */
export type HelpProbe = (command: string) => string | null;

/** The help-probe output of each command, cached for the process. */
const helpProbeCache = new Map<string, string | null>();

/** Clear the help-probe cache. Tests call it for isolation. */
export function clearHelpProbeCache(): void {
  helpProbeCache.clear();
}

/**
 * The default help probe. It runs `<command> --help` through
 * {@link spawnCommandSync}, which is safe for `.cmd` shims on win32, where a raw
 * `execFileSync` of a shim fails. It returns stdout and stderr, or `null` when
 * the spawn sets `error`, such as `ENOENT`.
 */
function defaultHelpProbe(command: string): string | null {
  const result = spawnCommandSync(command, ['--help'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  if (result.error) return null;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/** Run the help probe for `command` once for each process. It also caches a `null` result. */
function cachedHelpProbe(command: string, probe: HelpProbe): string | null {
  if (helpProbeCache.has(command)) return helpProbeCache.get(command) ?? null;
  const output = probe(command);
  helpProbeCache.set(command, output);
  return output;
}

/**
 * True when the help text names `flag` as a whole token. Thus
 * `--append-system-prompt` does not match inside `--append-system-prompt-file`.
 */
function helpMentionsFlag(helpText: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9-])`).test(helpText);
}

/** Outcome of the spawn-time channel probe. */
export interface ChannelResolution {
  /** The resolved native channel (a supported `flag`/`env`, or `none`). */
  readonly channel: ResolvedInjectionChannel;
  /** True when the launch proceeds without native orientation. */
  readonly degraded: boolean;
  /** A log-safe degradation reason, present only when {@link degraded} is true. */
  readonly degradation?: string;
}

/** Injectable seams for {@link resolveInjectionChannel}. */
export interface ResolveInjectionChannelDeps {
  /** The help-probe seam. It defaults to the win32-safe `<command> --help` probe. */
  readonly helpProbe?: HelpProbe;
}

/**
 * Resolve the injection channel at spawn time. It walks the candidates in order:
 *   - It selects a `flag` candidate when the `--help` output of the CLI names the
 *     flag. The probe runs only for a flag candidate, once for each process.
 *   - It selects an `env` candidate directly, because the harness loads it.
 *   - A `none` candidate gives `none` with no degradation, because it is declared.
 *
 * When the probe fails, or the CLI names no declared flag, the result is `none`
 * with a degradation. It never throws.
 */
export function resolveInjectionChannel(
  candidates: readonly InjectionCandidate[],
  command: string,
  deps: ResolveInjectionChannelDeps = {},
): ChannelResolution {
  const probe = deps.helpProbe ?? defaultHelpProbe;
  let help: string | null | undefined;
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

/**
 * The seams of spawn-time orientation injection. Each defaults to the live path,
 * so a production launch injects orientation. Tests inject fixed seams or
 * `disabled`.
 */
export interface OrientationInjectionDeps {
  /** Skip orientation injection. */
  readonly disabled?: boolean;
  /** Explicit orientation content. It overrides {@link loadContent}. */
  readonly content?: string;
  /** The content loader. It defaults to a best-effort read of `binding/standard/block.md`. */
  readonly loadContent?: () => string | undefined;
  /** Help-probe seam threaded to {@link resolveInjectionChannel}. */
  readonly helpProbe?: HelpProbe;
  /** The resolved-channel applier. It defaults to {@link applyOrientationChannel}. */
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
  /** True when the launch proceeds without native orientation. */
  readonly degraded: boolean;
  /** The degradation reason, present only when {@link degraded} is true. */
  readonly degradation?: string;
  /** The temp file or directory of a `file` or `dir` channel. The caller removes it at teardown. */
  readonly tempPath?: string;
}

/**
 * Resolve and apply spawn-time orientation for the placed descriptor. Missing
 * content, a failed channel or a throw gives the unchanged descriptor and a
 * degradation, so the launch proceeds. A declared `none` channel gives the
 * unchanged descriptor with no degradation. It never throws.
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

/** Injectable dependencies for {@link runLifecycle}. */
export interface RunLifecycleDeps {
  /**
   * The dispatch context. Its `eventStore` receives each lifecycle event, and
   * the composed {@link LauncherWlm} uses its seams.
   */
  readonly ctx: DispatchContext;
  /** The WLM facade. It defaults to a new one over `ctx`. */
  readonly wlm?: LauncherWlm;
  /** The async harness-spawn primitive. It defaults to {@link spawnHarnessChild}. */
  readonly spawnChild?: SpawnHarnessChildFn;
  /** The harness resolver. It defaults to {@link resolveHarness}. */
  readonly resolveHarness?: (target: string) => HarnessResolution;
  /** The liveness claim emitter. It defaults to {@link emitLaunchExecutingStarted}. */
  readonly emitExecutingStarted?: EmitExecutingStartedFn;
  /** The idempotent terminal emitter. It defaults to {@link emitLaunchExecuted}. */
  readonly emitExecuted?: EmitExecutedFn;
  /** The teardown seam. It defaults to {@link defaultTeardown}. */
  readonly teardown?: LifecycleTeardown;
  /**
   * The signal-install seam, called after a successful spawn. It defaults to
   * {@link noopInstallSignals}. With `installSignalHandlers`, a trapped signal
   * goes to the child, teardown emits the terminal, and the child is reaped.
   */
  readonly installSignals?: InstallSignals;
  /**
   * The supervisor PID on the liveness claim, the anchor of the dead-holder
   * check. It defaults to `process.pid`, the supervisor that owns the child.
   */
  readonly holderPid?: number;
  /**
   * The supervisor start-time fingerprint, which defeats PID reuse. It defaults
   * to a probed value, or `null` when the platform cannot resolve it.
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
   * Extra create-worktree seams, such as the git runner, guard and realpath.
   * The reserve owner defaults to the holder identity, and a value here
   * overrides it.
   */
  readonly createDeps?: CreateLauncherWorktreeDeps;
  /**
   * The spawn-time orientation seams. When absent, a launch uses the live path
   * and records a degradation on each fail-open edge. Tests inject fixed seams
   * or `{ disabled: true }`.
   */
  readonly orientation?: OrientationInjectionDeps;
}

/**
 * The orientation record of a completed launch: the resolved channel and, on a
 * fail-open launch, the degradation reason.
 */
export interface LaunchInjectionInfo {
  /** Resolved-channel label — `flag:<flag>` / `env:<var>` / `none` / `disabled`. */
  readonly channel: string;
  /** True when the launch proceeded without native orientation. */
  readonly degraded: boolean;
  /** The degradation reason, present only when {@link degraded} is true. */
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

/**
 * Run one supervised harness launch, in the steps of the module header.
 * When orientation injection fails, the launch proceeds without it.
 *
 * The signal handlers install after a successful spawn. The `finally` block
 * removes them, and kills and reaps a child that is still live after an error.
 * The kill comes before teardown, so the occupancy probe of teardown does not see the child.
 * Then the block calls the once-only teardown, which does nothing when teardown already
 * ran. Last, it removes the orientation temp path and ignores a failure.
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

  const placed: AsyncSpawnRequest = { ...resolution.descriptor, cwd: worktreePath };

  const injection = resolveOrientationInjection(
    placed,
    resolution.descriptor.injection,
    deps.orientation,
  );
  const descriptor = injection.descriptor;

  const teardownOnce = once((exitCode: number | null) =>
    teardown({ eventStore, worktreeId, worktreePath, exitCode, emitExecuted }),
  );

  let exitCode: number | null = null;
  let childPid: number | undefined;
  let uninstallSignals: (() => void) | undefined;
  let liveChild: ChildHandle | undefined;
  try {
    await emitExecutingStarted(eventStore, { worktreeId, holderPid, holderStartedAt });

    let child: ChildHandle;
    try {
      child = await spawnChild(descriptor);
    } catch (err) {
      await teardownOnce(null);
      return spawnFailureResult(err);
    }
    childPid = child.pid;
    liveChild = child;

    uninstallSignals = installSignals({
      child,
      teardown: () => teardownOnce(null),
      emitTerminal: () => emitExecuted(eventStore, { worktreeId, exitCode: null }),
    });

    const exit = await child.exit;
    exitCode = exit.code;
    liveChild = undefined;

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
    uninstallSignals?.();
    if (liveChild !== undefined) {
      await killAndReapChild(liveChild);
    }
    await teardownOnce(exitCode);
    if (injection.tempPath !== undefined) {
      try {
        rmSync(injection.tempPath, { recursive: true, force: true });
      } catch {
      }
    }
  }
}

/**
 * Kill and reap a live child after a post-spawn error. SIGKILL cannot be
 * caught, so the child stops. The await on `exit` then reaps it in this parent.
 * Both steps ignore their own errors, so the original failure still propagates.
 */
async function killAndReapChild(child: Pick<ChildHandle, 'kill' | 'exit'>): Promise<void> {
  try {
    child.kill('SIGKILL');
  } catch {
  }
  try {
    await child.exit;
  } catch {
  }
}

/**
 * Adapt {@link runLifecycle} to the verb's {@link LifecycleRunner} seam by
 * binding the deps. This is what `verb.ts` wires as the real non-dry-run default.
 */
export function makeLifecycleRunner(deps: RunLifecycleDeps): LifecycleRunner {
  return (launch) => runLifecycle(launch, deps);
}

/**
 * Run an async body at most once. The first call keeps the promise, and each
 * later call returns it and ignores its argument. The normal exit, the signal
 * path and the `finally` block call it, so only the first call tears down.
 */
function once(
  body: (exitCode: number | null) => Promise<void>,
): (exitCode: number | null) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (exitCode) => (pending ??= body(exitCode));
}

/**
 * Resolve the supervisor start time through `source`, or `null` when the
 * platform cannot resolve it. It never returns an empty string, because the
 * `holderStartedAt` schema is `z.string().min(1).nullable()`.
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

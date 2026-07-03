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
 * {@link defaultTeardown} (emit the terminal). Signal trapping/forwarding
 * (task 011) and teardown-safety edges — never `reset --hard`, recoveryError,
 * crash / cwd-drift / origin (task 012) — extend teardown WITHOUT reshaping this
 * core. Orientation injection (task 013) and the phantom reconciler (task 016)
 * likewise compose around this seam. None of those concerns live here.
 */

import type { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import {
  resolveHarness,
  type HarnessResolution,
  type HarnessTarget,
  type RuntimeId,
} from './harness-registry.js';
import {
  spawnHarnessChild,
  SpawnError,
  type AsyncSpawnRequest,
  type ChildHandle,
  type SpawnDeps,
} from '../utils/process.js';
import { LauncherWlm, createLauncherWlm } from './wlm-compose.js';
import {
  emitLaunchExecutingStarted,
  emitLaunchExecuted,
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
   * The launcher/supervisor PID recorded on the liveness CLAIM (task-016's
   * dead-holder anchor). Defaults to `process.pid` — the long-lived supervisor
   * that owns the child's lifecycle and emits the terminal.
   */
  readonly holderPid?: number;
  /** Supervisor create-time fingerprint (defeats PID reuse). Defaults to a probed value. */
  readonly holderStartedAt?: string;
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
  const descriptor: AsyncSpawnRequest = { ...resolution.descriptor, cwd: worktreePath };

  // The guaranteed-terminal-once teardown: memoized so the normal-exit path and
  // the defensive `finally` collapse to a single teardown body invocation.
  const teardownOnce = once((exitCode: number | null) =>
    teardown({ eventStore, worktreeId, worktreePath, exitCode, emitExecuted }),
  );

  let exitCode: number | null = null;
  let childPid: number | undefined;
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

    // ── (6) Observe: await the child's exit. ──────────────────────────────────
    const exit = await child.exit;
    exitCode = exit.code;

    // ── (7) Teardown exactly once: emit the guaranteed terminal + release. ────
    await teardownOnce(exitCode);

    const data: LifecycleResultData = {
      harness: resolution.target,
      runtimeId: resolution.runtimeId,
      worktreeId,
      worktreePath,
      childPid,
      exitCode,
    };
    return { success: true, data };
  } finally {
    // Guaranteed terminal-once even if a throw slipped between claim and observe.
    await teardownOnce(exitCode);
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

/** Resolve the supervisor create-time via the injected source; `''` when unprobed. */
function resolveHolderStartedAt(pid: number, source: ProcessSource): string {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' ? probe.startedAt : '';
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

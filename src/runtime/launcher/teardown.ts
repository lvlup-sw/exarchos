/**
 * Launcher teardown safety and crash recovery. {@link runLifecycle} accepts this module through its injectable `teardown` dependency.
 * On each catchable exit of a supervised launch, teardown does four steps in this order:
 *   1. It emits the `launch.executed` terminal through {@link emitLaunchExecuted}. A refused release thus still gets a terminal.
 *   2. It fails closed on a target that is not a git worktree, or on a configured `origin` that is unreachable.
 *   3. It holds a worktree that a live process occupies. The in-use probe ignores the parent-PID ancestry of the launcher.
 *   4. It releases the reservation through {@link WorktreeManager.release}, an event-only append that keeps uncommitted work.
 *
 * A worktree with no `origin` is a local-only launch, and step 2 passes it.
 * Teardown never runs `git reset --hard` on any path, because that command loses data.
 * {@link recoverCrashedLaunch} recovers a launcher that crashed during spawn.
 */

import { spawn } from 'node:child_process';
import type { EventStore } from '../../events/store.js';
import {
  WorktreeManager,
  defaultGitRunner,
  type GitRunner,
  type ReservationOwner,
  type ReleaseResult,
} from '../../verbs/worktree/manager.js';
import {
  probeWorktreeUsage,
  defaultProcessTableSource,
  type ProcessTableSource,
} from '../../verbs/worktree/pure/probe.js';
import {
  defaultRealpath,
  type RealpathResolver,
} from '../../verbs/worktree/pure/path-containment.js';
import { emitLaunchExecuted } from './liveness.js';
import {
  recoverPendingCreations,
  type RecoveredCreation,
} from './create-worktree.js';
import type {
  LifecycleTeardown,
  LifecycleTeardownContext,
} from './lifecycle-core.js';

/**
 * The closed set of unclean release outcomes. It is absent on a clean teardown.
 *   - `worktree-in-use` — a live process outside the launcher ancestry occupies the worktree, so its work can be live.
 *   - `release-rejected-foreign-owner` — the WLM refused the release, because a different live owner holds the reservation.
 */
export type TeardownRecoveryError =
  | 'worktree-in-use'
  | 'release-rejected-foreign-owner';

/**
 * The fail-closed reason when teardown cannot trust the git target. On either value, teardown releases nothing and runs no destructive git.
 *   - `non-git-target` — `git rev-parse` failed.
 *   - `origin-unreachable` — an `origin` remote is configured, but `git ls-remote` failed.
 */
export type TeardownOriginError =
  | 'non-git-target'
  | 'origin-unreachable';

/** The WLM release seam — defaults to a manager over the launch's event store. */
export type ReleaseFn = (
  worktreeId: string,
  owner?: ReservationOwner,
) => Promise<ReleaseResult>;

/**
 * The async origin-reachability probe. It resolves `true` only when the configured `origin` remote is reachable.
 * It is async because the sync {@link GitRunner} blocks the event loop for the network round-trip. That block stops signal handling and terminal emission.
 * Defaults to {@link defaultOriginReachable}.
 */
export type OriginReachableFn = (worktreePath: string) => Promise<boolean>;

/** The idempotent terminal emitter. It writes at most one terminal per launch. */
export type EmitExecutedFn = typeof emitLaunchExecuted;

/**
 * The launch context teardown operates over — the {@link LifecycleTeardownContext}
 * fields plus an optional emitter override for direct (non-lifecycle) callers.
 */
export interface TeardownContext {
  readonly eventStore: EventStore;
  /** Canonical `worktrees@v1` key of the launch worktree — the terminal correlator. */
  readonly worktreeId: string;
  /** On-disk path of the worktree the child ran in. */
  readonly worktreePath: string;
  /** Child exit code, or `null` when terminated by signal / not captured. */
  readonly exitCode: number | null;
  /** Idempotent terminal emitter. Defaults to {@link emitLaunchExecuted}. */
  readonly emitExecuted?: EmitExecutedFn;
}

/** Injectable dependencies for {@link teardownLaunch} / {@link makeLifecycleTeardown}. */
export interface TeardownDeps {
  /**
   * WLM release seam. Defaults to {@link WorktreeManager.release} over the
   * launch's event store — an event-only append (never `git reset --hard`).
   */
  readonly release?: ReleaseFn;
  /**
   * The launcher's reservation owner, passed to the release so a same-owner
   * relinquish is CLEAN. Omit to release without an owner (the WLM still refuses
   * to free a foreign live owner).
   */
  readonly owner?: ReservationOwner;
  /**
   * Ground-truth process table for the cwd-drift-aware in-use probe. Defaults to
   * the real {@link defaultProcessTableSource} (fail-closed off-Linux).
   */
  readonly processTableSource?: ProcessTableSource;
  /** Symlink-resolver for occupancy containment. Defaults to {@link defaultRealpath}. */
  readonly realpath?: RealpathResolver;
  /** Git runner for the non-git / origin safety gate. Defaults to {@link defaultGitRunner}. */
  readonly gitRunner?: GitRunner;
  /**
   * The async, non-blocking `git ls-remote origin` probe. Defaults to {@link defaultOriginReachable}.
   * Tests inject it to avoid a real network round-trip.
   */
  readonly originReachable?: OriginReachableFn;
  /**
   * The supervisor ("self") PID whose FULL parent-PID ancestry is excluded from
   * the occupant set (cwd-drift). Defaults to `process.pid`.
   */
  readonly selfPid?: number;
}

/** Structured outcome of a {@link teardownLaunch} pass. */
export interface TeardownOutcome {
  readonly worktreeId: string;
  readonly exitCode: number | null;
  /** True iff THIS teardown appended the terminal (false ⇒ a signal path already did). */
  readonly terminalAppended: boolean;
  /** True iff the reservation was cleanly released. */
  readonly released: boolean;
  /** The discriminator on an unclean release. It is absent on a clean teardown. */
  readonly recoveryError?: TeardownRecoveryError;
  /** Human-readable detail paired with {@link recoveryError} (triage only). */
  readonly recoveryErrorDetail?: string;
  /** The fail-closed reason when teardown cannot trust the git target. */
  readonly originError?: TeardownOriginError;
  /** Live, non-ancestry occupant PIDs when `recoveryError === 'worktree-in-use'`. */
  readonly occupantPids?: readonly number[];
}

/**
 * Run the teardown for one supervised launch, in the order that the module header gives.
 * The terminal comes first, and uncommitted work is never discarded.
 */
export async function teardownLaunch(
  ctx: TeardownContext,
  deps: TeardownDeps = {},
): Promise<TeardownOutcome> {
  const { eventStore, worktreeId, worktreePath, exitCode } = ctx;
  const emitExecuted = ctx.emitExecuted ?? emitLaunchExecuted;
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const realpath = deps.realpath ?? defaultRealpath;
  const processTableSource = deps.processTableSource ?? defaultProcessTableSource;
  const selfPid = deps.selfPid ?? process.pid;
  const release = deps.release ?? defaultRelease(eventStore, gitRunner, realpath);
  const originReachable = deps.originReachable ?? defaultOriginReachable;

  const terminal = await emitExecuted(eventStore, { worktreeId, exitCode });
  const base = { worktreeId, exitCode, terminalAppended: terminal.appended };

  const originError = await probeOriginSafety(gitRunner, worktreePath, originReachable);
  if (originError !== null) {
    return { ...base, released: false, originError };
  }

  const [usage] = probeWorktreeUsage(
    { worktreePaths: [worktreePath], selfPid },
    processTableSource,
    realpath,
  );
  if (usage !== undefined && usage.inUse) {
    return {
      ...base,
      released: false,
      recoveryError: 'worktree-in-use',
      recoveryErrorDetail:
        `worktree still occupied by live non-ancestry process(es) ` +
        `${usage.occupantPids.join(', ')}; work preserved (never reset --hard)`,
      occupantPids: usage.occupantPids,
    };
  }

  const result = await release(worktreeId, deps.owner);
  if (!result.released) {
    return {
      ...base,
      released: false,
      recoveryError: 'release-rejected-foreign-owner',
      recoveryErrorDetail:
        'WLM release refused: worktree reserved by a different live owner ' +
        '(INV-14 — work preserved, never reset --hard)',
    };
  }
  return { ...base, released: true };
}

/**
 * Adapt {@link teardownLaunch} to the {@link LifecycleTeardown} seam of {@link runLifecycle}. The lifecycle context supplies the terminal emitter.
 * The seam returns `Promise<void>`, so the structured outcome is discarded. Each effect lands on the injected substrate.
 */
export function makeLifecycleTeardown(deps: TeardownDeps = {}): LifecycleTeardown {
  return async (lifecycleCtx: LifecycleTeardownContext): Promise<void> => {
    await teardownLaunch(
      {
        eventStore: lifecycleCtx.eventStore,
        worktreeId: lifecycleCtx.worktreeId,
        worktreePath: lifecycleCtx.worktreePath,
        exitCode: lifecycleCtx.exitCode,
        emitExecuted: lifecycleCtx.emitExecuted,
      },
      deps,
    );
  };
}

/** Injectable dependencies for {@link recoverCrashedLaunch}. */
export interface RecoverCrashedLaunchDeps {
  /** WLM manager whose probe reclaims the dead-owner reservation. Defaults to a fresh one. */
  readonly manager?: WorktreeManager;
  /** Git runner for the create precheck. Defaults to {@link defaultGitRunner}. */
  readonly gitRunner?: GitRunner;
  /** Symlink-resolver for canonical keying. Defaults to {@link defaultRealpath}. */
  readonly realpath?: RealpathResolver;
  /** Supervisor PID whose ancestry is excluded from the reclaim probe. Defaults to `process.pid`. */
  readonly selfPid?: number;
}

/** Outcome of a {@link recoverCrashedLaunch} pass. */
export interface RecoverCrashedLaunchResult {
  /** The half-created worktrees that the create precheck finished. */
  readonly recoveredCreations: readonly RecoveredCreation[];
  /** `worktreeId`s whose dead-owner reservation was reclaimed (`worktree.released`). */
  readonly reclaimed: readonly string[];
  /** `worktreeId`s flagged `worktree.orphan_detected` (dead owner, still occupied). */
  readonly orphaned: readonly string[];
}

/**
 * Recover a launcher that crashed during spawn, so no half-created worktree escapes GC.
 *   1. {@link recoverPendingCreations} finishes each `worktree.create.requested` that has no paired `worktree.create.executed`.
 *   2. {@link WorktreeManager.probeAndReclaim} releases the reservations of dead owners. The supervisor ancestry is excluded.
 *
 * The launcher reserves before `git worktree add`, so a crash still leaves the worktree tracked in `worktrees@v1`.
 */
export async function recoverCrashedLaunch(
  eventStore: EventStore,
  repoRoot: string,
  deps: RecoverCrashedLaunchDeps = {},
): Promise<RecoverCrashedLaunchResult> {
  const gitRunner = deps.gitRunner ?? defaultGitRunner;
  const realpath = deps.realpath ?? defaultRealpath;
  const manager =
    deps.manager ?? new WorktreeManager({ eventStore, gitRunner, realpath });
  const selfPid = deps.selfPid ?? process.pid;

  const recoveredCreations = await recoverPendingCreations(eventStore, repoRoot, {
    gitRunner,
    realpath,
  });
  const { released, orphaned } = await manager.probeAndReclaim(selfPid);
  return { recoveredCreations, reclaimed: released, orphaned };
}

/**
 * Return the fail-closed verdict for the git target, or `null` when the target is trustworthy.
 *   - `git rev-parse --is-inside-work-tree` fails: `non-git-target`.
 *   - `origin` is configured, but `originReachable` resolves `false`: `origin-unreachable`.
 *   - No `origin` is configured: a local-only launch, so `null`.
 *
 * The two local git reads use the sync runner. The network check uses the async probe, so the event loop does not block.
 */
async function probeOriginSafety(
  gitRunner: GitRunner,
  worktreePath: string,
  originReachable: OriginReachableFn,
): Promise<TeardownOriginError | null> {
  if (gitRunner.run(['rev-parse', '--is-inside-work-tree'], worktreePath).status !== 0) {
    return 'non-git-target';
  }
  const originConfigured =
    gitRunner.run(['remote', 'get-url', 'origin'], worktreePath).status === 0;
  if (!originConfigured) {
    return null;
  }
  if (!(await originReachable(worktreePath))) {
    return 'origin-unreachable';
  }
  return null;
}

/**
 * The bound in ms for the origin-reachability round-trip on teardown.
 * Against a hung remote, `git ls-remote` can never emit `close`, and `teardownLaunch` awaits the probe on the shutdown path.
 * On expiry the probe is killed, and the verdict fails closed as `origin-unreachable`.
 */
export const ORIGIN_PROBE_TIMEOUT_MS = 5_000;

/** Injected seams for {@link defaultOriginReachable}. Tests use them to drive the timeout path without a hung remote. */
export interface OriginReachableDeps {
  readonly spawnFn?: typeof spawn;
  readonly timeoutMs?: number;
}

/**
 * The default origin-reachability probe. It spawns `git ls-remote origin` and does not block the event loop.
 * It resolves `true` only when git exits 0. A non-zero exit, a spawn error, or a timeout resolves `false`, so teardown fails closed.
 * The first outcome wins, and the timer does not keep the event loop alive.
 * `git` is a real binary, not a win32 `.cmd` shim, so a bare `spawn` is portable and free of shell injection.
 */
export function defaultOriginReachable(
  worktreePath: string,
  deps: OriginReachableDeps = {},
): Promise<boolean> {
  const spawnFn = deps.spawnFn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? ORIGIN_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    const child = spawnFn('git', ['ls-remote', 'origin'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    let settled = false;
    const finish = (reachable: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reachable);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(false);
    }, timeoutMs);
    timer.unref?.();
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * The default release seam: {@link WorktreeManager.release} over the launch's
 * event store. Event-only (no git side-effect), so uncommitted work is preserved.
 */
function defaultRelease(
  eventStore: EventStore,
  gitRunner: GitRunner,
  realpath: RealpathResolver,
): ReleaseFn {
  const manager = new WorktreeManager({ eventStore, gitRunner, realpath });
  return (worktreeId, owner) => manager.release(worktreeId, owner);
}

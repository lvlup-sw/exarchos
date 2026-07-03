/**
 * Launcher teardown safety + recovery edges (DR-6).
 *
 * This is the self-contained teardown seam {@link runLifecycle} already accepts
 * via its injectable `teardown` dependency. It composes shipped substrate — it
 * reshapes NOTHING in `lifecycle-core.ts` — to guarantee the DR-6 teardown-safety
 * and recovery contract on every catchable exit of a supervised launch:
 *
 *   1. **Guaranteed terminal (every catchable path).** The FIRST thing teardown
 *      does is route the `launch.executed` terminal through the idempotent
 *      Task-006 {@link emitLaunchExecuted} seam. It runs BEFORE any safety gate,
 *      so the terminal is emitted even when the release is later refused, and it
 *      is at-most-once even when a signal path (Task 011) already fired it — the
 *      seam's `appended` flag surfaces which call actually wrote the row.
 *   2. **Fail-closed on a non-git target / unreachable origin.** Before reclaiming
 *      anything, teardown proves the target is a real git worktree and — when an
 *      `origin` remote IS configured — that it is reachable. The reachability
 *      check is the one NETWORK round-trip, so it runs through the async,
 *      NON-BLOCKING {@link OriginReachableFn} seam (never a blocking `spawnSync`
 *      that would freeze the teardown event loop). A non-git target or a
 *      configured-but-unreachable origin fail CLOSED with a structured
 *      {@link TeardownOriginError}: no release, no destructive git. A worktree
 *      with no origin at all is a local-only launch and is NOT a fail-closed case.
 *   3. **cwd-drift-aware in-use probe (#1577 protected-ancestry).** Whether the
 *      worktree is still occupied is decided by {@link probeWorktreeUsage}, which
 *      subtracts the launcher's OWN full parent-PID ancestry from the occupant
 *      set. So the supervisor's own cwd drifting into the worktree never marks it
 *      in-use — teardown does not refuse to release over its own cwd. A live
 *      NON-ancestry occupant DOES hold the worktree (its work may be live), which
 *      surfaces as `recoveryError: 'worktree-in-use'` — never a destructive reset.
 *   4. **Release, never `git reset --hard`.** The reservation is relinquished
 *      through the shipped WLM {@link WorktreeManager.release} — an event-only
 *      append, so uncommitted work on disk is always preserved. An unclean release
 *      (the WLM refuses because a different live owner holds it) reuses the WLM
 *      release discriminator ({@link ReleaseResult}) and surfaces as
 *      `recoveryError: 'release-rejected-foreign-owner'` (INV-14): the indeterminate
 *      outcome is reported, never papered over with a `reset --hard`.
 *
 * Teardown NEVER shells `git reset --hard` on ANY path — that is the data-loss
 * footgun (Claude Code #55724) this slice exists to eliminate.
 *
 * ## Crash-mid-spawn recovery (DR-2 precheck reuse)
 *
 * {@link recoverCrashedLaunch} closes the "crash after `worktree.create.requested`
 * before/after spawn" hole: it finishes any half-created worktree via the shipped
 * DR-2 precheck ({@link recoverPendingCreations}) so the INV-13 create pair is 1:1
 * and the worktree is fully tracked, then reclaims the crashed launcher's now-dead
 * reservation via the ground-truth {@link WorktreeManager.probeAndReclaim} probe.
 * Because the launcher RESERVES before `git worktree add`, even a crash leaves the
 * worktree tracked in `worktrees@v1` — so no orphaned half-created worktree ever
 * escapes GC. The reclaim is event-only; it too never `reset --hard`s.
 */

import { spawn } from 'node:child_process';
import type { EventStore } from '../event-store/store.js';
import {
  WorktreeManager,
  defaultGitRunner,
  type GitRunner,
  type ReservationOwner,
  type ReleaseResult,
} from '../orchestrate/worktree/manager.js';
import {
  probeWorktreeUsage,
  defaultProcessTableSource,
  type ProcessTableSource,
} from '../orchestrate/worktree/pure/probe.js';
import {
  defaultRealpath,
  type RealpathResolver,
} from '../orchestrate/worktree/pure/path-containment.js';
import { emitLaunchExecuted } from './liveness.js';
import {
  recoverPendingCreations,
  type RecoveredCreation,
} from './create-worktree.js';
// Type-only import (erased at runtime — no runtime edge back into the core the
// task forbids reshaping): the injectable-seam shapes teardown conforms to.
import type {
  LifecycleTeardown,
  LifecycleTeardownContext,
} from './lifecycle-core.js';

// ============================================================
// Discriminators
// ============================================================

/**
 * INV-14 discriminator on an UNCLEAN teardown release — the closed set of
 * indeterminate outcomes that could NOT be cleanly relinquished. Absent on a
 * clean teardown. Mirrors the merge-orchestrator's `recoveryError` shape (a
 * closed enum a consumer branches on without parsing prose), reusing the WLM
 * release verdict rather than reinventing a recovery ladder.
 */
export type TeardownRecoveryError =
  /** A live, non-ancestry process still occupies the worktree — work may be live. */
  | 'worktree-in-use'
  /** The WLM refused the release: the worktree is reserved by a different live owner. */
  | 'release-rejected-foreign-owner';

/**
 * Structured fail-closed reason when teardown cannot trust the git target. On
 * either value teardown reclaims NOTHING and runs no destructive git.
 */
export type TeardownOriginError =
  /** The target is not a git worktree (`git rev-parse` failed). */
  | 'non-git-target'
  /** An `origin` remote is configured but unreachable (`git ls-remote` failed). */
  | 'origin-unreachable';

// ============================================================
// Seams
// ============================================================

/** The WLM release seam — defaults to a manager over the launch's event store. */
export type ReleaseFn = (
  worktreeId: string,
  owner?: ReservationOwner,
) => Promise<ReleaseResult>;

/**
 * The async origin-reachability probe seam (DR-6). Resolves `true` iff the
 * configured `origin` remote is reachable. It is deliberately ASYNC — the sync
 * {@link GitRunner} would run the `git ls-remote origin` NETWORK round-trip on a
 * blocking `spawnSync`, freezing the launcher's event loop (its signal handling
 * and terminal emission) for the whole network latency. An async spawn lets
 * teardown `await` the reachability check while the event loop stays live. Any
 * non-zero exit / spawn error resolves `false` → fail-closed as
 * `origin-unreachable`. Defaults to {@link defaultOriginReachable}.
 */
export type OriginReachableFn = (worktreePath: string) => Promise<boolean>;

/** The idempotent Task-006 terminal emitter (guaranteed at-most-once). */
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
  /** Idempotent Task-006 terminal emitter; defaults to {@link emitLaunchExecuted}. */
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
   * ASYNC origin-reachability probe (DR-6) — the NON-BLOCKING `git ls-remote
   * origin` check. Defaults to {@link defaultOriginReachable}; injected so tests
   * drive reachability deterministically without a real network round-trip.
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
  /** INV-14 discriminator on an unclean release; absent on a clean teardown. */
  readonly recoveryError?: TeardownRecoveryError;
  /** Human-readable detail paired with {@link recoveryError} (triage only). */
  readonly recoveryErrorDetail?: string;
  /** Structured fail-closed reason when the git target could not be trusted. */
  readonly originError?: TeardownOriginError;
  /** Live, non-ancestry occupant PIDs when `recoveryError === 'worktree-in-use'`. */
  readonly occupantPids?: readonly number[];
}

// ============================================================
// Teardown core
// ============================================================

/**
 * Run the guaranteed teardown for one supervised launch: emit the `launch.executed`
 * terminal (always, first), then — fail-closed — reclaim the reservation without
 * ever discarding uncommitted work. See the module header for the DR-6 contract.
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

  // ── (1) Guaranteed terminal — FIRST, on every catchable path, idempotent. ──
  const terminal = await emitExecuted(eventStore, { worktreeId, exitCode });
  const base = { worktreeId, exitCode, terminalAppended: terminal.appended };

  // ── (2) Fail-closed safety gate: non-git target / unreachable origin. The
  //     origin-reachability probe is AWAITED through the async, NON-BLOCKING
  //     seam so the network round-trip never freezes the teardown event loop. ──
  const originError = await probeOriginSafety(gitRunner, worktreePath, originReachable);
  if (originError !== null) {
    return { ...base, released: false, originError };
  }

  // ── (3) cwd-drift-aware in-use probe (#1577 protected-ancestry subtraction). ──
  const [usage] = probeWorktreeUsage(
    { worktreePaths: [worktreePath], selfPid },
    processTableSource,
    realpath,
  );
  if (usage !== undefined && usage.inUse) {
    // A live non-ancestry process holds the worktree — its work may be live.
    // Hold it (never reset --hard); surface the indeterminate outcome.
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

  // ── (4) Release the reservation (event-only). Unclean ⇒ recoveryError. ──
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
 * Adapt {@link teardownLaunch} to the {@link LifecycleTeardown} seam
 * {@link runLifecycle} injects. The lifecycle context supplies the idempotent
 * terminal emitter; the structured outcome is intentionally discarded (the seam
 * is `Promise<void>`) — every observable effect (terminal, release, safety gate)
 * is a side effect on the injected substrate.
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

// ============================================================
// Crash-mid-spawn recovery
// ============================================================

/** Injectable dependencies for {@link recoverCrashedLaunch}. */
export interface RecoverCrashedLaunchDeps {
  /** WLM manager whose probe reclaims the dead-owner reservation. Defaults to a fresh one. */
  readonly manager?: WorktreeManager;
  /** Git runner for the DR-2 create precheck. Defaults to {@link defaultGitRunner}. */
  readonly gitRunner?: GitRunner;
  /** Symlink-resolver for canonical keying. Defaults to {@link defaultRealpath}. */
  readonly realpath?: RealpathResolver;
  /** Supervisor PID whose ancestry is excluded from the reclaim probe. Defaults to `process.pid`. */
  readonly selfPid?: number;
}

/** Outcome of a {@link recoverCrashedLaunch} pass. */
export interface RecoverCrashedLaunchResult {
  /** Half-created worktrees finished by the DR-2 precheck (create pair now 1:1). */
  readonly recoveredCreations: readonly RecoveredCreation[];
  /** `worktreeId`s whose dead-owner reservation was reclaimed (`worktree.released`). */
  readonly reclaimed: readonly string[];
  /** `worktreeId`s flagged `worktree.orphan_detected` (dead owner, still occupied). */
  readonly orphaned: readonly string[];
}

/**
 * Recover a crash mid-spawn so no orphaned half-created worktree escapes GC.
 *
 * Two composed, shipped, event-only steps (neither `git reset --hard`s):
 *   1. {@link recoverPendingCreations} — the DR-2 precheck: finish any
 *      `worktree.create.requested` with no paired `worktree.create.executed`, so
 *      the INV-13 create pair is 1:1 and the worktree is fully tracked on disk.
 *   2. {@link WorktreeManager.probeAndReclaim} — the #1577 ground-truth probe:
 *      release the crashed launcher's now-provably-dead reservation (owner PID
 *      gone), cwd-drift aware (the supervisor's own ancestry is excluded). The
 *      released worktree becomes a GC candidate.
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

// ============================================================
// Internal helpers
// ============================================================

/**
 * The fail-closed git-target safety verdict, or `null` when the target is a
 * trustworthy git worktree (reachable origin OR no origin configured at all —
 * a local-only launch). The two LOCAL, fast git reads (`rev-parse`,
 * `remote get-url`) go through the sync runner; the origin-reachability check is
 * the one NETWORK round-trip, so it is awaited through the async, non-blocking
 * {@link OriginReachableFn} seam — never a blocking `spawnSync` on the teardown
 * event loop (DR-6):
 *
 *   - `git rev-parse --is-inside-work-tree` non-zero ⇒ `'non-git-target'`.
 *   - `origin` configured (`git remote get-url origin` zero) BUT unreachable
 *     (async `originReachable` resolves `false`) ⇒ `'origin-unreachable'`.
 *   - no `origin` configured ⇒ local-only ⇒ trustworthy (`null`), never a
 *     fail-closed (mirrors the WLM `no-upstream → mutable` verdict).
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
    return null; // local-only launch — nothing external to be stale against.
  }
  if (!(await originReachable(worktreePath))) {
    return 'origin-unreachable';
  }
  return null;
}

/**
 * Default async origin-reachability probe: spawn `git ls-remote origin` WITHOUT
 * blocking the event loop (DR-6). Resolves `true` iff git exits 0 (origin
 * reachable); any non-zero exit OR spawn error (git missing, bad cwd) resolves
 * `false`, so the teardown fails CLOSED as `origin-unreachable` rather than
 * proceeding on an unverifiable origin. `git` is a real binary (never a win32
 * `.cmd` shim), so a bare `spawn` is portable and shell-injection-free.
 */
function defaultOriginReachable(worktreePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['ls-remote', 'origin'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
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

/**
 * Phantom-launch reconciler for uncatchable death (DR-6).
 *
 * The launcher brackets a spawned child with a CLAIM (`launch.executing_started`)
 * and a guaranteed-terminal (`launch.executed`) on the singleton `worktrees`
 * stream (see `liveness.ts`). Every *catchable* exit — normal return, caught
 * signal, teardown — funnels through {@link emitLaunchExecuted}, so the terminal
 * clears the reducer's in-flight marker and no phantom survives.
 *
 * `SIGKILL` and host death are NOT catchable: the launcher/supervisor process
 * dies WITHOUT running any teardown, so the terminal is never written and the
 * launch folds as a PERMANENT in-flight phantom that `ps` would show forever.
 * This module is the heal for that hole — the on-demand ground-truth counterpart
 * of the reservation reconciler ({@link WorktreeManager.probeAndReclaim}), but
 * for the `launch.*` family:
 *
 *   1. Fold the `worktrees@v1` projection and select every in-flight launch
 *      (an entry carrying a `launch` marker — a `launch.executing_started` with
 *      no paired `launch.executed`).
 *   2. Probe each launch's SUPERVISOR-holder liveness against the real process
 *      table via the shipped protected-ancestry probe ({@link probeLaunchHolders}).
 *      The `holderPid` is the launcher/supervisor PID responsible for writing the
 *      terminal — a dead holder means the terminal will NEVER be written on its
 *      own, which is precisely the reconcile trigger.
 *   3. For each provably-dead holder, emit the terminal through the SAME
 *      idempotent {@link emitLaunchExecuted} seam a catchable exit uses, with
 *      `exitCode: null` (an uncaptured / signalled exit). The reducer clears the
 *      in-flight marker, so `ps` never again folds that permanent phantom.
 *
 * A live or unprovable (`'unknown'`) holder is LEFT in-flight — the reconciler
 * never reclaims what it cannot prove gone (off-Linux the table is unsupported,
 * so every holder reads `'unknown'` and nothing is reconciled: fail closed).
 *
 * ## On-demand only — no polling (INV-10/15)
 *
 * Reconciliation runs ONLY when invoked (by the GC pass or `ps --probe`). It
 * registers NO `setInterval`, `setTimeout`, daemon, or background loop — every
 * step is a single pure fold + a point-in-time process-table read. Idempotent
 * across runs: once the terminal is emitted the launch is no longer in-flight, so
 * a re-probe finds nothing to reconcile (and the terminal seam itself
 * short-circuits on an existing terminal).
 */

import type { EventStore } from '../events/store.js';
import { emitLaunchExecuted } from './liveness.js';
import { WORKTREES_STREAM, WORKTREES_REDUCER } from '../orchestrate/worktree/manager.js';
import type { WorktreesProjection } from '../orchestrate/worktree/projections/worktrees.js';
import {
  probeLaunchHolders,
  defaultProcessTableSource,
  type ProcessTableSource,
  type LaunchHolder,
} from '../orchestrate/worktree/pure/probe.js';

/** Outcome of a {@link reconcileLaunches} pass (DR-6). */
export interface ReconcileLaunchesResult {
  /**
   * The `worktreeId`s whose in-flight launch was reconciled to a
   * `launch.executed` terminal this pass (holder provably dead). Empty when no
   * phantom needed healing.
   */
  readonly reconciled: readonly string[];
  /**
   * The `worktreeId`s left in-flight — the holder is live, its liveness is
   * unprovable (`'unknown'` / uncaptured / unsupported table), OR its terminal
   * append failed this pass (isolated so it does not sink the others; a later
   * pass retries it). Fail closed: a live supervisor's launch is never reconciled
   * away.
   */
  readonly leftInFlight: readonly string[];
  /** Total in-flight launches probed this pass. */
  readonly probed: number;
}

/**
 * Reconcile every phantom in-flight launch whose supervisor holder is provably
 * dead to a `launch.executed` terminal (DR-6). On-demand only — see the module
 * header. `source` is injected so the pass is testable with a fake process table
 * and zero OS access; it defaults to the real {@link defaultProcessTableSource}
 * (`/proc` on Linux; off-Linux `isSupported() === false` so every holder reads
 * `'unknown'` and NOTHING is reconciled — fail closed).
 */
export async function reconcileLaunches(
  eventStore: EventStore,
  source: ProcessTableSource = defaultProcessTableSource,
): Promise<ReconcileLaunchesResult> {
  const projection = await loadWorktreesProjection(eventStore);
  // In-flight launches are exactly the entries carrying a `launch` marker
  // (`launch.executing_started` with no paired `launch.executed`) — mirrors the
  // read-only `WorktreeManager.listInFlightLaunches` fold, kept independent so
  // this module holds no manager instance.
  const launches = Object.values(projection.worktrees).filter(
    (entry) => entry.launch !== undefined,
  );
  const holders: LaunchHolder[] = launches.map((entry) => ({
    worktreeId: entry.worktreeId,
    holderPid: entry.launch?.holderPid ?? null,
    holderStartedAt: entry.launch?.holderStartedAt ?? null,
  }));
  const findings = probeLaunchHolders(holders, source);

  const reconciled: string[] = [];
  const leftInFlight: string[] = [];
  for (const finding of findings) {
    if (!finding.reconcilable) {
      leftInFlight.push(finding.worktreeId);
      continue;
    }
    // Supervisor provably dead → the terminal will never be written by the
    // launcher; write it through the idempotent seam so the reducer clears the
    // phantom in-flight marker. `null` exitCode = uncaptured / signalled death.
    //
    // Isolate per-finding failure: a single append that retries out (e.g.
    // `withStateRetry` exhausted) must NOT sink the whole pass. Earlier terminals
    // already written stay reconciled, every later finding is still processed, and
    // the failed `worktreeId` is reported as left-in-flight so a subsequent
    // on-demand pass retries it (the terminal seam is idempotent, so a retry is
    // safe). Kept SEQUENTIAL — not `Promise.allSettled` — because every append
    // lands on the singleton `worktrees` stream, whose in-process
    // StreamLockManager already serializes same-stream appends (INV-7); running
    // them concurrently buys no parallelism and only obscures ordering.
    try {
      await emitLaunchExecuted(eventStore, {
        worktreeId: finding.worktreeId,
        exitCode: null,
      });
      reconciled.push(finding.worktreeId);
    } catch {
      leftInFlight.push(finding.worktreeId);
    }
  }
  return { reconciled, leftInFlight, probed: launches.length };
}

/** Read-only fold of the `worktrees` stream through `worktrees@v1`. */
async function loadWorktreesProjection(
  eventStore: EventStore,
): Promise<WorktreesProjection> {
  const { aggregate } = await eventStore
    .getAppender()
    .aggregateStream<WorktreesProjection>(WORKTREES_STREAM, WORKTREES_REDUCER);
  return aggregate;
}

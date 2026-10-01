/**
 * Reconciles phantom launches after an uncatchable death.
 *
 * The launcher brackets a spawned child with `launch.executing_started` and `launch.executed` on the
 * `worktrees` stream (see `liveness.ts`). Each catchable exit writes the terminal through
 * {@link emitLaunchExecuted}. `SIGKILL` and host death skip teardown, so the launch stays in flight
 * forever. This module heals that case for the `launch.*` family, as
 * {@link WorktreeManager.probeAndReclaim} does for reservations.
 *
 * It probes the supervisor of each in-flight launch against the process table. For each supervisor that
 * is provably dead, it writes the terminal with `exitCode: null` (an uncaptured or signalled exit). A live
 * or unprovable (`'unknown'`) supervisor stays in flight. The pass runs only on demand, from
 * `reconcile_worktrees`, and starts no timer or background loop.
 */

import type { EventStore } from '../../events/store.js';
import { emitLaunchExecuted } from './liveness.js';
import { WORKTREES_STREAM, WORKTREES_REDUCER } from '../../verbs/worktree/manager.js';
import type { WorktreesProjection } from '../../verbs/worktree/projections/worktrees.js';
import {
  probeLaunchHolders,
  defaultProcessTableSource,
  type ProcessTableSource,
  type LaunchHolder,
} from '../../verbs/worktree/pure/probe.js';

/** Outcome of a {@link reconcileLaunches} pass. */
export interface ReconcileLaunchesResult {
  /** The `worktreeId`s that got a `launch.executed` terminal in this pass, because the holder is provably dead. */
  readonly reconciled: readonly string[];
  /**
   * The `worktreeId`s left in flight: the holder is live or unprovable, or the terminal append failed in
   * this pass. A later pass retries a failed append.
   */
  readonly leftInFlight: readonly string[];
  /** Total in-flight launches probed this pass. */
  readonly probed: number;
}

/**
 * Writes a `launch.executed` terminal for each in-flight launch whose supervisor is provably dead.
 * `source` defaults to {@link defaultProcessTableSource}, and tests inject a fake process table. On a
 * platform with no process table, each holder reads `'unknown'` and nothing changes.
 *
 * A failed append puts its `worktreeId` in `leftInFlight` and does not stop the pass. The terminal seam
 * is idempotent, so a later retry is safe. The appends run in sequence, because the lock on the one
 * `worktrees` stream serializes them.
 *
 * The in-flight filter repeats the `WorktreeManager.listInFlightLaunches` fold, so this module holds no
 * manager instance.
 */
export async function reconcileLaunches(
  eventStore: EventStore,
  source: ProcessTableSource = defaultProcessTableSource,
): Promise<ReconcileLaunchesResult> {
  const projection = await loadWorktreesProjection(eventStore);
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

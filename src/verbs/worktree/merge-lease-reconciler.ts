/**
 * Reconciler for the merge leases of the retired `serialize_merge` action.
 * Old logs can hold a `worktree.merge_requested` claim with no `worktree.merge_executed` release, after a crash between the two.
 * The lease lives only in the event log, folded by `worktrees@v1` into `inFlightMerges`.
 * {@link reconcileMerges} releases each lease whose holder is provably dead. It never runs a merge.
 *
 * It uses the stream and reducer ids of `manager.ts`, and the side-effect import of `./projections/index.js` registers the reducer.
 */

import type { AtomicAppender } from '../../events/atomic-appender.js';
import type { EventStore } from '../../events/store.js';
import { WORKTREES_STREAM, WORKTREES_REDUCER } from './manager.js';
import './projections/index.js';
import type {
  WorktreesProjection,
  InFlightMerge,
} from './projections/worktrees.js';
import {
  probeReservations,
  defaultProcessTableSource,
  type ProcessTableSource,
} from './pure/probe.js';

/**
 * Whether the lease holder is provably dead, through the same {@link probeReservations} probe that the manager uses for reservations.
 * Provably dead means that the PID is absent from a supported process table, or that its create-time differs.
 * It returns `false` for a holder with a null PID or create-time, and for an unsupported process table, so a live lease is never taken.
 */
function isHolderProvablyDead(
  holder: InFlightMerge,
  source: ProcessTableSource,
): boolean {
  if (holder.holderPid === null || holder.holderStartedAt === null) {
    return false;
  }
  const [finding] = probeReservations(
    [
      {
        worktreePath: holder.integrationRef,
        ownerPid: holder.holderPid,
        ownerStartedAt: holder.holderStartedAt,
      },
    ],
    source,
  );
  return finding?.releasable === true;
}

/**
 * Appends the terminal `worktree.merge_executed`, keyed by `<eventType>:<operationId>` and with no sequence pin.
 * A sequence pin to the claim makes every retry fail, because other worktree events move the stream between claim and release.
 * A reclaim uses the original holder `operationId`, so two racing reclaimers make one release.
 * The payload has no `sourceBranch`, because the reducer matches the claim by `integrationRef` and `operationId`.
 */
async function appendMergeExecuted(
  appender: AtomicAppender,
  merge: { integrationRef: string; operationId: string; worktreeId?: string | null },
  outcome: { status: 'aborted'; recoveryError: string },
): Promise<void> {
  await appender.append(
    WORKTREES_STREAM,
    [
      {
        type: 'worktree.merge_executed',
        data: {
          integrationRef: merge.integrationRef,
          operationId: merge.operationId,
          status: outcome.status,
          recoveryError: outcome.recoveryError,
          ...(merge.worktreeId != null ? { worktreeId: merge.worktreeId } : {}),
        },
      },
    ],
    `worktree.merge_executed:${merge.operationId}`,
  );
}

/** Outcome of a {@link reconcileMerges} pass. */
export interface ReconcileMergesResult {
  /** The refs whose lease this pass released, because the holder is provably dead. */
  readonly reconciled: readonly string[];
  /**
   * The refs left in flight: the holder is live, its liveness is unprovable, or its terminal append failed.
   * A failed append does not stop the pass, and a later pass tries it again.
   */
  readonly leftInFlight: readonly string[];
  /** Total in-flight merge leases probed this pass. */
  readonly probed: number;
}

/**
 * Releases every in-flight merge lease whose holder is provably dead, after a crash between claim and release.
 * The `reconcile_worktrees` action calls it.
 *
 * It appends the terminal event under the original holder `operationId`, so two racing passes make one release.
 * It never runs the merge again, because the lease has no `featureId` or `strategy`.
 * The appends run in sequence, because they all go to the singleton `worktrees` stream.
 * On an unsupported process table, every holder reads `'unknown'` and nothing is released.
 */
export async function reconcileMerges(
  eventStore: EventStore,
  source: ProcessTableSource = defaultProcessTableSource,
): Promise<ReconcileMergesResult> {
  const appender = eventStore.getAppender();
  const { aggregate } = await appender.aggregateStream<WorktreesProjection>(
    WORKTREES_STREAM,
    WORKTREES_REDUCER,
  );
  const merges = Object.values(aggregate.inFlightMerges);

  const reconciled: string[] = [];
  const leftInFlight: string[] = [];
  for (const holder of merges) {
    if (!isHolderProvablyDead(holder, source)) {
      leftInFlight.push(holder.integrationRef);
      continue;
    }
    try {
      await appendMergeExecuted(
        appender,
        {
          integrationRef: holder.integrationRef,
          operationId: holder.operationId,
          worktreeId: holder.worktreeId,
        },
        { status: 'aborted', recoveryError: 'dead-holder-reclaimed' },
      );
      reconciled.push(holder.integrationRef);
    } catch {
      leftInFlight.push(holder.integrationRef);
    }
  }
  return { reconciled, leftInFlight, probed: merges.length };
}

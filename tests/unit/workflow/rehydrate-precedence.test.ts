import { describe, it, expect } from 'vitest';

import {
  REHYDRATION_SOURCE_PRECEDENCE,
  rehydrationSourceRank,
  planRehydrationSource,
  type RehydrationSource,
} from '../../../src/workflow/rehydrate-precedence.js';

/**
 * P04-06 (EFF-004) — deterministic fallback precedence for rehydration.
 *
 * These unit tests pin the DECLARED precedence value and the pure decision that
 * maps a snapshot's position relative to the durable event tail onto a source.
 * The load-bearing invariant under test: a projection that contradicts the
 * durable log (`projection-ahead`) is never trusted — it degrades to an
 * authoritative event fold, flagged degraded.
 */
describe('REHYDRATION_SOURCE_PRECEDENCE (P04-06, EFF-004)', () => {
  it('Precedence_IsDeclaredTotalOrdering_HighestAuthorityFirst', () => {
    // The precedence is a declared, testable value — not implicit control flow.
    expect(REHYDRATION_SOURCE_PRECEDENCE).toEqual([
      'event-fold',
      'summary-snapshot',
      'state-store',
    ]);
  });

  it('Precedence_HasNoStaleProjectionSlot', () => {
    // The whole point: there is no precedence slot that silently trusts a stale
    // or contradictory projection.
    expect(REHYDRATION_SOURCE_PRECEDENCE).not.toContain('stale-projection');
    expect(REHYDRATION_SOURCE_PRECEDENCE).not.toContain('projection');
  });

  it('SourceRank_OrdersEventFoldAboveSnapshotAboveStateStore', () => {
    expect(rehydrationSourceRank('event-fold')).toBeLessThan(
      rehydrationSourceRank('summary-snapshot'),
    );
    expect(rehydrationSourceRank('summary-snapshot')).toBeLessThan(
      rehydrationSourceRank('state-store'),
    );
  });

  it('SourceRank_MatchesArrayIndexForEverySource', () => {
    for (const source of REHYDRATION_SOURCE_PRECEDENCE) {
      expect(rehydrationSourceRank(source as RehydrationSource)).toBe(
        REHYDRATION_SOURCE_PRECEDENCE.indexOf(source),
      );
    }
  });
});

describe('planRehydrationSource (P04-06, EFF-004)', () => {
  it('NoSnapshot_FoldsWholeStreamFromEventLog', () => {
    const plan = planRehydrationSource({
      hasSnapshot: false,
      snapshotCursor: 0,
      eventTail: 7,
    });
    expect(plan.source).toBe('event-fold');
    expect(plan.seedFromSnapshot).toBe(false);
    expect(plan.sinceSequence).toBe(0);
    expect(plan.degraded).toBe(false);
    expect(plan.freshness).toBeUndefined();
  });

  it('SnapshotOnTail_ServesExplicitSummarySnapshot', () => {
    const plan = planRehydrationSource({
      hasSnapshot: true,
      snapshotCursor: 5,
      eventTail: 5,
    });
    expect(plan.source).toBe('summary-snapshot');
    expect(plan.seedFromSnapshot).toBe(true);
    expect(plan.sinceSequence).toBe(5);
    expect(plan.degraded).toBe(false);
  });

  it('SnapshotBehindTail_SeedsSnapshotAndFoldsForward_NotDegraded', () => {
    // A lagging snapshot is not trusted as-is: the tail is folded forward over
    // it. The answer is event-derived and NOT degraded (it reaches the tail).
    const plan = planRehydrationSource({
      hasSnapshot: true,
      snapshotCursor: 5,
      eventTail: 8,
    });
    expect(plan.source).toBe('event-fold');
    expect(plan.seedFromSnapshot).toBe(true);
    expect(plan.sinceSequence).toBe(5);
    expect(plan.degraded).toBe(false);
  });

  it('SnapshotAheadOfTail_DiscardsSnapshotAndReplays_FlaggedDegraded', () => {
    // The contradiction case (projection-ahead): the snapshot claims events past
    // the durable tail. It must be discarded, the log re-folded from 0, and the
    // result flagged degraded — this is the exit-proof invariant.
    const plan = planRehydrationSource({
      hasSnapshot: true,
      snapshotCursor: 10,
      eventTail: 2,
      viewName: 'rehydration@v1',
    });
    expect(plan.source).toBe('event-fold');
    expect(plan.seedFromSnapshot).toBe(false);
    expect(plan.sinceSequence).toBe(0);
    expect(plan.degraded).toBe(true);
    expect(plan.freshness).toBeDefined();
    expect(plan.freshness?.reason).toBe('projection-ahead');
    expect(plan.freshness?.eventTail).toBe(2);
    expect(plan.freshness?.projectionCursor).toBe(10);
    expect(plan.freshness?.staleViews).toEqual(['rehydration@v1']);
  });

  it('SnapshotAheadOfTail_EvenWhenEventsFullyPruned_StillDegrades', () => {
    // Orphan snapshot over a fully-pruned stream (eventTail 0). Still ahead —
    // discard and replay from the (now empty) log rather than trust the ghost.
    const plan = planRehydrationSource({
      hasSnapshot: true,
      snapshotCursor: 4,
      eventTail: 0,
    });
    expect(plan.seedFromSnapshot).toBe(false);
    expect(plan.sinceSequence).toBe(0);
    expect(plan.degraded).toBe(true);
    expect(plan.freshness?.reason).toBe('projection-ahead');
  });

  it('TailUnknown_PreservesWarmCacheBehaviour_NoFabricatedDegradation', () => {
    // Backend cannot answer MAX(sequence): we cannot prove a contradiction, so
    // fall back to the historical seed-from-snapshot behaviour without inventing
    // a degradation signal.
    const plan = planRehydrationSource({
      hasSnapshot: true,
      snapshotCursor: 3,
      eventTail: undefined,
    });
    expect(plan.source).toBe('summary-snapshot');
    expect(plan.seedFromSnapshot).toBe(true);
    expect(plan.sinceSequence).toBe(3);
    expect(plan.degraded).toBe(false);
    expect(plan.freshness).toBeUndefined();
  });
});

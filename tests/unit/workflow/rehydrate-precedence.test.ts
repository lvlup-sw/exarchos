import { describe, it, expect } from 'vitest';

import {
  REHYDRATION_SOURCE_PRECEDENCE,
  rehydrationSourceRank,
  planRehydrationSource,
  type RehydrationSource,
} from '../../../src/workflow/rehydrate-precedence.js';

/**
 * Pins the declared precedence of rehydration sources.
 * The suites below also pin how the position of a snapshot against the durable event tail selects a source.
 */
describe('REHYDRATION_SOURCE_PRECEDENCE (P04-06, EFF-004)', () => {
  it('Precedence_IsDeclaredTotalOrdering_HighestAuthorityFirst', () => {
    expect(REHYDRATION_SOURCE_PRECEDENCE).toEqual([
      'event-fold',
      'summary-snapshot',
      'state-store',
    ]);
  });

  /** No precedence slot trusts a stale or contradictory projection. */
  it('Precedence_HasNoStaleProjectionSlot', () => {
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

  /** A snapshot behind the tail is only a seed. The plan folds the tail forward over it, so the result is not degraded. */
  it('SnapshotBehindTail_SeedsSnapshotAndFoldsForward_NotDegraded', () => {
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

  /**
   * A snapshot that claims events past the durable tail contradicts the log.
   * The plan discards it, folds the log from 0, and flags the result degraded.
   */
  it('SnapshotAheadOfTail_DiscardsSnapshotAndReplays_FlaggedDegraded', () => {
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

  /** A snapshot over a stream with a tail of 0 is still ahead, so the plan discards it and folds the empty log. */
  it('SnapshotAheadOfTail_EvenWhenEventsFullyPruned_StillDegrades', () => {
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

  /**
   * When the tail is unknown, the plan cannot prove a contradiction.
   * It seeds from the snapshot and does not flag the result degraded.
   */
  it('TailUnknown_PreservesWarmCacheBehaviour_NoFabricatedDegradation', () => {
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

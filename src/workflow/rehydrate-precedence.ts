/**
 * Declared fallback precedence for workflow rehydration.
 * Rehydration reads the event log, a cached summary snapshot, and under hard degradation the `.state.json` stamp.
 * When these sources disagree, a declared total order decides, not the order of the control flow.
 *
 * Rehydration never trusts a snapshot that contradicts the durable event log.
 * Rehydration discards a snapshot ahead of the event tail, folds the log again, and flags the result degraded.
 * For a snapshot behind the tail, rehydration folds the tail forward over it.
 * The freshness reasons come from `assessProjectionFreshness`, the same reasons that the view surface reports.
 */
import {
  assessProjectionFreshness,
  type ProjectionFreshness,
} from '../projections/freshness.js';

/**
 * Total precedence of rehydration sources. Index 0 is the highest authority.
 *  - `event-fold`: the state folded from the event log up to its tail. This is the canonical answer.
 *  - `summary-snapshot`: a snapshot whose cursor equals `MAX(events.sequence)`, served with no tail to fold.
 *    When the tail is unknown, the snapshot seeds the fold, and the tail after its cursor folds forward.
 *  - `state-store`: the `.state.json` stamp, read only under hard degradation by `buildDegradedResponse` in `rehydrate.ts`.
 *    The pure planner never chooses it.
 * No slot trusts a stale or contradictory projection.
 */
export const REHYDRATION_SOURCE_PRECEDENCE = [
  'event-fold',
  'summary-snapshot',
  'state-store',
] as const;

/** A declared rehydration source (a member of {@link REHYDRATION_SOURCE_PRECEDENCE}). */
export type RehydrationSource = (typeof REHYDRATION_SOURCE_PRECEDENCE)[number];

/** Rank a source by its position in the declared precedence. A lower rank is a higher authority. */
export function rehydrationSourceRank(source: RehydrationSource): number {
  return REHYDRATION_SOURCE_PRECEDENCE.indexOf(source);
}

/** The snapshot's position relative to the durable event tail. */
export interface SnapshotPosition {
  /** Whether a cached snapshot was recovered for the stream. */
  readonly hasSnapshot: boolean;
  /** The snapshot's recorded event-store sequence (0 when no snapshot). */
  readonly snapshotCursor: number;
  /**
   * The durable event tail (`MAX(events.sequence)`), or `undefined` when the backend cannot give it.
   * Without a tail, the planner cannot prove a contradiction, so it seeds from the snapshot and reports no degradation.
   */
  readonly eventTail: number | undefined;
  /** View name stamped onto the freshness verdict's `staleViews` (optional). */
  readonly viewName?: string;
}

/** The decided rehydration plan. */
export interface RehydrationPlan {
  /** The selected source per the declared precedence. */
  readonly source: RehydrationSource;
  /**
   * When true, seed the fold from the snapshot and fold the tail forward.
   * When false, discard the snapshot and fold the whole stream from sequence 0.
   */
  readonly seedFromSnapshot: boolean;
  /** The `sinceSequence` for the tail query: the snapshot cursor when seeding from the snapshot, otherwise 0. */
  readonly sinceSequence: number;
  /**
   * True when the snapshot was ahead of the durable tail and was discarded.
   * A snapshot that is only behind is not degraded, because the tail fold repairs it.
   */
  readonly degraded: boolean;
  /** The freshness verdict, present only when `degraded` is true, for `toProjectionDegradedMeta`. */
  readonly freshness?: ProjectionFreshness;
}

/**
 * Decide the rehydration source from the snapshot position, per {@link REHYDRATION_SOURCE_PRECEDENCE}. Pure.
 * A snapshot exactly on the tail is served directly. A snapshot behind the tail gets an `event-fold` that seeds from it.
 * The planner discards a snapshot ahead of the tail, from a pruned or rebuilt store, and marks the result degraded.
 */
export function planRehydrationSource(pos: SnapshotPosition): RehydrationPlan {
  if (!pos.hasSnapshot) {
    return {
      source: 'event-fold',
      seedFromSnapshot: false,
      sinceSequence: 0,
      degraded: false,
    };
  }

  if (pos.eventTail === undefined) {
    return {
      source: 'summary-snapshot',
      seedFromSnapshot: true,
      sinceSequence: pos.snapshotCursor,
      degraded: false,
    };
  }

  const freshness = assessProjectionFreshness(
    pos.viewName === undefined
      ? { eventTail: pos.eventTail, projectionCursor: pos.snapshotCursor }
      : {
          eventTail: pos.eventTail,
          projectionCursor: pos.snapshotCursor,
          viewName: pos.viewName,
        },
  );

  if (freshness.reason === 'projection-ahead') {
    return {
      source: 'event-fold',
      seedFromSnapshot: false,
      sinceSequence: 0,
      degraded: true,
      freshness,
    };
  }

  if (freshness.reason === 'projection-behind') {
    return {
      source: 'event-fold',
      seedFromSnapshot: true,
      sinceSequence: pos.snapshotCursor,
      degraded: false,
    };
  }

  return {
    source: 'summary-snapshot',
    seedFromSnapshot: true,
    sinceSequence: pos.snapshotCursor,
    degraded: false,
  };
}

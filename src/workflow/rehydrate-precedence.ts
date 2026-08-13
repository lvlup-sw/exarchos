/**
 * Deterministic fallback precedence for workflow rehydration (P04-06, EFF-004).
 *
 * Rehydration draws state from more than one surface — the durable event log, a
 * cached summary snapshot, and (only under hard degradation) the planner's
 * `<featureId>.state.json` stamp. When those surfaces disagree, the answer must
 * be decided by a DECLARED, total ordering rather than by whichever branch the
 * control flow happens to reach first. This module is that declared ordering
 * (`REHYDRATION_SOURCE_PRECEDENCE`) plus the pure decision that maps a snapshot's
 * position relative to the durable event tail onto a source
 * (`planRehydrationSource`).
 *
 * The load-bearing rule (exit proof): rehydration NEVER silently trusts a
 * projection that contradicts the durable event log. A snapshot whose recorded
 * cursor sits PAST the event tail — a snapshot restored over a pruned or rebuilt
 * store, `projection-ahead` in P01-02's freshness vocabulary — is discarded and
 * the state is re-folded from the authoritative log, with the result flagged
 * degraded so no consumer mistakes it for a clean read. A snapshot that merely
 * lags the tail (`projection-behind`) is not trusted as-is either: the tail is
 * folded forward over it so the answer reaches the authoritative tail state.
 *
 * This CONSUMES P01-02's freshness verdict (`assessProjectionFreshness`) rather
 * than inventing a second degradation signal — the same `projection-behind` /
 * `projection-ahead` reasons the view surface stamps on `_meta.projectionDegraded`
 * (see `projections/views/composite.ts`).
 */
import {
  assessProjectionFreshness,
  type ProjectionFreshness,
} from '../projections/freshness.js';

/**
 * Ordered, total precedence of rehydration sources. Index 0 is the highest
 * authority. Rehydration ALWAYS returns the state from the highest-authority
 * source that is available and self-consistent with the durable event tail; it
 * never falls through to a stale or contradictory projection.
 *
 *   - `event-fold`      — authoritative: the state was folded from the durable
 *     event log up to its tail (a cold fold from sequence 0, a snapshot baseline
 *     with the tail folded forward, or — after discarding a contradictory
 *     snapshot — a full replay). This is the canonical answer.
 *   - `summary-snapshot` — an explicit summary snapshot PROVEN to sit exactly on
 *     the durable tail (its recorded cursor equals `MAX(events.sequence)`), so it
 *     is served directly with no tail to fold. A high-fidelity cached read.
 *   - `state-store`     — the planner's `<featureId>.state.json` stamp. A
 *     last-resort read used only when NO authoritative projection source can be
 *     served (hard degradation: reducer throw, corrupt snapshot, event stream
 *     offline — see `buildDegradedResponse` in `rehydrate.ts`). Included here so
 *     the precedence is TOTAL, but it is never chosen by the pure planner below.
 *
 * A stale/contradictory projection is deliberately ABSENT from this list — that
 * is the whole point: there is no precedence slot that silently trusts it.
 */
export const REHYDRATION_SOURCE_PRECEDENCE = [
  'event-fold',
  'summary-snapshot',
  'state-store',
] as const;

/** A declared rehydration source (a member of {@link REHYDRATION_SOURCE_PRECEDENCE}). */
export type RehydrationSource = (typeof REHYDRATION_SOURCE_PRECEDENCE)[number];

/**
 * Rank a source by its position in the declared precedence. Lower rank = higher
 * authority. Exposed so callers (and tests) can compare two sources without
 * re-deriving the ordering.
 */
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
   * The durable event tail (`MAX(events.sequence)`), or `undefined` when the
   * backend cannot answer it. When `undefined` the planner cannot prove a
   * contradiction and preserves the historical warm-cache behaviour.
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
   * When true, seed the fold from the cached snapshot state and fold the tail
   * forward. When false, DISCARD the snapshot and fold the whole stream from
   * sequence 0 — either there was no snapshot, or the snapshot contradicted the
   * durable tail (projection-ahead) and must never be trusted.
   */
  readonly seedFromSnapshot: boolean;
  /**
   * The `sinceSequence` to pass to the tail query: the snapshot cursor when
   * seeding from the snapshot, else 0 (full replay from the event log).
   */
  readonly sinceSequence: number;
  /**
   * True when the returned result MUST be flagged degraded — the projection
   * contradicted the durable tail (projection-ahead) and was discarded. A
   * merely-behind snapshot is NOT degraded: folding the tail forward self-heals
   * it to the authoritative state.
   */
  readonly degraded: boolean;
  /**
   * The P01-02 freshness verdict, present only when `degraded` is true so the
   * caller can project it onto `_meta.projectionDegraded` via
   * `toProjectionDegradedMeta`.
   */
  readonly freshness?: ProjectionFreshness;
}

/**
 * Decide the rehydration source for a snapshot's position relative to the
 * durable event tail, per {@link REHYDRATION_SOURCE_PRECEDENCE}.
 *
 * Pure — no I/O. The caller supplies the snapshot cursor and the durable tail;
 * this returns the plan the handler executes.
 */
export function planRehydrationSource(pos: SnapshotPosition): RehydrationPlan {
  // No cached projection at all: fold the whole stream from the event log.
  if (!pos.hasSnapshot) {
    return {
      source: 'event-fold',
      seedFromSnapshot: false,
      sinceSequence: 0,
      degraded: false,
    };
  }

  // Tail unknown (backend cannot answer MAX(sequence) — e.g. a test stub with
  // no `tailSequence`). We cannot prove a contradiction, so preserve the
  // historical warm-cache behaviour: seed from the snapshot and fold the tail
  // forward. We do NOT fabricate a degradation signal on missing information.
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

  // Projection-ahead: the snapshot claims events past the durable tail — a
  // snapshot restored over a pruned or rebuilt store. NEVER trust it. Discard
  // the snapshot, re-fold from the authoritative log (sequence 0), and flag the
  // result degraded so it is never mistaken for a clean read.
  if (freshness.reason === 'projection-ahead') {
    return {
      source: 'event-fold',
      seedFromSnapshot: false,
      sinceSequence: 0,
      degraded: true,
      freshness,
    };
  }

  // Projection-behind: the snapshot lags the tail. Folding the tail forward over
  // the snapshot baseline self-heals it to the authoritative tail state, so the
  // answer is event-derived and NOT degraded — but it must not be served as the
  // snapshot alone.
  if (freshness.reason === 'projection-behind') {
    return {
      source: 'event-fold',
      seedFromSnapshot: true,
      sinceSequence: pos.snapshotCursor,
      degraded: false,
    };
  }

  // Fresh: the snapshot sits exactly on the tail. Serve it directly as the
  // explicit summary snapshot — the highest-fidelity cached read.
  return {
    source: 'summary-snapshot',
    seedFromSnapshot: true,
    sinceSequence: pos.snapshotCursor,
    degraded: false,
  };
}

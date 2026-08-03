/**
 * Projection freshness comparison (EFF-002).
 *
 * CB-8 (phase-gate v2.12 dogfood): workflow views silently served a stale fold
 * — a cancelled workflow still reported at `plan-review`, 7 of 10 completed
 * tasks visible, projection lag past 500s — with no signal that the answer was
 * not derived from the current event tail. A read surface that cannot prove its
 * fold covers the tail must say so rather than answer confidently.
 *
 * This module is the pure comparison. It performs no I/O: callers supply the
 * durable event tail and the projection cursors, and receive a typed verdict
 * suitable for stamping onto a response envelope.
 */

/** Why a projection is not trustworthy for this read. */
export type ProjectionDegradationReason =
  /** The fold stops short of the durable tail — the answer omits recent events. */
  | 'projection-behind'
  /**
   * The fold claims events past the durable tail. A snapshot restored over a
   * pruned or rebuilt store; the projection and the log contradict each other.
   */
  | 'projection-ahead';

/** One projection's position relative to the stream's durable tail. */
export interface ProjectionCursor {
  readonly viewName: string;
  /** Highest event sequence applied to this projection's cached fold. */
  readonly cursor: number;
}

export interface ProjectionFreshness {
  /** True when NO consumer may act on the fold without acknowledging the gap. */
  readonly degraded: boolean;
  readonly reason?: ProjectionDegradationReason;
  /** `MAX(events.sequence)` for the stream at read time. */
  readonly eventTail: number;
  /** The trailing (worst) projection cursor considered. */
  readonly projectionCursor: number;
  /** `eventTail - projectionCursor`; negative when a projection runs ahead. */
  readonly lag: number;
  /** Projections that disagree with the tail, worst first. */
  readonly staleViews: readonly string[];
}

/** A stream with no events and no folds is trivially fresh. */
const FRESH: ProjectionFreshness = Object.freeze({
  degraded: false,
  eventTail: 0,
  projectionCursor: 0,
  lag: 0,
  staleViews: Object.freeze([]),
});

/**
 * Compare one projection cursor against the durable event tail.
 *
 * Equality is the only fresh state. Both directions of disagreement degrade:
 * behind means the answer is incomplete, ahead means the projection and the log
 * contradict each other. Neither may be served as authoritative.
 */
export function assessProjectionFreshness(input: {
  readonly eventTail: number;
  readonly projectionCursor: number;
  readonly viewName?: string;
}): ProjectionFreshness {
  const { eventTail, projectionCursor } = input;
  const lag = eventTail - projectionCursor;
  if (lag === 0) {
    return {
      degraded: false,
      eventTail,
      projectionCursor,
      lag: 0,
      staleViews: [],
    };
  }
  return {
    degraded: true,
    reason: lag > 0 ? 'projection-behind' : 'projection-ahead',
    eventTail,
    projectionCursor,
    lag,
    staleViews: input.viewName === undefined ? [] : [input.viewName],
  };
}

/**
 * Compare every cached projection cursor for a stream against its durable tail.
 *
 * A stream is fresh only when every fold that has been materialized covers the
 * tail exactly. The reported `projectionCursor` is the worst offender, so a
 * consumer sees the widest gap rather than an average that hides it.
 *
 * A stream with no materialized folds is fresh: there is no stale answer to
 * serve. This keeps cold reads — which fold from scratch — out of the degraded
 * path.
 */
export function assessStreamFreshness(
  eventTail: number,
  cursors: readonly ProjectionCursor[],
): ProjectionFreshness {
  if (cursors.length === 0) {
    return eventTail === 0 ? FRESH : { ...FRESH, eventTail, projectionCursor: eventTail };
  }

  const disagreeing = cursors.filter((c) => c.cursor !== eventTail);
  if (disagreeing.length === 0) {
    return {
      degraded: false,
      eventTail,
      projectionCursor: eventTail,
      lag: 0,
      staleViews: [],
    };
  }

  // Worst first: the largest absolute distance from the tail leads.
  const ordered = [...disagreeing].sort(
    (a, b) => Math.abs(eventTail - b.cursor) - Math.abs(eventTail - a.cursor),
  );
  const worst = ordered[0]!;
  const lag = eventTail - worst.cursor;
  return {
    degraded: true,
    reason: lag > 0 ? 'projection-behind' : 'projection-ahead',
    eventTail,
    projectionCursor: worst.cursor,
    lag,
    staleViews: ordered.map((c) => c.viewName),
  };
}

/** `_meta` key carrying the freshness verdict on a view response envelope. */
export const PROJECTION_DEGRADED_META = 'projectionDegraded' as const;

/** The `_meta.projectionDegraded` payload stamped on a degraded read. */
export interface ProjectionDegradedMeta {
  readonly reason: ProjectionDegradationReason;
  readonly eventTail: number;
  readonly projectionCursor: number;
  readonly lag: number;
  readonly staleViews: readonly string[];
}

/**
 * Project a freshness verdict into the `_meta` payload, or `undefined` when the
 * read is trustworthy. Returning `undefined` for the healthy case keeps the
 * envelope byte-identical to today's for every non-degraded read.
 */
export function toProjectionDegradedMeta(
  freshness: ProjectionFreshness,
): ProjectionDegradedMeta | undefined {
  if (!freshness.degraded || freshness.reason === undefined) return undefined;
  return {
    reason: freshness.reason,
    eventTail: freshness.eventTail,
    projectionCursor: freshness.projectionCursor,
    lag: freshness.lag,
    staleViews: freshness.staleViews,
  };
}

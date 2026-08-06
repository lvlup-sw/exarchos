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
 *
 * ## DR-4 — the verdict, made durable
 *
 * The comparison above answered CB-8's question but published nothing: the
 * verdict lived only in `_meta.projectionDegraded` on one response envelope,
 * recomputed per read from an in-memory LRU of materialized folds. Persisted
 * nowhere, consumed by nobody — so any consumer that did not read `_meta` (and
 * every consumer in a different process, or this one after a restart with a
 * cold cache) still served the stale fold as `success: true`.
 *
 * The `publish…` / `read…` half of this module closes that: the same verdict is
 * journaled to a dedicated durable stream, and read back as a folded state.
 * The `_meta` annotation is unchanged and still ephemeral by design — it is a
 * per-response courtesy, not the state of record.
 */

import {
  ProjectionDegradedData,
  ProjectionRecoveredData,
  type ProjectionDegraded,
  type ProjectionRecovered,
} from '../event-store/schemas.js';

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
  const [worst, ...rest] = ordered;
  if (worst === undefined) {
    return {
      degraded: false,
      eventTail,
      projectionCursor: eventTail,
      lag: 0,
      staleViews: [],
    };
  }
  const lag = eventTail - worst.cursor;
  return {
    degraded: true,
    reason: lag > 0 ? 'projection-behind' : 'projection-ahead',
    eventTail,
    projectionCursor: worst.cursor,
    lag,
    staleViews: [worst, ...rest].map((c) => c.viewName),
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

// ─── DR-4: the durable projection-degraded state ────────────────────────────
//
// Everything above is ephemeral by construction. Everything below publishes the
// SAME verdict durably so an independent consumer — a different process, or
// this one after a restart with a cold materializer cache — can read it back
// rather than re-derive it from a cache it does not share.

/**
 * The singleton stream carrying projection-health facts.
 *
 * Deliberately NOT the assessed stream. Appending the verdict to the stream
 * under assessment would move the very `MAX(sequence)` tail the verdict is
 * computed against: the next read would observe a fresh disagreement, append
 * again, and the detector would feed itself without bound. A dedicated meta
 * stream keeps the observation out of the observed system — the same idiom
 * `feedback.recorded` uses with `meta/feedback`.
 */
export const PROJECTION_HEALTH_STREAM_ID = 'meta/projection-health';

/** Durable fact: a stream's folds disagree with its tail. */
export const PROJECTION_DEGRADED_EVENT_TYPE = 'projection.degraded' as const;

/** Durable fact: a previously-degraded stream's folds caught the tail. */
export const PROJECTION_RECOVERED_EVENT_TYPE = 'projection.recovered' as const;

/**
 * The durable degraded state for one stream, as folded from the health stream.
 *
 * This — not `_meta.projectionDegraded` — is the state of record. It survives a
 * process restart and is readable by any consumer holding an event store,
 * without warming a single projection.
 */
export interface DurableProjectionDegradedState {
  /** The ASSESSED stream (the record itself lives on the health stream). */
  readonly streamId: string;
  readonly reason: ProjectionDegradationReason;
  readonly eventTail: number;
  readonly projectionCursor: number;
  readonly lag: number;
  readonly staleViews: readonly string[];
  /** Sequence of the publishing event ON the health stream. */
  readonly sequence: number;
  /** Envelope timestamp of the publishing event. */
  readonly observedAt: string;
}

/** One event as this module needs to read it back. */
interface JournalEvent {
  readonly type: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly data?: Record<string, unknown> | undefined;
}

/**
 * The narrow slice of the event store this module writes through.
 *
 * A port rather than a concrete `EventStore` import: the publisher needs an
 * idempotent keyed append and a typed single-stream read, nothing more, and
 * stating that keeps the pure comparison above free of substrate coupling.
 * `EventStore` satisfies it structurally — callers pass the real store.
 */
export interface ProjectionHealthJournal {
  append(
    streamId: string,
    event: { type: string; data?: Record<string, unknown>; idempotencyKey?: string },
    options?: { idempotencyKey?: string },
  ): Promise<{ sequence: number; timestamp: string }>;
  query(
    streamId: string,
    filters?: { type?: string },
  ): Promise<readonly JournalEvent[]>;
}

/**
 * Storage key (INV-8) for a degradation observation.
 *
 * Keyed on the OBSERVED cursor/tail pair, so re-detecting the same degraded
 * cursor — every subsequent read of an unchanged stale stream — collapses onto
 * the row already written instead of appending one row per read. A genuinely
 * new disagreement (the tail moved, or the fold slipped further) mints a new
 * key and a new row, which is exactly the history worth keeping.
 *
 * `recoveredGeneration` salts the key with the fold generation: the
 * health-stream sequence of the stream's most recent `projection.recovered`
 * event (`0` when it has never recovered). Without it, degrade → recover →
 * degrade AGAIN at the identical `(eventTail, projectionCursor)` pair — the
 * module's own cursor-regression scenario (snapshot restore / rebuild) — would
 * dedupe the second `projection.degraded` onto the ORIGINAL row, whose sequence
 * precedes the recovered event, so the fold would end `recovered` and a
 * degraded stream would be served as healthy. A post-recovery re-detection now
 * carries a new generation, mints a new key, and lands PAST the recovered
 * event; within one generation the per-read collapse is unchanged.
 */
export function projectionDegradedIdempotencyKey(
  streamId: string,
  eventTail: number,
  projectionCursor: number,
  recoveredGeneration: number,
): string {
  return `${streamId}:projection-degraded:${eventTail}:${projectionCursor}:${recoveredGeneration}`;
}

/**
 * Storage key (INV-8) for a resolution.
 *
 * Keyed on the health-stream sequence of the degraded record it resolves: one
 * resolution per degradation, so a concurrent double-publish collapses.
 */
export function projectionRecoveredIdempotencyKey(
  streamId: string,
  resolvesSequence: number,
): string {
  return `${streamId}:projection-recovered:${resolvesSequence}`;
}

/**
 * The current fold generation for a stream's degraded key: the health-stream
 * sequence of its most recent `projection.recovered` event, `0` when the stream
 * has never recovered. See {@link projectionDegradedIdempotencyKey} for why the
 * degraded key must be salted with this.
 */
async function lastRecoveredSequence(
  journal: ProjectionHealthJournal,
  streamId: string,
): Promise<number> {
  const events = await journal.query(PROJECTION_HEALTH_STREAM_ID, {
    type: PROJECTION_RECOVERED_EVENT_TYPE,
  });
  let last = 0;
  for (const event of events) {
    const parsed = ProjectionRecoveredData.safeParse(event.data);
    if (!parsed.success) continue;
    if (parsed.data.streamId === streamId && event.sequence > last) {
      last = event.sequence;
    }
  }
  return last;
}

function toDurableState(
  event: JournalEvent,
  data: ProjectionDegraded,
): DurableProjectionDegradedState {
  return {
    streamId: data.streamId,
    reason: data.reason,
    eventTail: data.eventTail,
    projectionCursor: data.projectionCursor,
    lag: data.lag,
    staleViews: data.staleViews,
    sequence: event.sequence,
    observedAt: event.timestamp,
  };
}

/**
 * Fold the health stream into the current durable degraded state per stream.
 *
 * `projection.degraded` claims the slot for its `streamId`; `projection.recovered`
 * releases it. Replaying the whole (small, meta) stream in sequence order is the
 * whole reducer — there is no cache, so the answer cannot go stale the way the
 * thing it reports on did.
 */
export async function readAllProjectionDegradedStates(
  journal: ProjectionHealthJournal,
): Promise<ReadonlyMap<string, DurableProjectionDegradedState>> {
  const events = await journal.query(PROJECTION_HEALTH_STREAM_ID);
  const byStream = new Map<string, DurableProjectionDegradedState>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === PROJECTION_DEGRADED_EVENT_TYPE) {
      const parsed = ProjectionDegradedData.safeParse(event.data);
      if (!parsed.success) continue;
      byStream.set(parsed.data.streamId, toDurableState(event, parsed.data));
    } else if (event.type === PROJECTION_RECOVERED_EVENT_TYPE) {
      const parsed = ProjectionRecoveredData.safeParse(event.data);
      if (!parsed.success) continue;
      byStream.delete(parsed.data.streamId);
    }
  }
  return byStream;
}

/**
 * Read the durable degraded state for one stream, or `undefined` when the
 * stream is not currently recorded as degraded.
 *
 * This is the consumer entry point: a readiness / workflow / reliability
 * surface calls it with nothing but an event store and a stream id, and gets
 * back the typed verdict — no materializer, no warm cache, no `_meta`.
 */
export async function readProjectionDegradedState(
  journal: ProjectionHealthJournal,
  streamId: string,
): Promise<DurableProjectionDegradedState | undefined> {
  return (await readAllProjectionDegradedStates(journal)).get(streamId);
}

/**
 * Publish the durable projection-health state implied by a freshness verdict.
 *
 * - Degraded → append `projection.degraded` (idempotency-keyed on the observed
 *   cursor/tail pair) and return the resulting durable state.
 * - Fresh, and the stream currently holds a degraded record → append the paired
 *   `projection.recovered` so the folded state returns to healthy.
 * - Fresh, and no degraded record is held → append NOTHING. A healthy stream
 *   must not write a row per read.
 *
 * Returns the durable state now in force for the stream (`undefined` when
 * healthy), so a caller can publish and consume in one hop.
 */
export async function publishProjectionFreshness(
  journal: ProjectionHealthJournal,
  streamId: string,
  freshness: ProjectionFreshness,
): Promise<DurableProjectionDegradedState | undefined> {
  if (!freshness.degraded || freshness.reason === undefined) {
    const held = await readProjectionDegradedState(journal, streamId);
    if (held === undefined) return undefined;
    const recovered: ProjectionRecovered = ProjectionRecoveredData.parse({
      streamId,
      eventTail: freshness.eventTail,
      projectionCursor: freshness.projectionCursor,
    });
    await journal.append(
      PROJECTION_HEALTH_STREAM_ID,
      { type: PROJECTION_RECOVERED_EVENT_TYPE, data: recovered },
      { idempotencyKey: projectionRecoveredIdempotencyKey(streamId, held.sequence) },
    );
    return undefined;
  }

  // Parse before append so the durable payload can never drift from the
  // registered `EVENT_DATA_SCHEMAS` contract T-07 reads it back through.
  const degraded: ProjectionDegraded = ProjectionDegradedData.parse({
    streamId,
    reason: freshness.reason,
    eventTail: freshness.eventTail,
    projectionCursor: freshness.projectionCursor,
    lag: freshness.lag,
    staleViews: [...freshness.staleViews],
  });
  const appended = await journal.append(
    PROJECTION_HEALTH_STREAM_ID,
    { type: PROJECTION_DEGRADED_EVENT_TYPE, data: degraded },
    {
      idempotencyKey: projectionDegradedIdempotencyKey(
        streamId,
        freshness.eventTail,
        freshness.projectionCursor,
        await lastRecoveredSequence(journal, streamId),
      ),
    },
  );
  return toDurableState(
    { type: PROJECTION_DEGRADED_EVENT_TYPE, sequence: appended.sequence, timestamp: appended.timestamp },
    degraded,
  );
}


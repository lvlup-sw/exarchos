/**
 * Projection freshness: compare a projection cursor with the durable event tail.
 *
 * A read surface that cannot prove that its fold covers the tail must say so.
 * The comparison is pure and does no I/O. Callers supply the tail and the cursors.
 *
 * The `publish…` and `read…` functions write the same verdict to a dedicated
 * durable stream and fold it back. That stream is the state of record. The
 * `_meta` annotation is per response and is not stored.
 */

import {
  ProjectionDegradedData,
  ProjectionRecoveredData,
  type ProjectionDegraded,
  type ProjectionRecovered,
} from '../events/schemas.js';

/**
 * Why a projection is not trustworthy for this read.
 *
 * - `projection-behind`: the fold stops short of the durable tail. The answer omits recent events.
 * - `projection-ahead`: the fold claims events past the durable tail, for example after a
 *   snapshot restore over a pruned or rebuilt store.
 */
export type ProjectionDegradationReason =
  | 'projection-behind'
  | 'projection-ahead';

/** One projection's position relative to the stream's durable tail. */
export interface ProjectionCursor {
  readonly viewName: string;
  /** Highest event sequence applied to this projection's cached fold. */
  readonly cursor: number;
}

export interface ProjectionFreshness {
  /** True when the fold disagrees with the tail. A consumer must not act on it as if it were current. */
  readonly degraded: boolean;
  readonly reason?: ProjectionDegradationReason;
  /** `MAX(events.sequence)` for the stream at read time. */
  readonly eventTail: number;
  /** The trailing (worst) projection cursor considered. */
  readonly projectionCursor: number;
  /** `eventTail - projectionCursor`. It is negative when a projection runs ahead. */
  readonly lag: number;
  /** Projections that disagree with the tail, worst first. */
  readonly staleViews: readonly string[];
}


/**
 * Compare one projection cursor with the durable event tail.
 *
 * Only equality is fresh. Behind means that the answer is incomplete. Ahead means
 * that the projection and the log contradict each other. Both directions degrade.
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
 * Project a freshness verdict into the `_meta` payload. Returns `undefined` when
 * the read is trustworthy.
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

/**
 * The singleton stream that holds projection-health facts.
 *
 * It is not the assessed stream. An append to the assessed stream moves the
 * `MAX(sequence)` tail that the verdict compares against. The next read then sees
 * a new disagreement and appends again, without end. `feedback.recorded` uses
 * `meta/feedback` in the same way.
 */
export const PROJECTION_HEALTH_STREAM_ID = 'meta/projection-health';

/** Durable fact: a stream's folds disagree with its tail. */
export const PROJECTION_DEGRADED_EVENT_TYPE = 'projection.degraded' as const;

/** Durable fact: the folds of a degraded stream caught up with the tail. */
export const PROJECTION_RECOVERED_EVENT_TYPE = 'projection.recovered' as const;

/**
 * The durable degraded state for one stream, folded from the health stream.
 *
 * This is the state of record, not `_meta.projectionDegraded`. Any consumer with
 * an event store can read it after a restart, with no warm projection.
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
 * The part of the event store that this module uses: an idempotent keyed append
 * and a single-stream read. `EventStore` satisfies it structurally.
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
 * Idempotency key for a degradation observation.
 *
 * The key holds the observed tail and cursor. Repeated reads of an unchanged stale
 * stream collapse onto one row. A new disagreement makes a new key and a new row.
 *
 * `recoveredGeneration` is the health-stream sequence of the last
 * `projection.recovered` event for the stream, or `0`. Without it, a second
 * degradation at the same tail and cursor after a recovery dedupes onto the first
 * row. That row comes before the recovery, so the fold reports the stream as healthy.
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
 * Idempotency key for a recovery. It holds the health-stream sequence of the
 * degraded record that it resolves, so a concurrent double publish collapses.
 */
export function projectionRecoveredIdempotencyKey(
  streamId: string,
  resolvesSequence: number,
): string {
  return `${streamId}:projection-recovered:${resolvesSequence}`;
}

/**
 * The health-stream sequence of the last `projection.recovered` event for a
 * stream, or `0`. {@link projectionDegradedIdempotencyKey} salts its key with it.
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
 * `projection.degraded` sets the entry for its `streamId`. `projection.recovered`
 * removes it. The fold replays the whole stream in sequence order and keeps no
 * cache, so the answer cannot go stale.
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
 * Read the durable degraded state for one stream, or `undefined` when the stream
 * is not degraded. A consumer needs only an event store and a stream id.
 */
export async function readProjectionDegradedState(
  journal: ProjectionHealthJournal,
  streamId: string,
): Promise<DurableProjectionDegradedState | undefined> {
  return (await readAllProjectionDegradedStates(journal)).get(streamId);
}

/**
 * Publish the durable projection-health state for a freshness verdict.
 *
 * - Degraded: append `projection.degraded` and return the durable state.
 * - Fresh, with a held degraded record: append `projection.recovered`.
 * - Fresh, with no held record: append nothing. A healthy stream writes no row per read.
 *
 * Each payload goes through its schema before the append, so the stored data
 * matches `EVENT_DATA_SCHEMAS`. Returns the durable state now in force, or
 * `undefined` when healthy.
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


// ─── AtomicAppender wire types (#1259, T06/T07) ─────────────────────────────
//
// These are the shape passed in by `AtomicAppender`'s SQLite-backed body.
// They are intentionally NOT the canonical `WorkflowEvent` because the
// appender owns sequence allocation and timestamp generation — the
// backend just persists the pre-computed row. Keeping the wire shape
// minimal means the substrate boundary stays narrow and testable.

/** A single pre-allocated event row ready for INSERT. */
export interface AtomicAppendEvent {
  /** Assigned by the appender's `finalize(base)` as `base + i + 1`, where
   *  `base` is the stream-version gate's return value (allocated INSIDE the
   *  write transaction — not a pre-transaction read). */
  sequence: number;
  type: string;
  timestamp: string;
  data?: Record<string, unknown> | undefined;
  /**
   * The full PublicPersistedEvent serialized as JSON. Persisted into
   * `events.payload` so `rowToEvent` can rehydrate the canonical shape on
   * read — preserving idempotencyKey, eventId, correlationId, etc.
   */
  payload: string;
  /**
   * #1437 — three V6 indexed correlation columns. Stamped onto the
   * PublicPersistedEvent by `stampWithDispatchContext` (store.ts) when an
   * active `DispatchContext` is present. Surfaced on the wire shape so
   * the SQLite `insertEventStrict` bind can populate the indexed
   * `operation_id` / `correlation_id` / `causation_id` columns alongside
   * the JSON payload. Optional because pre-context callers (raw test
   * fixtures, migration paths) emit unstamped events.
   *
   * Source of truth for the data remains `payload`; these fields exist
   * purely as the indexed filter handle for telemetry views (INV-1).
   */
  operationId?: string;
  correlationId?: string;
  causationId?: string;
}

/**
 * Shape of an entry returned from `lookupIdempotencyClaim`. Mirrors
 * `PublicPersistedEvent` from `events/atomic-appender.ts` — kept here
 * as a structural alias so the storage module does not import from the
 * event-store module (one-way dependency: event-store → storage).
 */
export interface PublicPersistedEventLike {
  streamId: string;
  sequence: number;
  type: string;
  timestamp: string;
  eventId: string;
  idempotencyKey?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface AtomicDecideOnceDecision<TResult> {
  streamId: string;
  n: number;
  expectedSequence?: number;
  result: TResult;
  finalize: (base: number) => {
    events: AtomicAppendEvent[];
    eventIds: string[];
    timestamps: string[];
    events_json: string;
  };
}

export interface AtomicDecideOnceOutcome<TResult> {
  kind: 'committed' | 'cache-hit';
  streamId: string;
  result: TResult;
  sequences: number[];
  eventIds: string[];
  timestamps: string[];
}

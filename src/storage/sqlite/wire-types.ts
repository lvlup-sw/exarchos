/**
 * Wire types that the SQLite-backed body of `AtomicAppender` passes in. They are
 * not the canonical `WorkflowEvent`, because the appender allocates sequences
 * and timestamps, and the backend persists the pre-computed row.
 */

/** A single pre-allocated event row ready for INSERT. */
export interface AtomicAppendEvent {
  /**
   * Set by `finalize(base)` of the appender to `base + i + 1`. The stream-version
   * gate returns `base` inside the write transaction.
   */
  sequence: number;
  type: string;
  timestamp: string;
  data?: Record<string, unknown> | undefined;
  /**
   * The full PublicPersistedEvent as JSON, persisted into `events.payload`.
   * `rowToEvent` rehydrates the canonical shape from it on read.
   */
  payload: string;
  /**
   * Indexed correlation fields, set by `stampWithDispatchContext` when a
   * `DispatchContext` is active. The `insertEventStrict` bind copies them into the
   * `operation_id`, `correlation_id`, and `causation_id` columns. `payload` stays
   * the source of truth. The fields are optional, because test fixtures and
   * migration paths emit unstamped events.
   */
  operationId?: string;
  correlationId?: string;
  causationId?: string;
}

/**
 * Shape of an entry from `lookupIdempotencyClaim`. It is a structural copy of
 * `PublicPersistedEvent`, so storage does not import the event-store module.
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

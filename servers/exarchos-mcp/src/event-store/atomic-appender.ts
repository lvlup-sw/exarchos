import * as fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { validateStreamId } from '../shared/validation.js';
import {
  SqliteBackend,
  SqliteBusyExhaustedError,
  SequenceGateConflictError,
  type AtomicAppendEvent as SqliteAtomicAppendEvent,
} from '../storage/sqlite-backend.js';
import { ConcurrencyError } from './concurrency-error.js';
import { StorageBusyError } from './storage-busy-error.js';
import {
  InvalidSessionOptionsError,
  SessionClosedError,
} from './session-errors.js';
import {
  defaultRegistry,
  type ProjectionRegistry,
} from '../projections/registry.js';
import type { ProjectionReducer } from '../projections/types.js';
import {
  InvalidReducerScopeError,
} from '../projections/store.js';
import { UnknownProjectionIdError } from '../projections/rebuild.js';

/**
 * AtomicAppender — single-writer-per-stream append primitive (v2.11).
 *
 * Closes the substrate-level half of #1230 (overlapping sequence allocation under
 * concurrency) and #1228 (phantom idempotencyKey claim on partial-write failure).
 *
 * v2.11 substrate-cut (Phase 2): the JSONL primary body and `backend` discriminator
 * were removed. The sole append path is now SQLite — `BEGIN IMMEDIATE` wrapping
 * the idempotency-claim INSERT, sequence upsert, and event INSERT in one
 * transaction. The per-stream Promise mutex remains as the first-tier guard;
 * SQLite's transactional semantics are the second-tier guard. There is no
 * dual-write fallback, no `.events.jsonl` / `.seq` machinery, no in-memory
 * idempotency cache — every claim persists in `idempotency_claims` and
 * survives process restart.
 *
 * The `dispatchAppend` indirection has been inlined into `append` /
 * `appendUnkeyed` / `appendComputed`: each delegates directly to
 * `appendSqliteLocked`.
 */

/**
 * Public-shaped persisted event surfaced on cache-hit so callers can return
 * the actual stored shape (not a synthesized event from the request body).
 *
 * `eventId` is included for traceability — callers that don't need it can
 * ignore the field. Other extension fields flow through the index signature.
 */
export interface PublicPersistedEvent {
  streamId: string;
  sequence: number;
  type: string;
  timestamp: string;
  eventId: string;
  idempotencyKey?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

export type AppendResult =
  | {
      ok: true;
      /**
       * Distinguishes a fresh commit from a cache-hit so callers can:
       *   - Return the actual persisted shape (not a synthesized version
       *     of the current request body — a retry with the same key but
       *     a different payload would otherwise replicate the wrong data).
       *   - Skip supplementary side effects (backend dual-write, outbox)
       *     that already ran when the original commit happened.
       */
      kind: 'committed';
      sequences: number[];
      eventIds: string[];
      /**
       * The timestamp on each persisted event, in the same order as
       * `sequences` / `eventIds`. Callers reconstructing the public event
       * shape get a stable round-trip across retries.
       */
      timestamps: string[];
    }
  | {
      ok: true;
      kind: 'cache-hit';
      sequences: number[];
      eventIds: string[];
      timestamps: string[];
      /**
       * The events ORIGINALLY persisted under this idempotency key. The
       * caller's CURRENT request payload is irrelevant — return THIS to
       * the caller and skip backend/outbox replication (already done at
       * commit time).
       */
      persistedEvents: PublicPersistedEvent[];
    }
  | {
      ok: false;
      /**
       * `storage_busy` — the substrate retried the BEGIN IMMEDIATE
       * transaction up to its budget (5 attempts with exponential backoff
       * capped at 100 ms) and SQLITE_BUSY persisted on every attempt.
       * Caller may retry at the application layer or surface to the
       * operator as substrate contention.
       */
      reason: 'idempotency-claimed' | 'sequence-conflict' | 'io-error' | 'storage_busy';
      cause?: Error;
      /** Populated on `sequence-conflict` so callers can translate to typed errors. */
      expected?: number;
      actual?: number;
    };

export interface EventInput {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: string;
  correlationId?: string;
  causationId?: string;
  // #1291 — dispatch-boundary operation id. Stamped by
  // `EventStore.append*` from the active dispatch context's
  // `AsyncLocalStorage` store when present; passes through to persistence
  // verbatim. Optional because direct (non-dispatch) callers stay
  // backward-compatible.
  operationId?: string;
  agentId?: string;
  agentRole?: string;
  source?: string;
  schemaVersion?: string;
  [k: string]: unknown;
}

/**
 * Per-call append options. Optimistic-concurrency support lives here so
 * `EventStore`'s legacy `expectedSequence` callers can migrate cleanly.
 *
 * Re-entrancy: do NOT pass `expectedSequence` from inside an
 * `appendComputed` callback — the per-stream Promise mutex is the same
 * lock context the callback is already holding. The caller's outer-most
 * `append` invocation owns the check.
 */
export interface AppendOptions {
  /**
   * The current sequence counter the caller observed before issuing this
   * append. Compared against the durable high-water mark inside the
   * BEGIN IMMEDIATE transaction; a mismatch returns
   * `{ ok: false, reason: 'sequence-conflict', expected, actual }` so the
   * caller can translate to a typed error without needing access to
   * internal state.
   */
  expectedSequence?: number;
}

// ─── Wave 3 (R-2) — decide / withSession / aggregateStream types ────────────

/**
 * Caller-supplied options for {@link AtomicAppender.decide}.
 *
 * `registry` defaults to the process-wide {@link defaultRegistry}; tests
 * pass an isolated registry to avoid contaminating production state.
 *
 * `operationId` enables single-key-per-call idempotency (audit §F1.3) —
 * the derived key is `${streamId}:${reducerId}:${operationId}`, and the
 * substrate's `idempotency_claims` row stores the full N-event array so
 * a retry returns the canonical multi-event shape without re-committing.
 *
 * `alwaysEnforceConsistency` defaults to `true`: an empty-events return
 * from the decide closure triggers a tail re-read and throws
 * {@link ConcurrencyError} if the tail advanced during the decision.
 * Setting to `false` skips that check and is appropriate only for
 * pure-read flows that never write events.
 */
export interface DecideOptions {
  readonly registry?: ProjectionRegistry;
  readonly operationId?: string;
  readonly alwaysEnforceConsistency?: boolean;
}

/**
 * Context object passed to a decide closure. Mirrors the design's R-2
 * §"decide — pure state machine path" shape.
 *
 * `now()` is injected so closures and pre-commit timestamps share one
 * source of "now" — important for replay determinism in projections
 * that fold over the committed events.
 */
export interface DecideContext {
  readonly streamId: string;
  /** Tail sequence captured at fetch time (before the closure runs). */
  readonly version: number;
  /** Injectable clock — returns an ISO-8601 timestamp. */
  readonly now: () => string;
}

/**
 * Per-call result shape from `decide` / `withSession`.
 *
 * Mirrors the substrate's {@link AppendResult} ok-branch so callers that
 * just want sequences/eventIds don't need a second translation layer.
 * On failure the primitive throws a typed error (`ConcurrencyError`,
 * `StorageBusyError`, `InvalidReducerScopeError`, etc.) — there is no
 * `ok: false` discriminator here.
 */
export type DecideResult =
  | {
      readonly ok: true;
      readonly kind: 'committed' | 'cache-hit' | 'no-op';
      readonly sequences: readonly number[];
      readonly eventIds: readonly string[];
      readonly timestamps: readonly string[];
    };

/**
 * Maximum substrate attempts the SQLite body retries `BEGIN IMMEDIATE`
 * against SQLITE_BUSY. Mirrors `SQLITE_BUSY_RETRY_POLICY.maxAttempts`
 * (sqlite-backend.ts:179-183). Bundled into the primitive layer so the
 * translation `storage_busy → StorageBusyError` can report the budget
 * the substrate actually used, without depending on a re-export from
 * the substrate.
 */
const STORAGE_BUSY_MAX_ATTEMPTS = 5;

/**
 * Caller-supplied options for {@link AtomicAppender.withSession}.
 *
 * Extends {@link DecideOptions} with the idempotency-contract gate
 * (audit §F1.1): callers MUST either supply `operationId` (so retries
 * dedupe on the substrate's idempotency_claims row) or opt in via
 * `allowNonIdempotent: true`. The gate prevents retry storms from
 * re-firing non-idempotent side effects (external API calls, message
 * sends) inside the closure on every OCC loss — see the design's R-2
 * §"Idempotency contract" for the full rationale.
 */
export interface WithSessionOptions extends DecideOptions {
  /**
   * Explicit acknowledgement that the closure's side effects are
   * either provably idempotent or that the caller has reasoned about
   * the at-least-once retry boundary and accepts the trade-off.
   * Setting this to `true` does NOT make the closure safe — it
   * documents that the caller knows what they're doing.
   *
   * Defaults to `false`. When `false` AND `operationId` is omitted,
   * `withSession` throws {@link InvalidSessionOptionsError}.
   */
  readonly allowNonIdempotent?: boolean;
}

/**
 * Session object exposed to a `withSession` closure. The closure can
 * read the folded `aggregate` + tail `version`, and queue events via
 * `append(evt)` that commit atomically when the closure resolves.
 *
 * Mutability discipline: `pendingEvents` is private — closures MUST
 * route every event through `append(evt)` so the session's
 * closed-after-resolve gate fires correctly (Task 3.10).
 */
export interface Session<TState> {
  readonly aggregate: TState;
  readonly version: number;
  append(event: EventInput): void;
}

export interface AtomicAppenderOptions {
  /** Directory under which the SQLite database file lives. */
  stateDir: string;
  /**
   * Optional pre-built SqliteBackend instance. When omitted, the appender
   * lazily constructs its own backend keyed off `${stateDir}/exarchos.db`.
   * Production wiring (lifecycle.ts / EventStore) injects the shared
   * backend so reads + writes converge on the same handle.
   */
  sqliteBackend?: SqliteBackend;
  /**
   * SQLite database file name relative to `stateDir`. Defaults to
   * `exarchos.db` to match `index.ts:initializeBackend`. Tests that
   * isolate the appender from the rest of the lifecycle can override
   * this to keep their fixture databases out of the shared file.
   */
  sqliteDbFilename?: string;
  /**
   * Durability posture for the lazily-constructed backend (DR-4), threaded
   * to `SqliteBackend`'s `PRAGMA synchronous`. Resolved from `.exarchos.yml`
   * `storage.synchronous` by the EventStore/lifecycle wiring. Omitted →
   * `'normal'` (unchanged default).
   */
  synchronous?: 'normal' | 'full';
}

interface PersistedEvent {
  streamId: string;
  sequence: number;
  type: string;
  timestamp: string;
  eventId: string;
  idempotencyKey?: string;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Per-stream Promise-chain mutex. Each `runExclusive` call appends a new step
 * to the chain; the next caller awaits the prior tail before its critical
 * section runs. The chain release is non-throwing so a critical-section error
 * does not poison subsequent acquirers.
 */
class StreamLockManager {
  private tails = new Map<string, Promise<unknown>>();

  async runExclusive<T>(streamId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(streamId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    this.tails.set(streamId, next);
    try {
      await prior;
      return await fn();
    } finally {
      release();
      // Trim if no further appenders are queued (avoid Map growth)
      if (this.tails.get(streamId) === next) {
        this.tails.delete(streamId);
      }
    }
  }
}

export class AtomicAppender {
  private readonly stateDir: string;
  private readonly locks = new StreamLockManager();
  private readonly sqliteDbFilename: string;
  /**
   * Lazily-constructed SQLite backend. Owned by the appender (initialized
   * on first use, closed by the host's lifecycle). When
   * `options.sqliteBackend` is injected, it is used directly and never
   * closed by the appender — the injector retains ownership.
   *
   * **Singleton invariant (T63):** This field MUST only be assigned via
   * the `sqliteBackendPromise` cache below. The legacy "check field then
   * construct" pattern was race-prone because `runExclusive` only
   * serializes per-stream — concurrent first-writes targeting different
   * streams could both pass `!this.sqliteBackend` and each construct a
   * fresh handle (the loser's handle then leaks). The Promise-cached
   * singleton pattern (`sqliteBackendPromise`) closes that window by
   * synchronously assigning the in-flight Promise before any await,
   * so all concurrent callers converge on a single handle.
   */
  private sqliteBackend?: SqliteBackend;
  /**
   * Promise cache for the lazy SQLite backend init (T63). The first
   * caller assigns this field synchronously before awaiting backend
   * construction; subsequent callers await the same in-flight Promise
   * and never trigger a duplicate construction. Once resolved, both
   * this field and `sqliteBackend` reference the canonical handle.
   */
  private sqliteBackendPromise?: Promise<SqliteBackend>;
  private readonly sqliteBackendInjected: boolean;
  /** Durability posture for lazily-constructed backends (DR-4). */
  private readonly synchronous?: 'normal' | 'full';

  constructor(options: AtomicAppenderOptions) {
    this.stateDir = options.stateDir;
    this.sqliteDbFilename = options.sqliteDbFilename ?? 'exarchos.db';
    this.synchronous = options.synchronous;
    if (options.sqliteBackend) {
      this.sqliteBackend = options.sqliteBackend;
      // Pre-resolved Promise so the singleton invariant holds for the
      // injected path too: any concurrent `getSqliteBackend()` call
      // awaits a Promise that is already settled with the injected
      // handle.
      this.sqliteBackendPromise = Promise.resolve(options.sqliteBackend);
      this.sqliteBackendInjected = true;
    } else {
      this.sqliteBackendInjected = false;
    }
  }

  async append(
    streamId: string,
    events: EventInput[],
    idempotencyKey: string,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    return this.locks.runExclusive(streamId, () =>
      this.appendSqliteLocked(streamId, events, { idempotencyKey }, options),
    );
  }

  /**
   * Append without idempotency dedup.
   *
   * Used by callers (e.g. `EventStore.append` for events without an explicit
   * key) that want a single write but no idempotency claim. The persisted
   * event has `idempotencyKey: null` in storage, so it cannot collide with
   * any retry chain.
   */
  async appendUnkeyed(
    streamId: string,
    events: EventInput[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    return this.locks.runExclusive(streamId, () =>
      this.appendSqliteLocked(streamId, events, null, options),
    );
  }

  /**
   * Compute-then-append under a single per-stream lock.
   *
   * `compute` runs while the per-stream lock is held; the events it returns
   * are appended in the same critical section. Read-then-append callers
   * (any pattern that derives a to-be-persisted value from the current stream
   * contents) benefit from the lock-coupled critical section to prevent
   * stale reads.
   *
   * `compute` must NOT call back into `append`/`appendComputed` for the
   * same `streamId`: the Promise-chain mutex is non-reentrant and a
   * recursive call deadlocks the chain. Side reads (e.g. backend queries)
   * are fine.
   */
  async appendComputed(
    streamId: string,
    idempotencyKey: string,
    compute: () => Promise<EventInput[]>,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    return this.locks.runExclusive(streamId, async () => {
      const events = await compute();
      return this.appendSqliteLocked(
        streamId,
        events,
        { idempotencyKey },
        options,
      );
    });
  }

  /**
   * R-2 primitive: load → fold → decide → append in one logical operation
   * with optimistic-concurrency control (OCC) baked in (Wave 3 / #1314).
   *
   * Pseudo-code (matches the design's R-2 §"decide" semantics):
   *
   *     state = reducer.initial
   *     events_read = backend.queryEvents(streamId)
   *     for each event: state = reducer.apply(state, event)
   *     tail = events_read.length === 0 ? 0 : events_read[last].sequence
   *     ctx = { streamId, version: tail, now: () => ISO }
   *     produced = await fn(state, ctx)
   *     if produced.length > 0:
   *         appendComputed(streamId, idemKey, () => produced,
   *                        { expectedSequence: tail })
   *     else if alwaysEnforceConsistency (default true):
   *         re-read tail; throw ConcurrencyError if advanced
   *     else:
   *         no-op success
   *
   * Failure translations performed at this layer (caller sees typed
   * exceptions, never the substrate's `AppendResult` failure variant):
   *
   *   - `sequence-conflict` → throw {@link ConcurrencyError}
   *     (OCC lost; caller must re-fetch state and re-decide).
   *   - `storage_busy` → throw {@link StorageBusyError}
   *     (substrate write-lock contention; caller may retry the SAME
   *     decision after backoff — the other writer commits on its own).
   *
   * Scope discipline: throws {@link InvalidReducerScopeError} when the
   * reducer's `scope` is not `'stream'`. The reducer must own the
   * aggregate's consistency boundary — global-scoped reducers belong to
   * `readProjection`, not `decide`.
   *
   * Idempotency (audit §F1.3): when `operationId` is supplied, derives
   * ONE key per call (`${streamId}:${reducerId}:${operationId}`) so all
   * N events from the decision commit in a single BEGIN IMMEDIATE
   * transaction. The substrate's `idempotency_claims` row already
   * supports multi-event claims via JSON-array columns
   * (sqlite-backend.ts:111-120), so a retried call hits the cache and
   * returns the canonical multi-event shape without re-committing.
   */
  async decide<TState>(
    streamId: string,
    reducerId: string,
    fn: (
      state: TState,
      ctx: DecideContext,
    ) => EventInput[] | Promise<EventInput[]>,
    opts?: DecideOptions,
  ): Promise<DecideResult> {
    // ─── Step 1: resolve + validate reducer scope ───────────────────────
    const reducer = this.resolveStreamReducer(reducerId, opts?.registry);

    // ─── Step 2: read events for fold (single SELECT — WAL snapshot) ───
    const backend = await this.ensureSqliteBackend();
    const events = backend.queryEvents(streamId);

    // ─── Step 3: fold via reducer.apply from initial state ─────────────
    let state: unknown = reducer.initial;
    for (const ev of events) {
      state = (reducer as ProjectionReducer<unknown, unknown>).apply(state, ev);
    }
    // Tail version: the highest sequence among the read events. An empty
    // stream has version 0 (substrate convention — sequences start at 1).
    const tailVersion =
      events.length === 0 ? 0 : (events[events.length - 1].sequence as number);

    // ─── Step 4: invoke the decide closure ─────────────────────────────
    const ctx: DecideContext = {
      streamId,
      version: tailVersion,
      now: () => new Date().toISOString(),
    };
    const produced = await fn(state as TState, ctx);

    // ─── Step 5: empty events → optional OCC re-check + return no-op ───
    if (produced.length === 0) {
      const alwaysEnforce = opts?.alwaysEnforceConsistency ?? true;
      if (alwaysEnforce) {
        const currentTail = backend.readSequenceHighWaterMark(streamId);
        if (currentTail !== tailVersion) {
          throw new ConcurrencyError({
            streamId,
            reducerId,
            expectedVersion: tailVersion,
            actualVersion: currentTail,
            operationId: opts?.operationId,
          });
        }
      }
      return {
        ok: true,
        kind: 'no-op',
        sequences: [],
        eventIds: [],
        timestamps: [],
      };
    }

    // ─── Step 6: commit via appendComputed with expectedSequence ───────
    const idemKey =
      opts?.operationId !== undefined
        ? `${streamId}:${reducerId}:${opts.operationId}`
        : `decide:${streamId}:${reducerId}:${randomUUID()}`;
    const result = await this.appendComputed(
      streamId,
      idemKey,
      async () => produced,
      { expectedSequence: tailVersion },
    );

    return this.translateDecideResult({
      result,
      streamId,
      reducerId,
      expectedVersion: tailVersion,
      operationId: opts?.operationId,
    });
  }

  /**
   * R-2 primitive: imperative escape-hatch for handlers that need to
   * call out to services mid-decision (Wave 3 Task 3.8).
   *
   * Reuses `decide`'s read+fold+OCC machinery; the difference is the
   * shape exposed to the closure: instead of `(state, ctx) => events`,
   * the closure receives a {@link Session} object with `aggregate`,
   * `version`, and an imperative `append(evt)` that queues events
   * for commit. After the closure resolves, all queued events commit
   * atomically with `expectedSequence: tail` so the OCC contract is
   * identical to `decide`'s.
   *
   * Idempotency-contract gate (audit §F1.1): rejects callers that
   * omit both `operationId` AND `allowNonIdempotent: true`. The gate
   * prevents retry storms from re-firing non-idempotent side effects
   * inside the closure on every `ConcurrencyError` retry.
   *
   * Failure translations:
   *   - Closure throws → original error propagates; nothing commits.
   *   - sequence-conflict → {@link ConcurrencyError}.
   *   - storage_busy → {@link StorageBusyError}.
   *   - Session captured + used after resolve → {@link SessionClosedError}.
   */
  async withSession<TState>(
    streamId: string,
    reducerId: string,
    fn: (session: Session<TState>, ctx: DecideContext) => Promise<void>,
    opts?: WithSessionOptions,
  ): Promise<DecideResult> {
    // ─── Step 0: idempotency-contract gate (audit §F1.1) ────────────────
    if (
      opts?.operationId === undefined &&
      opts?.allowNonIdempotent !== true
    ) {
      throw new InvalidSessionOptionsError();
    }

    // ─── Step 1: resolve + validate reducer scope ───────────────────────
    const reducer = this.resolveStreamReducer(reducerId, opts?.registry);

    // ─── Step 2: read events + fold ─────────────────────────────────────
    const backend = await this.ensureSqliteBackend();
    const events = backend.queryEvents(streamId);
    let state: unknown = reducer.initial;
    for (const ev of events) {
      state = (reducer as ProjectionReducer<unknown, unknown>).apply(state, ev);
    }
    const tailVersion =
      events.length === 0 ? 0 : (events[events.length - 1].sequence as number);

    // ─── Step 3: build the session ─────────────────────────────────────
    const pending: EventInput[] = [];
    let closed = false;
    const session: Session<TState> = {
      aggregate: state as TState,
      version: tailVersion,
      append(event: EventInput) {
        if (closed) {
          throw new SessionClosedError(streamId);
        }
        pending.push(event);
      },
    };

    const ctx: DecideContext = {
      streamId,
      version: tailVersion,
      now: () => new Date().toISOString(),
    };

    // ─── Step 4: invoke the closure ────────────────────────────────────
    try {
      await fn(session, ctx);
    } catch (err) {
      // Flip the session-closed flag so any later captured-session
      // append() throws SESSION_CLOSED instead of a confusing
      // post-throw mutation. Re-throw the original error verbatim.
      closed = true;
      throw err;
    }

    // ─── Step 5: close the session BEFORE the commit ──────────────────
    // (Task 3.10: append() after withSession resolves throws
    // SESSION_CLOSED. The commit happens after the session is closed
    // so a captured session is unusable in either ordering.)
    closed = true;

    // ─── Step 6: handle empty queue ────────────────────────────────────
    if (pending.length === 0) {
      const alwaysEnforce = opts?.alwaysEnforceConsistency ?? true;
      if (alwaysEnforce) {
        const currentTail = backend.readSequenceHighWaterMark(streamId);
        if (currentTail !== tailVersion) {
          throw new ConcurrencyError({
            streamId,
            reducerId,
            expectedVersion: tailVersion,
            actualVersion: currentTail,
            operationId: opts?.operationId,
          });
        }
      }
      return {
        ok: true,
        kind: 'no-op',
        sequences: [],
        eventIds: [],
        timestamps: [],
      };
    }

    // ─── Step 7: commit pending events via single-key-per-call idem ────
    const idemKey =
      opts?.operationId !== undefined
        ? `${streamId}:${reducerId}:${opts.operationId}`
        : `with-session:${streamId}:${reducerId}:${randomUUID()}`;
    const result = await this.appendComputed(
      streamId,
      idemKey,
      async () => pending,
      { expectedSequence: tailVersion },
    );

    return this.translateDecideResult({
      result,
      streamId,
      reducerId,
      expectedVersion: tailVersion,
      operationId: opts?.operationId,
    });
  }

  /**
   * R-2 primitive: read-only fold of a stream's events through a
   * registered reducer (Wave 3 Task 3.11). Marten's
   * `AggregateStreamAsync` analog.
   *
   * Returns the folded `aggregate` + the tail `version` at read time.
   * No write path, no OCC enforcement on a future commit — pure
   * observation. Callers that need read-then-decide-then-write must
   * route through `decide` or `withSession`.
   *
   * Scope validation: throws {@link InvalidReducerScopeError} when
   * `reducer.scope !== 'stream'` (Task 3.12). Global-scoped reducers
   * belong to `readProjection` (DR-1 / Wave 2A).
   *
   * **Snapshot stability discipline (audit §F2.3):**
   * Today's implementation is a single SELECT through
   * `backend.queryEvents(streamId)`. SQLite's WAL gives that one read
   * a consistent point-in-time snapshot via the read-txn's end-mark.
   *
   * If aggregateStream EVER grows a SECOND read inside its body
   * (e.g. a snapshot-row lookup, a sibling-aggregate join), those two
   * reads MUST be wrapped in `db.transaction(fn)` so they share one
   * snapshot — otherwise two implicit transactions could observe
   * different end-marks with a writer's commit between them, and the
   * fold would mix snapshot-T state with snapshot-T+1 events. This is
   * a forward-discipline note for v2.11+; Wave 3 ships single-SELECT.
   */
  async aggregateStream<TState>(
    streamId: string,
    reducerId: string,
    opts?: Pick<DecideOptions, 'registry'>,
  ): Promise<{ aggregate: TState; version: number }> {
    const reducer = this.resolveStreamReducer(reducerId, opts?.registry);
    const backend = await this.ensureSqliteBackend();
    const events = backend.queryEvents(streamId);
    let state: unknown = reducer.initial;
    for (const ev of events) {
      state = (reducer as ProjectionReducer<unknown, unknown>).apply(state, ev);
    }
    const tailVersion =
      events.length === 0 ? 0 : (events[events.length - 1].sequence as number);
    return { aggregate: state as TState, version: tailVersion };
  }

  /**
   * Translate a substrate {@link AppendResult} into the typed Wave-3
   * primitive shape — failure variants surface as thrown typed errors
   * (`ConcurrencyError`, `StorageBusyError`), success variants are
   * mirrored verbatim.
   *
   * Shared between `decide` and (Wave 3 Task 3.8) `withSession`, so the
   * `storage_busy → StorageBusyError` translation lives in exactly one
   * place per audit §F2.1.
   */
  private translateDecideResult(args: {
    result: AppendResult;
    streamId: string;
    reducerId: string;
    expectedVersion: number;
    operationId?: string;
  }): DecideResult {
    const { result, streamId, reducerId, expectedVersion, operationId } = args;
    if (result.ok) {
      return {
        ok: true,
        kind: result.kind,
        sequences: result.sequences,
        eventIds: result.eventIds,
        timestamps: result.timestamps,
      };
    }
    if (result.reason === 'sequence-conflict') {
      throw new ConcurrencyError({
        streamId,
        reducerId,
        expectedVersion: result.expected ?? expectedVersion,
        actualVersion: result.actual ?? expectedVersion,
        operationId,
      });
    }
    if (result.reason === 'storage_busy') {
      throw new StorageBusyError({
        streamId,
        attempts: STORAGE_BUSY_MAX_ATTEMPTS,
        cause: result.cause ?? new Error('SQLITE_BUSY'),
      });
    }
    // Any other reason (idempotency-claimed, io-error): re-throw the
    // underlying cause if present, else a generic typed error. These
    // should not happen in a well-formed decide() call — they indicate
    // either a programmer error (bad idem key reuse) or a substrate
    // failure (disk full, corrupt DB).
    if (result.cause) throw result.cause;
    throw new Error(`decide failed: ${result.reason}`);
  }

  /**
   * Resolve a reducer id against the supplied (or default) registry and
   * enforce `scope: 'stream'`. Shared by `decide` (Task 3.4) and
   * `aggregateStream` (Task 3.12).
   */
  private resolveStreamReducer(
    reducerId: string,
    registry?: ProjectionRegistry,
  ): ProjectionReducer<unknown, unknown> {
    const reg = registry ?? defaultRegistry;
    const reducer = reg.get(reducerId);
    if (!reducer) {
      throw new UnknownProjectionIdError(reducerId);
    }
    if (reducer.scope !== 'stream') {
      throw new InvalidReducerScopeError(reducerId, reducer.scope, {
        scope: 'stream',
      });
    }
    return reducer;
  }

  /**
   * Lazily create (or return) the SQLite backend used by the substrate
   * body. Injected backends (passed via `options.sqliteBackend`) are
   * returned without re-initialization — the injector owns the lifecycle.
   *
   * The owned-backend path opens `<stateDir>/<filename>` and applies
   * the standard schema DDL via `initialize()`. Failure here is fatal
   * for the substrate — the caller (appendSqliteLocked) catches and
   * returns an `io-error` AppendResult so the boundary contract holds.
   *
   * **Singleton via Promise cache (T63).** The legacy implementation
   * checked `if (!this.sqliteBackend)` then constructed and assigned —
   * race-prone because `runExclusive` only serializes per-stream, so
   * concurrent first-writes targeting different streams could both
   * pass the check and each construct a fresh handle. We now assign
   * `sqliteBackendPromise` synchronously before any await, so all
   * concurrent callers converge on a single in-flight Promise (and
   * therefore a single backend). The `sqliteBackend` field is also
   * populated when the Promise resolves so the synchronous accessor
   * `getSqliteBackend()` continues to work.
   *
   * Returns a Promise so future async-init steps (e.g. an awaited
   * migration or remote handle warm-up) plug in without reopening the
   * race window.
   */
  private async ensureSqliteBackend(): Promise<SqliteBackend> {
    if (this.sqliteBackendPromise) {
      return this.sqliteBackendPromise;
    }
    // Build and assign the in-flight Promise SYNCHRONOUSLY before
    // awaiting — this is the single point where the singleton
    // invariant is enforced. The async IIFE captures all init work
    // (current: sync construction + initialize; future: any awaited
    // step) inside one Promise that all concurrent callers share.
    const inflight = (async (): Promise<SqliteBackend> => {
      const dbPath = path.join(this.stateDir, this.sqliteDbFilename);
      const backend = new SqliteBackend(
        dbPath,
        this.synchronous ? { synchronous: this.synchronous } : {},
      );
      backend.initialize();
      this.sqliteBackend = backend;
      return backend;
    })();
    this.sqliteBackendPromise = inflight;
    try {
      return await inflight;
    } catch (err) {
      // Init failed — clear the cached Promise so a subsequent call
      // can retry from a clean slate. Without this, a transient init
      // failure would permanently poison the appender.
      this.sqliteBackendPromise = undefined;
      throw err;
    }
  }

  private async appendSqliteLocked(
    streamId: string,
    events: EventInput[],
    keyed: { idempotencyKey: string } | null,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    // ─── Phase 1: validate ──────────────────────────────────────────────
    if (!streamId || streamId.length === 0) {
      return { ok: false, reason: 'io-error', cause: new Error('streamId required') };
    }
    try {
      validateStreamId(streamId);
    } catch (err) {
      return { ok: false, reason: 'io-error', cause: toError(err) };
    }
    if (!Array.isArray(events) || events.length === 0) {
      return { ok: false, reason: 'io-error', cause: new Error('events must be non-empty array') };
    }
    if (keyed !== null && (!keyed.idempotencyKey || keyed.idempotencyKey.length === 0)) {
      return { ok: false, reason: 'io-error', cause: new Error('idempotencyKey required') };
    }

    // ─── Phase 2: ensure backend is available ────────────────────────────
    let backend: SqliteBackend;
    try {
      // Ensure the directory exists so tests passing fresh tmp dirs don't
      // fail before the DB file is touched.
      await fs.mkdir(this.stateDir, { recursive: true });
      // Lazy SQLite backend init — Promise-cached singleton (T63).
      // Concurrent first-writes across distinct streams converge on a
      // single backend handle even if init grows an awaited step.
      backend = await this.ensureSqliteBackend();
    } catch (err) {
      return { ok: false, reason: 'io-error', cause: toError(err) };
    }

    // ─── Phase 3: idempotency cache-hit (pre-transaction short-circuit) ──
    // The cache lookup runs OUTSIDE the BEGIN IMMEDIATE so retries don't
    // hold the write lock.
    if (keyed !== null) {
      try {
        const claim = backend.lookupIdempotencyClaim(streamId, keyed.idempotencyKey);
        if (claim) {
          return {
            ok: true,
            kind: 'cache-hit',
            sequences: claim.sequences,
            eventIds: claim.eventIds,
            timestamps: claim.timestamps,
            persistedEvents: claim.events.map(e => ({ ...e } as PublicPersistedEvent)),
          };
        }
      } catch (err) {
        return { ok: false, reason: 'io-error', cause: toError(err) };
      }
    }

    // ─── Phase 4: stream-version gate + commit, all inside one txn ───────
    // Sequence allocation and the OCC check now live INSIDE the substrate's
    // BEGIN IMMEDIATE (see SqliteBackend.allocateSequence). We no longer
    // read the high-water mark out here and pre-compute `baseSeq + i` — that
    // pre-transaction read was the TOCTOU window the gate eliminates.
    //
    // `finalize(base)` runs inside the txn and builds the authoritative
    // PersistedEvent rows (sequence = base + i + 1), the wire events, and
    // the idempotency claim from the gate-assigned base. It captures
    // `persisted` in this closure so the AppendResult can be built after the
    // commit. It is cheap and side-effect-free (UUID/timestamp/JSON only).
    let persisted: PersistedEvent[] = [];
    const finalize = (base: number): {
      events: SqliteAtomicAppendEvent[];
      claim?: {
        eventIds: string[];
        sequences: number[];
        timestamps: string[];
        events_json: string;
      };
    } => {
      persisted = events.map((evt, i) => {
        const event: PersistedEvent = {
          ...evt,
          streamId,
          sequence: base + i + 1,
          timestamp: evt.timestamp ?? new Date().toISOString(),
          type: evt.type,
          eventId: randomUUID(),
        };
        if (keyed !== null) {
          event.idempotencyKey = keyed.idempotencyKey;
        }
        return event;
      });

      // #1437 — surface the three dispatch-context correlation IDs onto the
      // wire shape so `insertEventStrict` populates the V6 indexed columns.
      // INV-1 holds: payload JSON stays authoritative; columns are the
      // indexed filter handle.
      const wireEvents: SqliteAtomicAppendEvent[] = persisted.map(e => ({
        sequence: e.sequence,
        type: e.type,
        timestamp: e.timestamp,
        data: e.data,
        payload: JSON.stringify(e),
        ...(typeof e.operationId === 'string' ? { operationId: e.operationId } : {}),
        ...(typeof e.correlationId === 'string' ? { correlationId: e.correlationId } : {}),
        ...(typeof e.causationId === 'string' ? { causationId: e.causationId } : {}),
      }));

      const claim =
        keyed !== null
          ? {
              eventIds: persisted.map(e => e.eventId),
              sequences: persisted.map(e => e.sequence),
              timestamps: persisted.map(e => e.timestamp),
              events_json: JSON.stringify(persisted),
            }
          : undefined;

      return { events: wireEvents, ...(claim ? { claim } : {}) };
    };

    try {
      await backend.atomicAppend({
        streamId,
        idempotencyKey: keyed?.idempotencyKey ?? null,
        n: events.length,
        ...(options?.expectedSequence !== undefined
          ? { expectedSequence: options.expectedSequence }
          : {}),
        finalize,
      });
    } catch (err) {
      // SqliteBusyExhaustedError — the substrate's bounded SQLITE_BUSY retry
      // budget expired; surface the transient `storage_busy` reason.
      if (err instanceof SqliteBusyExhaustedError) {
        return { ok: false, reason: 'storage_busy', cause: err };
      }
      // SequenceGateConflictError — a genuine OCC mismatch from the
      // in-transaction gate. It carries the real expected/actual directly,
      // so there is no re-read and no regex translation.
      if (err instanceof SequenceGateConflictError) {
        return {
          ok: false,
          reason: 'sequence-conflict',
          expected: err.expected,
          actual: err.actual,
        };
      }
      const e = toError(err);
      // Any other thrown error (double-claim race, or a genuine `events`
      // PRIMARY KEY anomaly) is routed through the backstop translator.
      return this.translateAtomicAppendError({
        error: e,
        backend,
        streamId,
        keyed,
      });
    }

    return {
      ok: true,
      kind: 'committed',
      sequences: persisted.map(e => e.sequence),
      eventIds: persisted.map(e => e.eventId),
      timestamps: persisted.map(e => e.timestamp),
    };
  }

  /**
   * Backstop translator for an `atomicAppend` throw that is NOT a
   * `SequenceGateConflictError` (handled directly by the caller) and NOT a
   * `SqliteBusyExhaustedError`. Two cases remain:
   *
   *   - **Double-claim race** (`UNIQUE constraint failed: idempotency_claims`):
   *     two appenders raced the same idempotency key. The winner committed a
   *     canonical claim row; re-read it and surface those events as a
   *     cache-hit so the loser returns the actually-persisted shape.
   *
   *   - **`events` PRIMARY KEY violation** (`UNIQUE constraint failed: events`):
   *     under the stream-version gate this is a genuine integrity ANOMALY,
   *     not a concurrency conflict — the gate guarantees a free slot, so a
   *     collision means something else corrupted the sequence. Surface it as
   *     `io-error` with the cause (DR-6) rather than re-mapping it to a
   *     `sequence-conflict` (which the gate now owns) or a cache-hit.
   *
   * If the claim re-read itself fails, downgrade gracefully to the bare
   * error so the caller still sees a typed failure.
   */
  private translateAtomicAppendError(args: {
    error: Error;
    backend: SqliteBackend;
    streamId: string;
    keyed: { idempotencyKey: string } | null;
  }): AppendResult {
    const { error, backend, streamId, keyed } = args;
    const msg = error.message;
    const isIdempotencyConflict =
      /UNIQUE constraint failed: idempotency_claims/.test(msg) ||
      /idempotency_claims.streamId, idempotency_claims.idempotencyKey/.test(msg);

    if (isIdempotencyConflict && keyed !== null) {
      // Re-read the now-committed claim. The race winner inserted a
      // canonical row — surface those events as a cache-hit so the
      // caller returns the actually-persisted shape.
      try {
        const claim = backend.lookupIdempotencyClaim(streamId, keyed.idempotencyKey);
        if (claim) {
          return {
            ok: true,
            kind: 'cache-hit',
            sequences: claim.sequences,
            eventIds: claim.eventIds,
            timestamps: claim.timestamps,
            persistedEvents: claim.events.map(e => ({ ...e } as PublicPersistedEvent)),
          };
        }
        // No claim found despite the conflict — race window between
        // the conflict and our re-read (e.g. a rollback). Fall
        // through to the bare `idempotency-claimed` shape so the
        // caller still sees a typed failure.
      } catch {
        // Re-read itself failed — fall through to the bare error
        // rather than escaping a second exception through the
        // boundary.
      }
      return { ok: false, reason: 'idempotency-claimed', cause: error };
    }

    // Genuine `events` PK anomaly (or any other unrecognized SQLite error):
    // surface as io-error. The gate prevents concurrency-induced sequence
    // collisions, so reaching here on an events-PK violation is a bug or
    // external corruption, not a retryable conflict.
    return { ok: false, reason: 'io-error', cause: error };
  }

  /**
   * Public access to the SQLite backend used by the substrate body.
   *
   * Production read paths (e.g. `EventStore.getReadBackend()`) call this
   * to converge on the single backend handle the appender owns. Tests
   * inject faults via `Object.defineProperty` on the underlying driver
   * methods — exposing the backend lets fixtures patch a single
   * statement without reconstructing the appender's internals.
   *
   * Returns undefined when no append has happened yet AND
   * `ensureSqliteBackendSync()` has not been called. Read callers that
   * need to converge on the same handle as writers (without scheduling
   * a write) should use `ensureSqliteBackendSync()` to force lazy init.
   */
  getSqliteBackend(): SqliteBackend | undefined {
    return this.sqliteBackend;
  }

  /**
   * Force-eager construction of the owned SQLite backend.
   *
   * Read paths that need to query the substrate WITHOUT first issuing
   * a write (e.g. `EventStore.query()` on a freshly-constructed store
   * pointing at an existing on-disk database) call this to make the
   * SQLite handle observable via `getSqliteBackend()`. The lazy-init
   * inside `appendSqliteLocked` covers the write-then-read case; this
   * covers the read-before-write case.
   *
   * Synchronous: SqliteBackend's constructor + `initialize()` are both
   * synchronous. If a future async-init step is added, this method
   * stays sync by deferring that step into the `ensureSqliteBackend()`
   * Promise — the call is a no-op when the backend has already been
   * constructed.
   */
  ensureSqliteBackendSync(): SqliteBackend {
    if (this.sqliteBackend) return this.sqliteBackend;
    // Ensure the state dir exists before opening the DB (matches the
    // mkdir performed inside the async write path so read-before-write
    // callers don't ENOENT against a fresh tmp dir).
    mkdirSync(this.stateDir, { recursive: true });
    const dbPath = path.join(this.stateDir, this.sqliteDbFilename);
    // DR-4: thread the configured durability posture into the lazily-created
    // backend, mirroring the async `ensureSqliteBackend()` path. Without this,
    // a read-before-write sequence (which forces lazy init here and caches the
    // result as the singleton) pinned the handle to NORMAL even when FULL was
    // configured, and the later write reused that NORMAL backend.
    const backend = new SqliteBackend(
      dbPath,
      this.synchronous ? { synchronous: this.synchronous } : {},
    );
    backend.initialize();
    this.sqliteBackend = backend;
    // Pre-populate the Promise cache so any concurrent async path
    // (`ensureSqliteBackend` from `appendSqliteLocked`) converges on
    // this handle — singleton invariant unchanged.
    this.sqliteBackendPromise = Promise.resolve(backend);
    return backend;
  }

  /**
   * Release the owned SQLite backend handle.
   *
   * Idempotent and synchronous. Closes the lazily-constructed
   * {@link SqliteBackend} (releasing the `exarchos.db` / `-wal` / `-shm` OS
   * file handles) and clears the cached references so any subsequent
   * operation re-opens a fresh handle.
   *
   * Primarily a test-lifecycle affordance: on Windows an open SQLite handle
   * blocks `fs.rm` of the containing temp dir with EPERM/EBUSY, because NTFS —
   * unlike POSIX — forbids unlinking a file that still has an open handle.
   * Closing the appender before teardown is the portable cleanup contract.
   */
  close(): void {
    this.sqliteBackend?.close();
    this.sqliteBackend = undefined;
    this.sqliteBackendPromise = undefined;
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

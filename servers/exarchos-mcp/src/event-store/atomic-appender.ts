import * as fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { validateStreamId } from '../shared/validation.js';
import {
  SqliteBackend,
  SqliteBusyExhaustedError,
  type AtomicAppendEvent as SqliteAtomicAppendEvent,
} from '../storage/sqlite-backend.js';

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

  constructor(options: AtomicAppenderOptions) {
    this.stateDir = options.stateDir;
    this.sqliteDbFilename = options.sqliteDbFilename ?? 'exarchos.db';
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
  ): Promise<AppendResult> {
    return this.locks.runExclusive(streamId, async () => {
      const events = await compute();
      return this.appendSqliteLocked(streamId, events, { idempotencyKey });
    });
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
      const backend = new SqliteBackend(dbPath);
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

    // ─── Phase 4: optimistic-concurrency check ───────────────────────────
    // Read the current high-water mark from the sequences table. Mismatch
    // returns the typed `sequence-conflict` shape; the caller translates
    // to its own error type without reaching into substrate internals.
    let baseSeq: number;
    try {
      baseSeq = backend.readSequenceHighWaterMark(streamId);
    } catch (err) {
      return { ok: false, reason: 'io-error', cause: toError(err) };
    }
    if (options?.expectedSequence !== undefined) {
      if (baseSeq !== options.expectedSequence) {
        return {
          ok: false,
          reason: 'sequence-conflict',
          expected: options.expectedSequence,
          actual: baseSeq,
        };
      }
    }

    // ─── Phase 5: build PersistedEvent rows ──────────────────────────────
    const persisted: PersistedEvent[] = events.map((evt, i) => {
      const event: PersistedEvent = {
        ...evt,
        streamId,
        sequence: baseSeq + i + 1,
        timestamp: evt.timestamp ?? new Date().toISOString(),
        type: evt.type,
        eventId: randomUUID(),
      };
      if (keyed !== null) {
        event.idempotencyKey = keyed.idempotencyKey;
      }
      return event;
    });

    const wireEvents: SqliteAtomicAppendEvent[] = persisted.map(e => ({
      sequence: e.sequence,
      type: e.type,
      timestamp: e.timestamp,
      data: e.data,
      payload: JSON.stringify(e),
    }));

    // ─── Phase 6: BEGIN IMMEDIATE (idempotency claim + events + sequence) ─
    try {
      const claim =
        keyed !== null
          ? {
              eventIds: persisted.map(e => e.eventId),
              sequences: persisted.map(e => e.sequence),
              timestamps: persisted.map(e => e.timestamp),
              events_json: JSON.stringify(persisted),
            }
          : undefined;
      await backend.atomicAppend({
        streamId,
        idempotencyKey: keyed?.idempotencyKey ?? null,
        events: wireEvents,
        ...(claim ? { claim } : {}),
      });
    } catch (err) {
      // Translate SQLite errors into the typed AppendResult shape.
      // SQLITE_CONSTRAINT on idempotency_claims = double-claim race
      // (two appenders with the same key — the loser sees this); the
      // first-tier Promise mutex normally prevents this within a process,
      // but cross-process or driver-level races can still surface it.
      // SqliteBusyExhaustedError is the typed marker raised by the
      // substrate's bounded SQLITE_BUSY retry loop (T09, DR-12) —
      // translate it to the public `storage_busy` reason without
      // re-inspecting the original SQLite error code.
      if (err instanceof SqliteBusyExhaustedError) {
        return { ok: false, reason: 'storage_busy', cause: err };
      }
      const e = toError(err);
      // T64: pre-preflight values (`baseSeq`, our just-built `persisted`)
      // are STALE if a concurrent writer slipped in between the
      // preflight read and `atomicAppend`. Translation must re-read
      // durable state from the backend so the loser's AppendResult
      // reflects the canonical post-conflict shape.
      return this.translateAtomicAppendError(
        e,
        backend,
        streamId,
        keyed,
        options,
        baseSeq,
      );
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
   * Translate an `atomicAppend` failure into the typed `AppendResult`
   * shape using FRESH durable reads (T64).
   *
   * The legacy translation reused the pre-preflight values (the
   * just-allocated `persisted` rows for the idempotency-claim branch
   * and `baseSeq` for the sequence-conflict branch). Both are stale
   * once the conflict has fired — by definition, another writer
   * advanced the durable state between the preflight read and
   * `atomicAppend`. Returning stale values handed callers the wrong
   * canonical shape:
   *
   *   - `idempotency-claimed` lost the WINNER's persisted events. The
   *     contract is to surface the events ACTUALLY persisted under
   *     the key, so the caller returns the canonical shape to its own
   *     caller without reconstructing from the (possibly different)
   *     current request.
   *
   *   - `sequence-conflict` reported `actual: baseSeq`. The actual
   *     value is now the WINNER's high-water mark, so retrying against
   *     `baseSeq` would just re-trigger the same conflict.
   *
   * Re-reads `lookupIdempotencyClaim` and (as a fallback) the
   * sequence high-water mark to derive the canonical post-conflict
   * shape. If the re-read itself fails (corrupt DB, lost connection),
   * downgrades gracefully to the original error so the caller still
   * sees a typed failure rather than an opaque exception.
   */
  private translateAtomicAppendError(
    error: Error,
    backend: SqliteBackend,
    streamId: string,
    keyed: { idempotencyKey: string } | null,
    options: AppendOptions | undefined,
    preflightBaseSeq: number,
  ): AppendResult {
    const msg = error.message;
    const isIdempotencyConflict =
      /UNIQUE constraint failed: idempotency_claims/.test(msg) ||
      /idempotency_claims.streamId, idempotency_claims.idempotencyKey/.test(msg);
    const isSequenceConflict =
      /UNIQUE constraint failed: events/.test(msg) ||
      /events.streamId, events.sequence/.test(msg);

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

    if (isSequenceConflict) {
      // Re-read the high-water mark so the caller's retry computes
      // against the WINNER's advanced sequence, not our pre-preflight
      // value. On re-read failure, fall back to the preflight value
      // (better than nothing — the caller still sees `sequence-conflict`
      // and can retry).
      let actual = preflightBaseSeq;
      try {
        actual = backend.readSequenceHighWaterMark(streamId);
      } catch {
        // Keep `actual = preflightBaseSeq`.
      }
      return {
        ok: false,
        reason: 'sequence-conflict',
        expected: options?.expectedSequence,
        actual,
      };
    }

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
    const backend = new SqliteBackend(dbPath);
    backend.initialize();
    this.sqliteBackend = backend;
    // Pre-populate the Promise cache so any concurrent async path
    // (`ensureSqliteBackend` from `appendSqliteLocked`) converges on
    // this handle — singleton invariant unchanged.
    this.sqliteBackendPromise = Promise.resolve(backend);
    return backend;
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

import { createHash, randomUUID as randomUUIDFn } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { WorkflowEventBase } from './schemas.js';
import type { WorkflowEvent } from './schemas.js';
import type { StorageBackend } from '../storage/backend.js';
import { validateStreamId } from '../contract/shared/validation.js';
import { AtomicAppender } from './atomic-appender.js';
import { migrateEvents } from './event-migration.js';
import { getDispatchContext } from '../dispatch/dispatch-context.js';
import {
  SubscriptionRegistry,
  type SubscribeOptions,
  type SubscriptionEventReader,
  type SubscriptionFilter,
  type SubscriptionHandle,
  type SubscriptionListener,
  type SubscriptionRegistryOptions,
} from './subscriptions.js';

// ─── #1291 — Dispatch-boundary correlation stamping ─────────────────────────
//
// When an `EventStore.append*` call lands during an active dispatch (i.e.
// `getDispatchContext()` returns a non-undefined context), stamp the three
// correlation IDs onto the event input UNLESS the caller has already
// supplied that field explicitly (callers retain final authority — useful
// for migration/recovery code that reuses a prior dispatch's IDs).
//
// The stamp is a non-mutating shallow merge: if the dispatch context
// supplies `correlationId` but the caller's event already carries
// `correlationId: 'my-feature-id'` (e.g. the workflow.started path that
// uses featureId as the correlation anchor), the caller's value wins.
function stampWithDispatchContext<T extends {
  correlationId?: string | undefined;
  causationId?: string | undefined;
  operationId?: string | undefined;
}>(event: T): T {
  const ctx = getDispatchContext();
  if (ctx === undefined) return event;
  // Non-mutating: build a new object only if at least one field would
  // change. Callers append events with a freshly-constructed literal in
  // most paths so allocation overhead is negligible.
  const needsOperation = event.operationId === undefined;
  const needsCorrelation = event.correlationId === undefined;
  const needsCausation = event.causationId === undefined && ctx.causationId !== undefined;
  if (!needsOperation && !needsCorrelation && !needsCausation) return event;
  return {
    ...event,
    ...(needsOperation ? { operationId: ctx.operationId } : {}),
    ...(needsCorrelation ? { correlationId: ctx.correlationId } : {}),
    ...(needsCausation ? { causationId: ctx.causationId } : {}),
  };
}

// ─── Sequence Conflict Error ────────────────────────────────────────────────

export class SequenceConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Sequence conflict: expected ${expected}, actual ${actual}`,
    );
    this.name = 'SequenceConflictError';
  }
}

// ─── Append Options ─────────────────────────────────────────────────────────

export interface AppendOptions {
  expectedSequence?: number | undefined;
  idempotencyKey?: string | undefined;
}

// ─── Query Filters ──────────────────────────────────────────────────────────

export interface QueryFilters {
  type?: string | undefined;
  sinceSequence?: number | undefined;
  since?: string | undefined;
  until?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /**
   * Cross-stream prefix filter (DR-3, design 2026-05-08-durable-event-store-substrate).
   *
   * When set, the query matches events whose `streamId` is exactly the prefix
   * OR a descendant under the namespaced form `<prefix>/<segment>`. Substring
   * matches (`<prefix>-extra`) are EXCLUDED — the comparison is structural,
   * not lexical. Used by `EventStore.queryByType` to reduce over events
   * across an entire feature's namespace.
   *
   * Honoured at the SQL/backend layer (`SqliteBackend.queryEventsByType`).
   */
  streamPrefix?: string;
  /** Filter to events stamped with this operationId (single dispatch boundary). */
  operationId?: string;
  /** Filter to events stamped with this correlationId (workflow/wave). */
  correlationId?: string;
  /** Filter to events stamped with this causationId (causal predecessor). */
  causationId?: string;
}

// ─── Event Store Options ────────────────────────────────────────────────────

export interface EventStoreOptions {
  backend?: StorageBackend | undefined;
  /**
   * Durability posture (DR-4) threaded to the lazily-constructed
   * AtomicAppender → SqliteBackend (`PRAGMA synchronous`). Resolved from
   * `.exarchos.yml` `storage.synchronous` by the lifecycle wiring. Omitted →
   * `'normal'` (unchanged default).
   */
  synchronous?: 'normal' | 'full' | undefined;
}

// ─── Integrity Result ───────────────────────────────────────────────────────

/**
 * Discriminated result of `EventStore.runIntegrityCheck`.
 *
 * The three branches are mutually exclusive by the `ok` tag so callers
 * (notably the doctor `storage-sqlite-health` check) can map to a
 * `CheckResult` status without type assertions (DIM-3):
 *   - `{ ok: true }`             → backend reports healthy
 *   - `{ ok: 'skipped', reason }` → backend without `runIntegrityPragma`
 *     (e.g., InMemoryBackend in test fixtures)
 *   - `{ ok: false, details }`   → backend reported corruption, or the
 *     probe exceeded its configured timeout
 */
export type IntegrityResult =
  | { ok: true }
  | { ok: false; details: string }
  | { ok: 'skipped'; reason: string };

/** Default upper bound on `runIntegrityCheck` wall time. */
const DEFAULT_INTEGRITY_TIMEOUT_MS = 2000;

// ─── Event Store ────────────────────────────────────────────────────────────

/**
 * Append-only event store backed by SQLite (substrate-cut, v2.11).
 *
 * Reads and writes both flow through the appender's owned `SqliteBackend`
 * — `getReadBackend()` always returns it, and `getAppender()` writes
 * through the same handle. The legacy JSONL read/write path was removed
 * in Phase 3; the optional `backend` constructor option is retained only
 * for tests that inject an `InMemoryBackend` to drive read-path
 * assertions.
 *
 * Cross-process safety: cross-process serialization is delegated entirely
 * to the SQLite WAL substrate. `BEGIN IMMEDIATE` is the write-ownership
 * primitive — a writer that observes the database busy retries through
 * SQLite's own backoff rather than a process-level mutex — and the
 * `(stream_id, sequence)` PRIMARY KEY guarantees per-stream append
 * ordering and rejects duplicate-sequence writes. Multiple `EventStore`
 * instances may attach to the same `stateDir` from any number of OS
 * processes; `initialize()` is an idempotent no-op marker.
 *
 * In-process: the AtomicAppender owns a per-stream promise-chain lock
 * (`StreamLockManager`) that serialises concurrent appends to the same
 * stream from the same Node.js process; cross-process appends serialise
 * through the substrate.
 */
export class EventStore {
  /**
   * After the #1293 consumer migration, all append paths delegate to a
   * single shared AtomicAppender (see `getAppender()` below). The previous
   * per-EventStore lock map, sequence counter map, and idempotency cache
   * are removed — they were the second of two disjoint write paths that
   * raced on the same JSONL files. The AtomicAppender now owns:
   *   - per-stream lock (`StreamLockManager`)
   *   - sequence counter (rebuilt from JSONL on first contact)
   *   - idempotency cache (with `appendUnkeyed` for callers that don't
   *     want dedup — preserves the legacy "no-key-skips-dedup" contract
   *     without polluting the cache with synthetic one-shot keys)
   *
   * #1259 swap point: `getAppender()` returns the substrate. Replacing
   * `new AtomicAppender(...)` with `new SqliteAppender(...)` in that
   * lazy-construction site is the only change SQLite migration requires
   * at the EventStore boundary.
   */

  /** Whether initialize() has been called */
  private initialized = false;

  /** Optional storage backend for delegating reads */
  private readonly backend?: StorageBackend | undefined;

  /** Lazily-instantiated AtomicAppender — single instance per stateDir so per-stream
   *  locks and sequence counters share state across handler calls. */
  private atomicAppender?: AtomicAppender | undefined;

  /** Durability posture threaded to the lazily-created appender (DR-4). */
  private synchronous?: 'normal' | 'full' | undefined;

  /**
   * DR-1 subscription registry (#1315). Lazily created on the first
   * `subscribe()` call so the append hot path pays nothing until a
   * subscription exists — the Tier-1 commit hook on the appender is wired at
   * the same moment, leaving `appendSqliteLocked` a single `undefined` guard
   * on the zero-subscriber path.
   */
  private subscriptions?: SubscriptionRegistry | undefined;

  constructor(private readonly stateDir: string, options?: EventStoreOptions) {
    this.backend = options?.backend;
    this.synchronous = options?.synchronous;
  }

  /**
   * Set the storage durability posture (DR-4) AFTER construction. The
   * production lifecycle builds the EventStore before `.exarchos.yml` is
   * loaded, so the resolved `storage.synchronous` is applied here before the
   * first append. It is honoured only by the lazily-created appender; once
   * the backend handle exists the pragma is already fixed, so a late call
   * (after the first write) is a no-op against the live connection.
   */
  setStorageDurability(synchronous: 'normal' | 'full'): void {
    this.synchronous = synchronous;
  }

  /** Returns the state directory path used by this event store. */
  get dir(): string {
    return this.stateDir;
  }

  /**
   * Returns the lazily-created AtomicAppender bound to this event store's
   * state directory. Single instance per EventStore so per-stream locks and
   * the in-memory sequence/idempotency caches share state across consumers.
   *
   * #1259 swap point: replace the constructor call below with a SQLite
   * (or other durable) appender that exposes the same `AppendResult`
   * shape and per-stream serialization semantics. No other change is
   * required — `append`, `appendValidated`, and `batchAppend` all delegate
   * through this instance, so a one-line swap here flips the entire write
   * substrate. The migration doc is at
   * docs/designs/archive/2026-05-08-eventstore-appender-consumer-migration.md.
   */
  getAppender(): AtomicAppender {
    if (!this.atomicAppender) {
      this.atomicAppender = new AtomicAppender({
        stateDir: this.stateDir,
        ...(this.synchronous ? { synchronous: this.synchronous } : {}),
      });
    }
    return this.atomicAppender;
  }

  /**
   * Resolve the read-delegate `StorageBackend` for this store.
   *
   * v2.11 Phase 3 (substrate-cut, store collapse): SQLite is the only
   * substrate. The legacy "no-backend → JSONL fallback" branch and the
   * lazy `appenderBackend: 'sqlite'` selector were removed; reads always
   * flow through the appender's owned `SqliteBackend` (force-eager via
   * `ensureSqliteBackendSync()`). Resolves Sentry blocker r3213774862
   * from #1323 (read-before-write returning `[]`).
   *
   * The explicit `backend` constructor option is preserved as a test
   * affordance: fixtures inject an `InMemoryBackend` to drive read-path
   * assertions without touching the disk. In production no caller sets
   * it.
   */
  getReadBackend(): StorageBackend {
    if (this.backend) return this.backend;
    return this.getAppender().ensureSqliteBackendSync();
  }

  // ─── Initialize ────────────────────────────────────────────────────────────

  /**
   * Initialize the event store. Must be called before first use, but is
   * an idempotent no-op marker — repeat calls return immediately.
   *
   * Pre-Wave-A this method acquired a per-`stateDir` PID lock so that only
   * one OS process at a time could attach to a given event store. That
   * contract was removed in #1343 (Wave A): cross-process serialization is
   * delegated to the SQLite WAL substrate (`BEGIN IMMEDIATE` for write
   * ownership; the `(stream_id, sequence)` PRIMARY KEY for per-stream
   * append ordering). Two or more `EventStore` instances against the same
   * `stateDir` may now `initialize()` concurrently and proceed to append
   * without further coordination at this layer; see
   * `docs/architecture/runtime.md` §4.
   *
   * The lock acquisition previously had a side-effect of creating
   * `stateDir`; with that removed we explicitly `mkdir -p` here so
   * downstream backends and the storage-state-dir doctor probe both see
   * the directory on first run.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.stateDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Release the storage handles held by this store.
   *
   * Idempotent and synchronous. Closes the lazily-created AtomicAppender's
   * SQLite backend (and any injected read backend), releasing the
   * `exarchos.db` / `-wal` / `-shm` OS file handles.
   *
   * This is the portable test-teardown contract: on Windows (NTFS) an open
   * SQLite handle blocks `fs.rm` of the temp `stateDir` with EPERM/EBUSY,
   * whereas POSIX permits unlinking an open file. A test that constructs an
   * EventStore against a temp directory MUST `close()` it before removing
   * that directory. Closing does not affect durability — every append is
   * already committed to the WAL substrate before its promise resolves
   * (INV-1); `close()` only releases the live connection.
   */
  close(): void {
    // Dispose every live subscription (INV-15) and detach the Tier-1 hook
    // before the appender goes away.
    this.subscriptions?.disposeAll();
    this.atomicAppender?.setCommitHook(undefined);
    this.subscriptions = undefined;
    this.atomicAppender?.close();
    this.atomicAppender = undefined;
    this.backend?.close();
    this.initialized = false;
  }

  async append(
    streamId: string,
    event: Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string },
    options?: AppendOptions,
  ): Promise<WorkflowEvent> {
    // Validate FIRST, before delegating: the legacy contract throws synchronously
    // on schema violations, so callers don't need to await the AtomicAppender
    // round-trip for that error class.
    const idempotencyKey = options?.idempotencyKey ?? event.idempotencyKey;
    const timestamp = event.timestamp || new Date().toISOString();
    // #1291 — stamp the three correlation IDs from the active dispatch
    // context when not already supplied by the caller. The stamp lands
    // BEFORE Zod parse so the validated shape is byte-identical to a
    // caller-supplied triple.
    const stamped = stampWithDispatchContext(event);
    // Sequence is allocated by AtomicAppender; pass a placeholder so Zod's
    // positive-integer guard accepts the schema. The synthesized return value
    // overwrites this with the authoritative sequence.
    const candidate = WorkflowEventBase.parse({
      ...stamped,
      streamId,
      sequence: 1,
      timestamp,
      idempotencyKey,
    });
    return this.delegateAppend(streamId, candidate, idempotencyKey, options);
  }

  /**
   * Append a pre-validated event to the stream, skipping Zod validation.
   * Use when the caller has already validated the event at the system boundary
   * via buildValidatedEvent(). This avoids redundant Zod parsing on the hot path.
   */
  async appendValidated(
    streamId: string,
    event: WorkflowEvent,
    options?: AppendOptions,
  ): Promise<WorkflowEvent> {
    const idempotencyKey = options?.idempotencyKey ?? event.idempotencyKey;
    const timestamp = event.timestamp || new Date().toISOString();
    // #1291 — pre-validated callers (rehydrate, HSM guard) opt into the
    // same dispatch-context stamping. `buildValidatedEvent` ran on the
    // caller side; the post-stamp triple is a strict widening of optional
    // fields, so it never invalidates the upstream validation.
    const stamped = stampWithDispatchContext(event) as WorkflowEvent;
    const prepared: WorkflowEvent = {
      ...stamped,
      streamId,
      timestamp,
      idempotencyKey,
    } as WorkflowEvent;
    return this.delegateAppend(streamId, prepared, idempotencyKey, options);
  }

  /**
   * Shared post-validation path: delegate to AtomicAppender, translate the
   * typed result back into the legacy `WorkflowEvent` return shape.
   *
   * v2.11 substrate-cut (Phase 2) removed the supplementary
   * `replicateBackend` / `writeOutbox` dual-write paths. The AtomicAppender's
   * SQLite transaction is the single durable substrate; there is no
   * post-lock replication step.
   */
  private async delegateAppend(
    streamId: string,
    event: WorkflowEvent,
    idempotencyKey: string | undefined,
    options?: AppendOptions,
  ): Promise<WorkflowEvent> {
    const appender = this.getAppender();
    const appendOptions =
      options?.expectedSequence !== undefined
        ? { expectedSequence: options.expectedSequence }
        : undefined;
    // Strip mutable scaffolding fields that AtomicAppender re-derives.
    // sequence + eventId come back from the appender; streamId + timestamp +
    // idempotencyKey are passed through verbatim because we already pinned
    // them above.
    const { sequence: _ignoredSeq, ...eventInputBase } = event as WorkflowEvent & { sequence?: number };
    const result = idempotencyKey
      ? await appender.append(streamId, [eventInputBase], idempotencyKey, appendOptions)
      : await appender.appendUnkeyed(streamId, [eventInputBase], appendOptions);

    if (!result.ok) {
      if (result.reason === 'sequence-conflict') {
        throw new SequenceConflictError(
          result.expected ?? options?.expectedSequence ?? -1,
          result.actual ?? -1,
        );
      }
      throw result.cause ?? new Error(`Append failed: ${result.reason}`);
    }

    // Cache-hit branch: return the originally-persisted event verbatim. The
    // SQLite substrate already holds the canonical row; the request payload
    // is irrelevant to the returned shape (the bug CR-thread #3205805943
    // closes — historically a retry with a different payload could have
    // re-fired backend/outbox dual-writes; v2.11 removed those paths).
    if (result.kind === 'cache-hit') {
      const cached = result.persistedEvents[0];
      if (cached === undefined) {
        throw new Error('Append cache-hit reported no persisted event');
      }
      return {
        streamId: cached.streamId,
        sequence: cached.sequence,
        type: cached.type,
        timestamp: cached.timestamp,
        ...(cached.idempotencyKey !== undefined ? { idempotencyKey: cached.idempotencyKey } : {}),
        ...(cached.data !== undefined ? { data: cached.data } : {}),
        ...(cached.correlationId !== undefined ? { correlationId: cached.correlationId } : {}),
        ...(cached.causationId !== undefined ? { causationId: cached.causationId } : {}),
        // #1291 — three-field correlation passthrough. Cached events are
        // returned verbatim so the second call to a retry surfaces the
        // same operationId/correlation chain the first call persisted.
        ...((cached as { operationId?: string }).operationId !== undefined
          ? { operationId: (cached as { operationId?: string }).operationId }
          : {}),
        ...(cached.agentId !== undefined ? { agentId: cached.agentId } : {}),
        ...(cached.agentRole !== undefined ? { agentRole: cached.agentRole } : {}),
        ...(cached.source !== undefined ? { source: cached.source } : {}),
        ...(cached.schemaVersion !== undefined ? { schemaVersion: cached.schemaVersion } : {}),
      } as WorkflowEvent;
    }

    const fullEvent: WorkflowEvent = {
      ...event,
      streamId,
      sequence: result.sequences[0],
      // Timestamp comes back from the appender so the synthesized event
      // matches the persisted shape exactly.
      timestamp: result.timestamps[0],
    } as WorkflowEvent;

    return fullEvent;
  }

  async batchAppend(
    streamId: string,
    events: Array<Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string; idempotencyKey?: string }>,
  ): Promise<WorkflowEvent[]> {
    if (events.length === 0) return [];

    // Validate every event up front so a malformed input fails before any
    // sequence is allocated. Sequence is a placeholder; AtomicAppender
    // re-derives the authoritative values inside the lock.
    //
    // #1291 — stamp each event from the active dispatch context before
    // parsing. The whole batch shares one dispatch boundary so each event
    // pulls the same triple from `getDispatchContext()`.
    const validated: WorkflowEvent[] = events.map((event) => {
      const timestamp = event.timestamp || new Date().toISOString();
      const stamped = stampWithDispatchContext(event);
      return WorkflowEventBase.parse({
        ...stamped,
        streamId,
        sequence: 1,
        timestamp,
        idempotencyKey: stamped.idempotencyKey,
      });
    });

    // Intra-batch dedup: if any two events share an idempotencyKey, keep
    // the first and drop the rest. Matches the legacy contract.
    const seenBatchKeys = new Set<string>();
    const deduped: WorkflowEvent[] = [];
    for (const event of validated) {
      if (event.idempotencyKey && seenBatchKeys.has(event.idempotencyKey)) continue;
      if (event.idempotencyKey) seenBatchKeys.add(event.idempotencyKey);
      deduped.push(event);
    }
    if (deduped.length === 0) return [];

    // Choose a batch idempotency key:
    //   - all events share one key  → that key (preserves cross-batch retry).
    //   - any event has a key but they differ → synthesize batch:<uuid> so
    //     cross-batch retries don't dedup against a partial overlap.
    //   - all events keyless → unkeyed append (no cache pollution).
    const eventKeys = deduped.map((e) => e.idempotencyKey).filter((k): k is string => !!k);
    const firstKey = eventKeys[0];
    const allHaveKeys = eventKeys.length === deduped.length;
    const allSameKey = allHaveKeys && eventKeys.every((k) => k === firstKey);

    const appender = this.getAppender();
    const eventInputs = deduped.map((e) => {
      const { sequence: _ignored, ...input } = e as WorkflowEvent & { sequence?: number };
      return input;
    });

    let result: import('./atomic-appender.js').AppendResult;
    if (eventKeys.length === 0) {
      result = await appender.appendUnkeyed(streamId, eventInputs);
    } else {
      const batchKey =
        allSameKey && firstKey !== undefined ? firstKey : `batch:${randomUUIDFn()}`;
      result = await appender.append(streamId, eventInputs, batchKey);
    }

    if (!result.ok) {
      if (result.reason === 'idempotency-claimed') {
        // Legacy semantics: a cache hit on the (single) batch key returns the
        // cached events. AtomicAppender already returns ok:true with cached
        // sequences/eventIds for that path, so this branch only fires on the
        // structural failure case — surface it.
        throw new Error(`Batch append failed: ${result.reason}`);
      }
      throw result.cause ?? new Error(`Batch append failed: ${result.reason}`);
    }

    // Cache-hit branch: return the original persisted events verbatim.
    // See delegateAppend for the same pattern + design rationale (v2.11
    // substrate-cut removed the dual-write replication paths).
    if (result.kind === 'cache-hit') {
      return result.persistedEvents.map(
        (e) => ({
          streamId: e.streamId,
          sequence: e.sequence,
          type: e.type,
          timestamp: e.timestamp,
          ...(e.idempotencyKey !== undefined ? { idempotencyKey: e.idempotencyKey } : {}),
          ...(e.data !== undefined ? { data: e.data } : {}),
          ...(e.correlationId !== undefined ? { correlationId: e.correlationId } : {}),
          ...(e.causationId !== undefined ? { causationId: e.causationId } : {}),
          // #1291 — three-field correlation passthrough. Mirror delegateAppend's
          // cache-hit branch so a retry surfaces the same operationId chain.
          ...((e as { operationId?: string }).operationId !== undefined
            ? { operationId: (e as { operationId?: string }).operationId }
            : {}),
          ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
          ...(e.agentRole !== undefined ? { agentRole: e.agentRole } : {}),
          ...(e.source !== undefined ? { source: e.source } : {}),
          ...(e.schemaVersion !== undefined ? { schemaVersion: e.schemaVersion } : {}),
        } as WorkflowEvent),
      );
    }

    const fullEvents: WorkflowEvent[] = deduped.map((event, i) => {
      const sequence = result.sequences[i];
      const timestamp = result.timestamps[i];
      if (sequence === undefined || timestamp === undefined) {
        throw new Error(
          `Batch append result missing sequence/timestamp for event ${i}`,
        );
      }
      return { ...event, sequence, timestamp };
    });

    return fullEvents;
  }

  /**
   * DR-7 (INV-9) — append an entire phase-mutation event TRAIL in ONE atomic
   * transaction.
   *
   * `append` commits one event per call, so a caller that emits an N-event
   * trail (a `state.patched` backfill, the HSM lifecycle events, a completion
   * event) through a loop can be interrupted after event k and leave a PARTIAL
   * trail durably on the log — a half-written phase mutation that no consumer
   * can distinguish from a complete one. This primitive routes the whole trail
   * through `AtomicAppender.decideOnce`: one BEGIN IMMEDIATE transaction, so
   * the stream ends up with either the complete trail or nothing at all.
   *
   * Differences from `batchAppend`, which is NOT a substitute here:
   *   - `batchAppend` collapses the batch onto a SINGLE idempotency key: events
   *     that share a key are deduped down to the first, and events with
   *     differing keys get a synthesized `batch:<uuid>` claim that defeats
   *     cross-call retry dedup. A phase-mutation trail needs distinct per-event
   *     keys AND retry idempotency.
   *   - `decideOnce` keys idempotency on `operationId` (retry-stable, supplied
   *     by the caller) and passes each event's own `idempotencyKey` through to
   *     the persisted payload verbatim.
   *
   * The request digest deliberately covers only `(type, data, idempotencyKey)`:
   * a regenerated timestamp or dispatch-context stamp must not make a retry of
   * the SAME trail look like a different request to `decideOnce`'s digest gate.
   */
  async appendTrailAtomically(
    streamId: string,
    events: ReadonlyArray<
      Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string }
    >,
    operationId: string,
  ): Promise<void> {
    if (events.length === 0) return;
    if (!operationId) {
      throw new Error('appendTrailAtomically requires an operationId');
    }

    // Validate + stamp every event up front, exactly as `append` does, so a
    // malformed member fails the whole trail before any sequence is allocated.
    const prepared: WorkflowEvent[] = events.map((event) => {
      const timestamp = event.timestamp || new Date().toISOString();
      const stamped = stampWithDispatchContext(event);
      return WorkflowEventBase.parse({
        ...stamped,
        streamId,
        sequence: 1,
        timestamp,
        ...(event.idempotencyKey !== undefined
          ? { idempotencyKey: event.idempotencyKey }
          : {}),
      });
    });

    const requestDigest = `sha256:${createHash('sha256')
      .update(
        JSON.stringify(
          prepared.map((event) => ({
            type: event.type,
            data: event.data ?? null,
            idempotencyKey: event.idempotencyKey ?? null,
          })),
        ),
      )
      .digest('hex')}`;

    const inputs = prepared.map((event) => {
      const { sequence: _ignoredSeq, ...input } = event as WorkflowEvent & {
        sequence?: number;
      };
      return input;
    });

    await this.getAppender().decideOnce<number>(
      operationId,
      requestDigest,
      () => ({ streamId, events: inputs, result: inputs.length }),
    );
  }

  async query(streamId: string, filters?: QueryFilters): Promise<WorkflowEvent[]> {
    // v2.11 Phase 3: JSONL fallback removed. The read backend is always
    // present (SqliteBackend force-eager via getReadBackend), so reads
    // converge on the substrate the appender writes to.
    //
    // #1556: read-time upcasting choke point. Every backend row folds through
    // migrateEvents so a registered schema migration is applied uniformly to
    // every reader. Identity no-op today (eventMigrations === []).
    const events = this.getReadBackend().queryEvents(streamId, filters);
    return migrateEvents(events);
  }

  /**
   * Cross-stream query reducer (DR-3).
   *
   * Returns every event of `eventType` whose `streamId` matches `filters.streamPrefix`
   * — either as an exact match (`streamId === streamPrefix`) or as a namespaced
   * descendant (`streamId.startsWith(streamPrefix + '/')`). The split avoids
   * substring-style false positives (e.g. `feat-1-extra` is NOT a descendant of
   * `feat-1`), matching the SQL clause documented in the design:
   *
   *   WHERE streamId LIKE ? || '/%' OR streamId = ?
   *
   * The `streamPrefix` itself is validated as a (possibly single-segment)
   * stream id so namespaced inputs like `feat-1/sub-a` are admitted but
   * pathological inputs (`..`, leading slash, etc.) are rejected at the
   * boundary before the SQLite layer ever sees them.
   *
   * This is the canonical reducer for `team.disbanded` emission: count
   * `task.completed` events across every subagent stream nested under the
   * feature stream, without reading any derived state (INV-1).
   *
   * Implementation note: post-v2.11 the SQLite backend's cross-stream
   * query is the only path. Filters from `QueryFilters` (sinceSequence,
   * since, until, limit, offset) apply globally to the merged result.
   */
  async queryByType(
    eventType: string,
    filters?: QueryFilters & { streamPrefix?: string },
  ): Promise<WorkflowEvent[]> {
    const prefix = filters?.streamPrefix;
    if (!prefix) {
      throw new Error(
        'EventStore.queryByType requires filters.streamPrefix — use EventStore.query() for single-stream queries',
      );
    }
    validateStreamId(prefix);

    // Per-stream sub-filters: type is enforced here, prefix is dispatched
    // by stream selection. Pagination/limit are applied AFTER the merge so
    // they reflect the global ordering rather than per-stream slices.
    const perStream: QueryFilters = { type: eventType };
    if (filters?.sinceSequence !== undefined) perStream.sinceSequence = filters.sinceSequence;
    if (filters?.since !== undefined) perStream.since = filters.since;
    if (filters?.until !== undefined) perStream.until = filters.until;
    if (filters?.operationId !== undefined) perStream.operationId = filters.operationId;
    if (filters?.correlationId !== undefined) perStream.correlationId = filters.correlationId;
    if (filters?.causationId !== undefined) perStream.causationId = filters.causationId;

    // SQLite cross-stream fast-path: the SqliteBackend implements
    // `queryEventsByType` with the SQL clause
    //   WHERE streamId LIKE ? || '/%' OR streamId = ?
    // matching the structural prefix semantic exactly. v2.11 Phase 3
    // collapsed the JSONL listStreams enumeration fallback — the read
    // backend is always present and SqliteBackend always implements this
    // method. Test fixtures injecting an `InMemoryBackend` without
    // `queryEventsByType` fall through to the per-stream merge below.
    const readBackend = this.getReadBackend();
    if (typeof readBackend.queryEventsByType === 'function') {
      const backendEvents = readBackend.queryEventsByType(eventType, prefix, perStream);
      const sortedBackend = backendEvents.slice().sort((a, b) => {
        const byTs = a.timestamp.localeCompare(b.timestamp);
        return byTs !== 0 ? byTs : a.sequence - b.sequence;
      });
      const offset = filters?.offset ?? 0;
      const limit = filters?.limit;
      const slicedBackend = offset > 0 ? sortedBackend.slice(offset) : sortedBackend;
      // #1556: this fast-path reads the backend directly (bypassing query),
      // so it upcasts here. The per-stream fallback below composes via
      // this.query(), which already routes through migrateEvents — no
      // double-migration.
      return migrateEvents(limit !== undefined ? slicedBackend.slice(0, limit) : slicedBackend);
    }

    // Backend without queryEventsByType (test fixtures, in-memory): use
    // listStreams() to enumerate, apply the structural prefix filter
    // locally, then merge per-stream results.
    const matchingStreams: string[] = [];
    {
      const seen = new Set<string>();
      for (const streamId of readBackend.listStreams()) {
        if (seen.has(streamId)) continue;
        const isExact = streamId === prefix;
        const isDescendant = streamId.startsWith(`${prefix}/`);
        if (isExact || isDescendant) {
          matchingStreams.push(streamId);
          seen.add(streamId);
        }
      }
    }

    const merged: WorkflowEvent[] = [];
    for (const streamId of matchingStreams) {
      const events = await this.query(streamId, perStream);
      for (const event of events) {
        if (event.type === eventType) merged.push(event);
      }
    }

    // Stable global ordering: timestamp first, sequence as tie-break.
    merged.sort((a, b) => {
      const byTs = a.timestamp.localeCompare(b.timestamp);
      return byTs !== 0 ? byTs : a.sequence - b.sequence;
    });

    const offset = filters?.offset ?? 0;
    const limit = filters?.limit;
    const sliced = offset > 0 ? merged.slice(offset) : merged;
    return limit !== undefined ? sliced.slice(0, limit) : sliced;
  }

  /**
   * List all known stream IDs.
   * Delegates to the read backend (always present post-Phase-3).
   */
  listStreams(): string[] {
    return this.getReadBackend().listStreams();
  }

  /**
   * Return the highest sequence persisted on `streamId`, or 0 when the
   * stream is empty / has never been written. Mirrors the semantics of
   * `StorageBackend.getSequence` (and the SqliteBackend
   * `readSequenceHighWaterMark` accessor `AtomicAppender` uses
   * internally) — the public surface lets cache-validating consumers
   * (notably `EventSourcedTaskStore.loadTask`, FINDING-2 #1438) compare
   * a stale `lastReadSequence` against the live stream tail without
   * having to re-query the entire event list.
   */
  async tailSequence(streamId: string): Promise<number> {
    return this.getReadBackend().getSequence(streamId);
  }

  /**
   * DR-1 cursor-pump subscription primitive (#1315).
   *
   * Registers a subscription whose cursor drains committed events matching
   * `filter` (`{ streamId?, eventTypes? }`) and delivers them to `onEvent` in
   * global sequence order, exactly once. Registration atomically captures the
   * cursor (stream head, or `options.fromSequence`) and schedules an
   * unconditional initial drain, so an event committed at any moment relative
   * to registration is delivered exactly once.
   *
   * Two wake tiers converge on the same cursor drain. Tier-1 (in-process):
   * an append committing in this process wakes the subscription via the
   * appender's post-commit hook, fired after the transaction commits AND
   * after the per-stream mutex releases (so an `onEvent` that itself appends
   * does not deadlock). INV-8 idempotency cache-hits commit nothing and do
   * not wake. Tier-2 (cross-process poll floor): a loop on the injectable
   * clock re-reads `dataVersion()` every `floorMs` and drains only when a
   * FOREIGN process committed, so cross-process events are delivered within a
   * bounded latency without re-scanning the log every tick.
   *
   * Subscriptions are ephemeral (INV-15): the returned handle MUST be
   * disposed by the dispatch that registered it; `close()` disposes any that
   * leak. `registryOptions` (injectable clock, floor default) is an optional
   * test/wiring seam.
   */
  subscribe(
    filter: SubscriptionFilter,
    onEvent: SubscriptionListener,
    options?: SubscribeOptions,
    registryOptions?: SubscriptionRegistryOptions,
  ): SubscriptionHandle {
    return this.ensureSubscriptions(registryOptions).subscribe(filter, onEvent, options);
  }

  /**
   * Lazily construct the subscription registry and wire the appender's
   * Tier-1 commit hook. The registry reads through this store's read backend
   * — the same SQLite handle the appender writes to (production wiring), so a
   * commit is visible to the drain the wake triggers. Reads route through
   * `migrateEvents` for parity with `query()` (identity today).
   */
  private ensureSubscriptions(
    registryOptions?: SubscriptionRegistryOptions,
  ): SubscriptionRegistry {
    if (!this.subscriptions) {
      const reader: SubscriptionEventReader = {
        headSequence: (streamId) => this.getReadBackend().getSequence(streamId),
        readStreamAfter: (streamId, afterSequence) =>
          migrateEvents(
            this.getReadBackend().queryEvents(streamId, { sinceSequence: afterSequence }),
          ),
        listStreams: () => this.getReadBackend().listStreams(),
        // Tier-2 poll-floor change token: reads through the SAME backend
        // handle the appender writes to, so `PRAGMA data_version` reports a
        // FOREIGN process's commit (never this process's own — those the
        // Tier-1 hook already delivered).
        dataVersion: () => this.getReadBackend().dataVersion(),
      };
      this.subscriptions = new SubscriptionRegistry(reader, registryOptions);
      // Wire the Tier-1 hook only now — the zero-subscriber append path never
      // pays for a hook that is undefined.
      const registry = this.subscriptions;
      this.getAppender().setCommitHook((streamId) => registry.wake(streamId));
    }
    return this.subscriptions;
  }

  /**
   * Dispose every live subscription (dispatch teardown — INV-15). Idempotent;
   * safe to call whether or not any subscription was ever registered.
   */
  disposeSubscriptions(): void {
    this.subscriptions?.disposeAll();
  }

  /**
   * Register a stream in the typed-stream registry (Marten R-1, #1313).
   * Idempotent: re-calling for the same streamId leaves the registry row
   * untouched. The workflow_type column is immutable post-insert — a CI
   * grep gate (task 1.7) forbids any UPDATE that would mutate it.
   *
   * Backends without a typed-stream registry (in-memory test fixtures,
   * remote stubs) omit `registerStream`; in that case this method is a
   * no-op so callers like `handleInit` can run identically against any
   * backend.
   */
  registerStream(streamId: string, workflowType: string): void {
    const backend = this.getReadBackend();
    if (typeof backend.registerStream !== 'function') return;
    backend.registerStream(streamId, workflowType);
  }

  /**
   * Run a narrow backend integrity probe with bounded wall time.
   *
   * This is the only public entry point for the doctor
   * `storage-sqlite-health` check — we intentionally do NOT expose the
   * raw sqlite handle (DIM-6). The method enforces its own timeout and
   * honours the caller's AbortSignal (DIM-7) so no check implementation
   * has to duplicate that logic.
   *
   * Behaviour:
   *   - Backend does not implement `runIntegrityPragma` (e.g. in-memory,
   *     remote test fixtures) → `{ok: 'skipped', ...}`
   *   - Backend verdict exactly `"ok"` → `{ok: true}`
   *   - Any other verdict → `{ok: false, details}` (corruption)
   *   - Probe exceeds `timeoutMs` → `{ok: false, details: 'integrity_check timed out after Nms'}`
   *   - External abort → rejects with AbortError (caller-initiated
   *     cancellation is an exception, not a result)
   *
   * After Phase 3, the read backend is always present (SQLite forced via
   * `ensureSqliteBackendSync()` or an explicitly-injected fixture), so
   * the legacy "no backend attached" skip branch is gone.
   */
  async runIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<IntegrityResult> {
    const probeBackend = this.getReadBackend();
    if (typeof probeBackend.runIntegrityPragma !== 'function') {
      return {
        ok: 'skipped',
        reason: 'backend does not support integrity_check (non-sqlite)',
      };
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_INTEGRITY_TIMEOUT_MS;
    const externalSignal = opts?.signal;

    if (externalSignal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Chain the caller's signal into an internal controller so we can
    // also fire abort on timeout without mutating the caller's signal.
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let timer: NodeJS.Timeout | undefined;
    let didTimeout = false;
    const timeoutDetails = `integrity_check timed out after ${timeoutMs}ms`;
    const timeoutPromise = new Promise<IntegrityResult>((resolve) => {
      timer = setTimeout(() => {
        didTimeout = true;
        controller.abort();
        resolve({
          ok: false,
          details: timeoutDetails,
        });
      }, timeoutMs);
    });

    const probePromise = (async (): Promise<IntegrityResult> => {
      // Non-null by the typeof guard above; capture into a local for
      // narrowing through the await boundary.
      const probe = probeBackend.runIntegrityPragma!.bind(probeBackend);
      try {
        const verdict = await probe(controller.signal);
        if (verdict.trim().toLowerCase() === 'ok') {
          return { ok: true };
        }
        return { ok: false, details: verdict };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // If we timed out and it's not an external abort, return the
          // timeout result instead of letting AbortError escape the race.
          if (didTimeout && !externalSignal?.aborted) {
            return { ok: false, details: timeoutDetails };
          }
          throw err;
        }
        return {
          ok: false,
          details: err instanceof Error ? err.message : String(err),
        };
      }
    })();

    try {
      // If the external signal aborted, the probe will reject with
      // AbortError; Promise.race propagates that. Timeout arm resolves
      // with an IntegrityResult.
      if (externalSignal) {
        const externalAbortPromise = new Promise<never>((_, reject) => {
          externalSignal.addEventListener(
            'abort',
            () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            },
            { once: true },
          );
        });
        return await Promise.race([probePromise, timeoutPromise, externalAbortPromise]);
      }
      return await Promise.race([probePromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  /**
   * Recovery hook retained for legacy callers (e.g. CLI restart paths
   * that historically called this after a `SequenceConflictError`).
   *
   * Pre-#1293 this rebuilt the in-memory sequence counter from disk.
   * Post-substrate-cut, sequence rebuild is implicit (the SQLite
   * substrate's `MAX(sequence)` query inside `AtomicAppender` rebuilds
   * on first contact, and the `.seq.tmp` JSONL housekeeping artifact no
   * longer exists). The method is a no-op kept only so external callers
   * stay source-compatible across the cutover.
   */
  async refreshSequence(streamId: string): Promise<void> {
    validateStreamId(streamId);
  }
}

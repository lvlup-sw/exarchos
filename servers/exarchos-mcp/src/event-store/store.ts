import * as fs from 'node:fs/promises';
import { openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import { randomUUID as randomUUIDFn } from 'node:crypto';
import { WorkflowEventBase } from './schemas.js';
import type { WorkflowEvent } from './schemas.js';
import type { StorageBackend } from '../storage/backend.js';
import { isPidAlive } from '../utils/process.js';
import { validateStreamId } from '../shared/validation.js';
import { AtomicAppender } from './atomic-appender.js';

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

// ─── PID Lock Error ──────────────────────────────────────────────────────────

/**
 * Distinguishes the two reasons `acquirePidLock` can fail:
 *
 *   - `live-holder`: the lock file is held by an observably-live process;
 *     the holder's PID is reported via `existingPid`. This is the normal
 *     contention case.
 *   - `retry-exhausted`: the acquisition loop exhausted its retry budget
 *     while racing a stream of fast lock churns (TOCTOU contention) without
 *     ever observing a live holder long enough to complete steal + recreate.
 *     `existingPid` reports the last observably-valid PID seen during the
 *     retry window, or `-1` if none was ever read.
 */
export type PidLockReason = 'live-holder' | 'retry-exhausted';

export class PidLockError extends Error {
  constructor(
    public readonly existingPid: number,
    public readonly reason: PidLockReason = 'live-holder',
  ) {
    super(
      reason === 'retry-exhausted'
        ? `Event store lock acquisition exhausted retries under TOCTOU contention (last observed holder PID ${existingPid})`
        : `Event store is locked by live process PID ${existingPid}`,
    );
    this.name = 'PidLockError';
  }
}

// ─── Append Options ─────────────────────────────────────────────────────────

export interface AppendOptions {
  expectedSequence?: number;
  idempotencyKey?: string;
}

// ─── Query Filters ──────────────────────────────────────────────────────────

export interface QueryFilters {
  type?: string;
  sinceSequence?: number;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
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
}

// ─── Event Store Options ────────────────────────────────────────────────────

export interface EventStoreOptions {
  backend?: StorageBackend;
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

// ─── Initialize Options ─────────────────────────────────────────────────────

/**
 * Options passed to `EventStore.initialize()`.
 *
 * `waitForLock` controls behaviour when another live process already holds
 * the PID lock.
 *
 * - When `false` (default), `initialize()` throws `PidLockError` immediately
 *   on contention. This is the v2.11 hard-fail substrate semantic: sidecar
 *   fallback (#1082) was deleted alongside the JSONL substrate it existed
 *   to side-channel; SQLite WAL handles concurrent access natively, so any
 *   PID-lock contention now reflects a genuine ownership conflict the
 *   caller must resolve, not a write-path that needs degrading.
 * - When `true`, `initialize()` waits for the lock to be released (bounded
 *   by `waitForLockTimeoutMs`), retrying until it can reclaim the lock.
 *   On exhaustion, throws `PidLockError`. Right mode for short-lived CLI
 *   processes that need their writes to serialise behind a concurrent
 *   invocation (DR-5).
 */
export interface InitializeOptions {
  /** Block until the PID lock can be acquired, rather than throwing immediately on contention. */
  readonly waitForLock?: boolean;
  /** Maximum time to wait for the PID lock when `waitForLock` is true. Defaults to 30s. */
  readonly waitForLockTimeoutMs?: number;
  /** Initial backoff between acquisition attempts when waiting. Defaults to 10ms. */
  readonly waitForLockInitialDelayMs?: number;
  /** Maximum backoff between acquisition attempts when waiting. Defaults to 100ms. */
  readonly waitForLockMaxDelayMs?: number;
}

/** Default bounds for the `waitForLock` branch of `initialize()`. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_INITIAL_DELAY_MS = 10;
const DEFAULT_WAIT_MAX_DELAY_MS = 100;

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
 * Cross-process safety: call `initialize()` before first use. The first
 * process to initialize acquires a PID lock; subsequent processes throw
 * `PidLockError` (or wait for the lock when `waitForLock: true`). Sidecar
 * mode (#1082) was deleted in v2.11 — SQLite WAL handles concurrent access
 * natively, so PID-lock contention is now a hard error rather than a
 * fallback to a side-channel writer.
 *
 * Uses in-memory promise-chain locks that only protect within a single Node.js process.
 * Multiple EventStore instances sharing the same stateDir without PID lock will corrupt data.
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

  /** Path to the PID lock file */
  private lockFilePath: string;

  /** Optional storage backend for delegating reads */
  private readonly backend?: StorageBackend;

  /** Lazily-instantiated AtomicAppender — single instance per stateDir so per-stream
   *  locks and sequence counters share state across handler calls. */
  private atomicAppender?: AtomicAppender;

  constructor(private readonly stateDir: string, options?: EventStoreOptions) {
    this.lockFilePath = path.join(stateDir, '.event-store.lock');
    this.backend = options?.backend;
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
   * docs/designs/2026-05-08-eventstore-appender-consumer-migration.md.
   */
  getAppender(): AtomicAppender {
    if (!this.atomicAppender) {
      this.atomicAppender = new AtomicAppender({
        stateDir: this.stateDir,
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

  // ─── PID Lock ──────────────────────────────────────────────────────────────

  /**
   * Initialize the event store: acquire PID lock and register cleanup handler.
   * Must be called before first use.
   *
   * Sidecar fallback (#1082) was deleted in v2.11 — when another process
   * holds the lock, this method now throws `PidLockError` immediately. The
   * fallback only existed to side-channel JSONL writers around the
   * per-process lock; SQLite WAL (post-v2.10 substrate, #1259/#1323) makes
   * cross-process writes safe natively, so contention now reflects a real
   * ownership conflict the caller is responsible for resolving.
   *
   * Pass `{ waitForLock: true }` to block until the lock can be acquired
   * — the right mode for short-lived CLI processes where concurrent
   * invocations must serialise (DR-5 cross-process concurrency safety).
   * On wait-deadline exhaustion, `PidLockError` is rethrown.
   */
  async initialize(options?: InitializeOptions): Promise<void> {
    if (this.initialized) return;

    const waitForLock = options?.waitForLock === true;
    if (waitForLock) {
      await this.acquirePidLockWithWait(
        options?.waitForLockTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        options?.waitForLockInitialDelayMs ?? DEFAULT_WAIT_INITIAL_DELAY_MS,
        options?.waitForLockMaxDelayMs ?? DEFAULT_WAIT_MAX_DELAY_MS,
      );
    } else {
      await this.acquirePidLock();
    }
    this.initialized = true;
  }

  /**
   * Acquire the PID lock, blocking until success or until `timeoutMs` elapses.
   * Uses exponential backoff with jitter, capped at `maxDelayMs`. On timeout,
   * rethrows the last `PidLockError` so the caller can surface a clear
   * "lock held by PID N — retry later" diagnostic.
   */
  private async acquirePidLockWithWait(
    timeoutMs: number,
    initialDelayMs: number,
    maxDelayMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = initialDelayMs;
    let lastErr: PidLockError | undefined;

    // First attempt without backoff — fast path when the lock is free.
    try {
      await this.acquirePidLock();
      return;
    } catch (err) {
      if (!(err instanceof PidLockError)) throw err;
      lastErr = err;
    }

    while (Date.now() < deadline) {
      // Jittered sleep, capped by maxDelayMs and remaining budget.
      const remaining = Math.max(0, deadline - Date.now());
      const jittered = Math.min(delay, maxDelayMs) * (0.5 + Math.random());
      const waitMs = Math.max(1, Math.min(jittered, remaining));
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));

      try {
        await this.acquirePidLock();
        return;
      } catch (err) {
        if (!(err instanceof PidLockError)) throw err;
        lastErr = err;
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }

    // Every attempt threw PidLockError, so `lastErr` is always set here.
    // Fall back to a synthetic retry-exhausted error only to keep the type
    // narrow if some future refactor makes `lastErr` unreachable.
    throw lastErr ?? new PidLockError(-1, 'retry-exhausted');
  }

  private async acquirePidLock(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });

    // Acquisition is a TOCTOU dance between three filesystem operations:
    //   1. open('wx')        — atomic create-if-not-exists
    //   2. readFile          — peek at the holder's PID
    //   3. unlink + open('wx') — reclaim a stale lock
    //
    // Any of (2) or (3) can race with a concurrent process that is releasing
    // (ENOENT) or re-acquiring (EEXIST) the same file. Rather than fail on
    // these transients, retry the full sequence a bounded number of times;
    // if we exhaust retries while a live holder remains, surface PidLockError
    // so the caller (CLI exit path or `waitForLock` retry loop) can decide.
    const MAX_RETRIES = 32;
    let acquired = false;
    // F-022-4: remember the most recent observably-valid holder PID so that
    // when we exhaust retries we can attribute the exhaustion to the churn
    // rather than report a synthetic `-1`.
    let lastObservedPid = -1;
    for (let attempt = 0; attempt < MAX_RETRIES && !acquired; attempt++) {
      try {
        const fd = openSync(this.lockFilePath, 'wx');
        writeSync(fd, String(process.pid));
        closeSync(fd);
        acquired = true;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

        // Lock file exists — peek at the holder's PID.
        let existingPid: number;
        try {
          const content = await fs.readFile(this.lockFilePath, 'utf-8');
          existingPid = parseInt(content.trim(), 10);
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
            // Holder released between open() and readFile(); try again.
            continue;
          }
          throw readErr;
        }

        if (!isNaN(existingPid)) {
          lastObservedPid = existingPid;
        }

        if (!isNaN(existingPid) && isPidAlive(existingPid)) {
          throw new PidLockError(existingPid, 'live-holder');
        }

        // Stale lock — atomic reclaim: unlink then exclusive create.
        try {
          await fs.unlink(this.lockFilePath);
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code === 'ENOENT') {
            // Lock vanished first — retry from the top.
            continue;
          }
          throw unlinkErr;
        }
        try {
          const fd = openSync(this.lockFilePath, 'wx');
          writeSync(fd, String(process.pid));
          closeSync(fd);
          acquired = true;
          break;
        } catch (reclaimErr) {
          if ((reclaimErr as NodeJS.ErrnoException).code !== 'EEXIST') throw reclaimErr;
          // Another process reclaimed between unlink and open — re-read the
          // winner PID to report, but tolerate ENOENT (another quick release).
          let winnerPid = -1;
          try {
            const newContent = await fs.readFile(this.lockFilePath, 'utf-8');
            winnerPid = parseInt(newContent.trim(), 10);
          } catch (newReadErr) {
            if ((newReadErr as NodeJS.ErrnoException).code !== 'ENOENT') throw newReadErr;
            continue; // retry whole acquisition
          }
          if (!isNaN(winnerPid) && winnerPid > 0) {
            lastObservedPid = winnerPid;
          }
          throw new PidLockError(winnerPid, 'live-holder');
        }
      }
    }

    if (!acquired) {
      // F-022-4: reached retry ceiling without ever observing a live holder
      // long enough to commit — this is TOCTOU churn, not a stuck holder.
      // Report the last observably-valid PID so operators can identify the
      // contending process without seeing an opaque `-1`.
      throw new PidLockError(lastObservedPid, 'retry-exhausted');
    }

    // Register cleanup handler
    const lockPath = this.lockFilePath;
    process.on('exit', () => {
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort cleanup
      }
    });
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
    // Sequence is allocated by AtomicAppender; pass a placeholder so Zod's
    // positive-integer guard accepts the schema. The synthesized return value
    // overwrites this with the authoritative sequence.
    const candidate = WorkflowEventBase.parse({
      ...event,
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
    const prepared: WorkflowEvent = {
      ...event,
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
      return {
        streamId: cached.streamId,
        sequence: cached.sequence,
        type: cached.type,
        timestamp: cached.timestamp,
        ...(cached.idempotencyKey !== undefined ? { idempotencyKey: cached.idempotencyKey } : {}),
        ...(cached.data !== undefined ? { data: cached.data } : {}),
        ...(cached.correlationId !== undefined ? { correlationId: cached.correlationId } : {}),
        ...(cached.causationId !== undefined ? { causationId: cached.causationId } : {}),
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
    const validated: WorkflowEvent[] = events.map((event) => {
      const timestamp = event.timestamp || new Date().toISOString();
      return WorkflowEventBase.parse({
        ...event,
        streamId,
        sequence: 1,
        timestamp,
        idempotencyKey: event.idempotencyKey,
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
    const allHaveKeys = eventKeys.length === deduped.length;
    const allSameKey = allHaveKeys && eventKeys.every((k) => k === eventKeys[0]);

    const appender = this.getAppender();
    const eventInputs = deduped.map((e) => {
      const { sequence: _ignored, ...input } = e as WorkflowEvent & { sequence?: number };
      return input;
    });

    let result: import('./atomic-appender.js').AppendResult;
    if (eventKeys.length === 0) {
      result = await appender.appendUnkeyed(streamId, eventInputs);
    } else {
      const batchKey = allSameKey ? eventKeys[0] : `batch:${randomUUIDFn()}`;
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
          ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
          ...(e.agentRole !== undefined ? { agentRole: e.agentRole } : {}),
          ...(e.source !== undefined ? { source: e.source } : {}),
          ...(e.schemaVersion !== undefined ? { schemaVersion: e.schemaVersion } : {}),
        } as WorkflowEvent),
      );
    }

    const fullEvents: WorkflowEvent[] = deduped.map((event, i) => ({
      ...event,
      sequence: result.sequences[i],
      timestamp: result.timestamps[i],
    }));

    return fullEvents;
  }

  async query(streamId: string, filters?: QueryFilters): Promise<WorkflowEvent[]> {
    // v2.11 Phase 3: JSONL fallback removed. The read backend is always
    // present (SqliteBackend force-eager via getReadBackend), so reads
    // converge on the substrate the appender writes to.
    return this.getReadBackend().queryEvents(streamId, filters);
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
      return limit !== undefined ? slicedBackend.slice(0, limit) : slicedBackend;
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

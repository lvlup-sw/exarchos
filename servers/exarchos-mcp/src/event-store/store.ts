import * as fs from 'node:fs/promises';
import { createReadStream, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { randomUUID as randomUUIDFn } from 'node:crypto';
import { WorkflowEventBase } from './schemas.js';
import type { WorkflowEvent } from './schemas.js';
import type { Outbox } from '../sync/outbox.js';
import type { StorageBackend } from '../storage/backend.js';
import { migrateEvent } from './event-migration.js';
import { storeLogger } from '../logger.js';
import { isPidAlive } from '../utils/process.js';
import { getSidecarPath } from './hook-event-writer.js';
import { validateStreamId } from '../shared/validation.js';
import { AtomicAppender } from './atomic-appender.js';
import {
  SubagentStreamRouter,
  type SubagentStreamRouterContract,
} from '../agents/subagent-stream-router.js';

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
   * Honoured at the SQL/backend layer where possible; the JSONL fallback
   * implements the same semantic in `EventStore.queryByType`.
   */
  streamPrefix?: string;
}

/** Pre-compiled regex for extracting the sequence number from a JSONL line before JSON.parse. */
const SEQUENCE_REGEX = /"sequence":(\d+)/;

/**
 * Merge two time-ordered event lists into a single timestamp-ordered stream.
 *
 * Both inputs are assumed to be individually sorted by timestamp (main events
 * follow sequence order, which mirrors insertion order; sidecar events are
 * explicitly sorted in `readSidecarForQuery`). Ties break deterministically
 * by preferring main-stream events — sidecar entries were written while the
 * primary held the lock, so their timestamps are at least as recent as any
 * main event seen so far.
 */
function mergeByTimestamp(
  main: WorkflowEvent[],
  sidecar: WorkflowEvent[],
): WorkflowEvent[] {
  if (sidecar.length === 0) return main;
  if (main.length === 0) return sidecar;
  const out: WorkflowEvent[] = new Array(main.length + sidecar.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < main.length && j < sidecar.length) {
    out[k++] = main[i].timestamp <= sidecar[j].timestamp ? main[i++] : sidecar[j++];
  }
  while (i < main.length) out[k++] = main[i++];
  while (j < sidecar.length) out[k++] = sidecar[j++];
  return out;
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
 *   - `{ ok: 'skipped', reason }` → no applicable backend (jsonl-only or
 *     a backend without `runIntegrityPragma`)
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
 * the PID lock. When `false` (default), the instance enters sidecar mode —
 * writes are diverted to `{streamId}.hook-events.jsonl` and merged later by
 * the primary process. When `true`, `initialize()` waits for the lock to be
 * released (bounded by `waitForLockTimeoutMs`), retrying until it can
 * reclaim the lock. This is the right mode for short-lived CLI processes
 * that need their writes to land on the main JSONL immediately so the
 * outcome is equivalent to a sequential invocation (DR-5).
 *
 * Leave at the default in long-running MCP server / hook-subprocess paths,
 * where sidecar mode is the desired behaviour.
 */
export interface InitializeOptions {
  /** Block until the PID lock can be acquired, rather than entering sidecar mode. */
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
 * Append-only event store backed by JSONL files with .seq sequence caches.
 *
 * When an optional `StorageBackend` is provided, reads (query, getSequence)
 * delegate to the backend while writes still go to JSONL first (dual-write).
 *
 * Cross-process safety: call `initialize()` before first use. The first process
 * to initialize acquires a PID lock; subsequent processes enter sidecar mode
 * where writes are routed to `{streamId}.hook-events.jsonl` sidecar files for
 * later merging by the primary process. Reads always work from JSONL/backend.
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

  /**
   * When true, the PID lock is held by another process.
   * All writes are routed to sidecar files instead of the main JSONL.
   * Reads still work from JSONL/backend.
   */
  private sidecarMode = false;

  /** Path to the PID lock file */
  private lockFilePath: string;

  /** Optional outbox for supplementary event replication */
  private outbox?: Outbox;

  /** Optional storage backend for delegating reads */
  private readonly backend?: StorageBackend;

  /** Lazily-instantiated AtomicAppender — single instance per stateDir so per-stream
   *  locks and sequence counters share state across handler calls. */
  private atomicAppender?: AtomicAppender;

  /** Lazily-instantiated SubagentStreamRouter — single instance per EventStore
   *  so the router shares the same AtomicAppender (and therefore the same
   *  per-stream lock + idempotency cache) used by every other consumer. */
  private streamRouter?: SubagentStreamRouterContract;

  constructor(private readonly stateDir: string, options?: EventStoreOptions) {
    this.lockFilePath = path.join(stateDir, '.event-store.lock');
    this.backend = options?.backend;
  }

  /** Returns the state directory path used by this event store. */
  get dir(): string {
    return this.stateDir;
  }

  /** Configure an optional outbox for event replication. */
  setOutbox(outbox: Outbox): void {
    this.outbox = outbox;
  }

  /** Returns true when this instance is in sidecar mode (PID lock held by another process). */
  get inSidecarMode(): boolean {
    return this.sidecarMode;
  }

  /**
   * Returns the lazily-created AtomicAppender bound to this event store's
   * state directory. Single instance per EventStore so per-stream locks and
   * the in-memory sequence/idempotency caches share state across consumers.
   *
   * #1259 swap point: replace the constructor call below with a SQLite
   * (or other durable) appender that exposes the same `AppendResult`
   * shape and per-stream serialization semantics. No other change is
   * required — `append`, `appendValidated`, `batchAppend`, and the
   * `SubagentStreamRouter` all delegate through this instance, so a
   * one-line swap here flips the entire write substrate. The migration
   * doc is at docs/designs/2026-05-08-eventstore-appender-consumer-migration.md.
   */
  getAppender(): AtomicAppender {
    if (!this.atomicAppender) {
      this.atomicAppender = new AtomicAppender({ stateDir: this.stateDir });
    }
    return this.atomicAppender;
  }

  /**
   * Returns the lazily-created SubagentStreamRouter bound to this event
   * store's state directory. Backed by `getAppender()` so the router shares
   * the per-stream lock + idempotency cache. Used by `handleEventAppend` to
   * intercept `team.disbanded` events and recompute `tasksCompleted` from
   * the parent stream — discarding the agent-side in-memory tally that
   * produces #1224's off-by-N counts.
   */
  getStreamRouter(): SubagentStreamRouterContract {
    if (!this.streamRouter) {
      this.streamRouter = new SubagentStreamRouter({
        appender: this.getAppender(),
        stateDir: this.stateDir,
      });
    }
    return this.streamRouter;
  }

  // ─── PID Lock ──────────────────────────────────────────────────────────────

  /**
   * Initialize the event store: acquire PID lock and register cleanup handler.
   * Must be called before first use. When the PID lock is held by another
   * process, enters sidecar mode where writes are routed to sidecar files
   * and reads still work from JSONL/backend.
   *
   * Pass `{ waitForLock: true }` to block until the lock can be acquired
   * instead of entering sidecar mode — this is the correct mode for CLI
   * processes where concurrent invocations must serialize onto the main
   * JSONL (DR-5 cross-process concurrency safety).
   */
  async initialize(options?: InitializeOptions): Promise<void> {
    if (this.initialized) return;

    const waitForLock = options?.waitForLock === true;
    try {
      if (waitForLock) {
        await this.acquirePidLockWithWait(
          options?.waitForLockTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
          options?.waitForLockInitialDelayMs ?? DEFAULT_WAIT_INITIAL_DELAY_MS,
          options?.waitForLockMaxDelayMs ?? DEFAULT_WAIT_MAX_DELAY_MS,
        );
      } else {
        await this.acquirePidLock();
      }
    } catch (err) {
      if (err instanceof PidLockError) {
        // F-022-1: When the caller explicitly opted into waiting for the lock
        // (CLI mode, DR-5), do NOT silently fall back to sidecar mode after
        // the deadline elapses. The CLI adapter surfaces a clear exit code
        // ("lock held by PID N for >Ns — retry later") instead. Sidecar
        // fallback is only the correct behaviour for the long-running MCP
        // server / hook subprocess paths, which leave waitForLock unset.
        if (waitForLock) {
          throw err;
        }
        this.sidecarMode = true;
        this.initialized = true;
        storeLogger.warn(
          { existingPid: err.existingPid },
          'PID lock held by another process — entering sidecar mode (writes routed to sidecar files)',
        );
        return;
      }
      throw err;
    }
    this.initialized = true;
  }

  /**
   * Acquire the PID lock, blocking until success or until `timeoutMs` elapses.
   * Uses exponential backoff with jitter, capped at `maxDelayMs`. On timeout,
   * rethrows the last `PidLockError` so the caller can fall back to sidecar
   * mode if desired.
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
    // so the caller (sidecar fallback or `waitForLock` retry) can decide.
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

  /**
   * Write an event to the sidecar file for later merging by the primary process.
   * Returns a synthetic WorkflowEvent with sequence 0 (pending assignment).
   */
  private async writeToSidecar(
    streamId: string,
    event: Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string },
    idempotencyKey?: string,
  ): Promise<WorkflowEvent> {
    validateStreamId(streamId);
    const timestamp = event.timestamp || new Date().toISOString();
    const key = idempotencyKey ?? event.idempotencyKey;

    const sidecarEvent: Record<string, unknown> = {
      type: event.type,
      data: event.data ?? {},
      timestamp,
    };
    if (key) sidecarEvent.idempotencyKey = key;

    const filePath = getSidecarPath(this.stateDir, streamId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(sidecarEvent) + '\n', 'utf-8');

    // Return synthetic event with sequence 0 (pending assignment during merge)
    return {
      streamId,
      sequence: 0,
      type: event.type,
      data: (event.data ?? {}) as Record<string, unknown>,
      timestamp,
      ...(key && { idempotencyKey: key }),
    } as WorkflowEvent;
  }

  private getEventFilePath(streamId: string): string {
    validateStreamId(streamId);
    return path.join(this.stateDir, `${streamId}.events.jsonl`);
  }

  private getSeqFilePath(streamId: string): string {
    validateStreamId(streamId);
    return path.join(this.stateDir, `${streamId}.seq`);
  }

  async append(
    streamId: string,
    event: Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string },
    options?: AppendOptions,
  ): Promise<WorkflowEvent> {
    if (this.sidecarMode) {
      return this.writeToSidecar(streamId, event, options?.idempotencyKey);
    }
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
    if (this.sidecarMode) {
      return this.writeToSidecar(streamId, event, options?.idempotencyKey ?? event.idempotencyKey);
    }
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
   * typed result back into the legacy `WorkflowEvent` return shape, then run
   * supplementary backend + outbox replication. Sidecar mode short-circuits
   * before this method is reached.
   *
   * The AtomicAppender holds the per-stream lock for the duration of its
   * append; backend and outbox writes happen after the lock is released.
   * That ordering matches the legacy semantics — both were already
   * "supplementary, log-on-failure" — and avoids extending the critical
   * section across remote calls.
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

    // Cache-hit branch: return the originally-persisted event verbatim and
    // SKIP backend/outbox replication. Those side effects already ran when
    // the original commit landed; running them again with the current
    // request payload would replicate data that was never written to JSONL
    // (the bug CR-thread #3205805943 closes).
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

    this.replicateBackend(streamId, fullEvent);
    await this.writeOutbox(streamId, fullEvent);
    return fullEvent;
  }

  /** Best-effort backend dual-write — JSONL is the source of truth. */
  private replicateBackend(streamId: string, event: WorkflowEvent): void {
    if (!this.backend) return;
    try {
      this.backend.appendEvent(streamId, event);
    } catch (err) {
      storeLogger.warn(
        { err: err instanceof Error ? err.message : String(err), streamId, sequence: event.sequence },
        'Backend dual-write failed — stores may diverge',
      );
    }
  }

  /**
   * Best-effort outbox replication. JSONL is the source of truth; the sync
   * layer reconciles any missed entries from JSONL on next pass.
   *
   * KNOWN LIMITATION — Atomicity gap (carried over from the legacy path):
   * The JSONL append (in AtomicAppender) and this outbox write are NOT
   * transactionally atomic. A crash between them leaves an event in JSONL
   * without a corresponding outbox entry. Sync reconciliation closes the
   * gap on next pass.
   */
  private async writeOutbox(streamId: string, event: WorkflowEvent): Promise<void> {
    if (!this.outbox) return;
    try {
      await this.outbox.addEntry(streamId, event);
    } catch (err) {
      storeLogger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Outbox entry failed',
      );
    }
  }

  async batchAppend(
    streamId: string,
    events: Array<Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string; idempotencyKey?: string }>,
  ): Promise<WorkflowEvent[]> {
    if (this.sidecarMode) {
      const results: WorkflowEvent[] = [];
      for (const event of events) {
        results.push(await this.writeToSidecar(streamId, event, event.idempotencyKey));
      }
      return results;
    }

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

    // Cache-hit branch: return the original persisted events verbatim and
    // skip backend/outbox (already done at original commit time). See
    // delegateAppend for the same pattern + design rationale.
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

    // Supplementary replication, post-success, mirrors the legacy ordering.
    for (const fullEvent of fullEvents) {
      this.replicateBackend(streamId, fullEvent);
    }
    for (const fullEvent of fullEvents) {
      await this.writeOutbox(streamId, fullEvent);
    }

    return fullEvents;
  }

  async query(streamId: string, filters?: QueryFilters): Promise<WorkflowEvent[]> {
    // Issue #1082: when a sibling process is in sidecar mode, its events land
    // in `{streamId}.hook-events.jsonl` and are invisible to readers that look
    // only at the main source (JSONL or backend). Merge main + sidecar so
    // every materializer sees a consistent stream. Fast path (no sidecar)
    // keeps the original optimized loop with early termination on limit.
    const sidecarPath = getSidecarPath(this.stateDir, streamId);
    let sidecarExists = false;
    try {
      await fs.access(sidecarPath);
      sidecarExists = true;
    } catch {
      // No sidecar file — fall through to fast path.
    }

    if (!sidecarExists) {
      if (this.backend) {
        return this.backend.queryEvents(streamId, filters);
      }
      return this.queryMainJsonl(streamId, filters);
    }

    // Sidecar present: collect main events without offset/limit (we apply
    // those after merging), merge with sidecar events by timestamp, then
    // slice. Reading offset/limit from the backend/JSONL here would drop
    // main events that should interleave with sidecar entries.
    const mainFilters: QueryFilters = {
      type: filters?.type,
      since: filters?.since,
      until: filters?.until,
      sinceSequence: filters?.sinceSequence,
    };
    const rawMainEvents = this.backend
      ? await this.backend.queryEvents(streamId, mainFilters)
      : await this.queryMainJsonl(streamId, mainFilters);
    // `mergeByTimestamp` requires both inputs to be time-ordered. JSONL
    // preserves stream (sequence) order and `StorageBackend.queryEvents()`
    // offers no ordering guarantee; in both cases a caller-supplied
    // backfilled timestamp (see `append()` at lines ~330 and ~364) can
    // violate timestamp monotonicity. Sort defensively with a stable
    // sequence tie-break so interleaved backfill doesn't shift the slice
    // window after offset/limit.
    const mainEvents = rawMainEvents.slice().sort((a, b) => {
      const byTs = a.timestamp.localeCompare(b.timestamp);
      return byTs !== 0 ? byTs : a.sequence - b.sequence;
    });

    // Derive `mainMax` from the JSONL source-of-truth whenever it exists,
    // even in backend mode. Backend dual-write is best-effort (see
    // `replicateBackend`/`writeOutbox`), so `backend.getSequence()` can lag the real
    // JSONL high-water mark and cause synthetic sidecar sequences to
    // collide with already-durable events. Only fall back to the backend
    // counter when there is no local JSONL to read (e.g., remote-only
    // deployment with no primary on this host).
    const mainMax = await this.readJsonlMaxSequence(streamId);
    const sidecarEvents = await this.readSidecarForQuery(streamId, mainMax, filters);

    const merged = mergeByTimestamp(mainEvents, sidecarEvents);
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit;
    const sliced = offset > 0 ? merged.slice(offset) : merged;
    return limit !== undefined ? sliced.slice(0, limit) : sliced;
  }

  /**
   * Read the current max sequence for a stream directly from JSONL
   * (bypassing any storage backend). Used by the sidecar merge path so
   * synthetic sidecar sequences never collide with real JSONL-durable
   * events when the backend is lagging.
   *
   * Post-#1293, the substrate preserves corrupt histories (gaps, duplicate
   * sequences, offset starts). The previous cross-validation —
   * `parsed.sequence === lineCount` — was a JSONL-era hack that flagged
   * legitimate post-migration histories as stale and rebased the sidecar
   * baseline below the real high-water mark. The current logic trusts a
   * valid `.seq` value as the authoritative max-sequence read; the
   * line-count fallback is reserved for the genuinely-missing-or-corrupt
   * `.seq` case (no `.seq` file, or contents that don't parse as a
   * non-negative integer).
   *
   * For broken histories where line count diverges from max-sequence
   * (e.g. JSONL `[5,6,7]`), the JSONL line count would have returned 3,
   * causing sidecar synthetic sequences to start at 4 — colliding with
   * already-durable events at 5,6,7. Reading max-sequence from the JSONL
   * directly (via `SEQUENCE_REGEX`) gives the correct baseline.
   */
  private async readJsonlMaxSequence(streamId: string): Promise<number> {
    const mainPath = this.getEventFilePath(streamId);
    try {
      await fs.access(mainPath);
    } catch {
      return this.backend ? this.backend.getSequence(streamId) : 0;
    }

    const seqPath = this.getSeqFilePath(streamId);
    try {
      const content = await fs.readFile(seqPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed.sequence === 'number' && parsed.sequence >= 0) {
        // Trust the .seq value. Cross-validating against JSONL line count
        // mis-flagged broken histories that the migration explicitly
        // preserves (see CR thread 3205805932 / outside-diff for store.ts:858-879).
        return parsed.sequence;
      }
    } catch {
      // .seq missing or malformed — fall through to JSONL max-sequence scan.
    }

    // Fallback: scan JSONL for the highest persisted sequence. Uses
    // SEQUENCE_REGEX to avoid full JSON.parse per line; this is the same
    // recovery semantic AtomicAppender.rebuildCachesFromJsonl uses on
    // first contact, kept consistent so sidecar and appender agree on
    // the baseline.
    try {
      const jsonl = await fs.readFile(mainPath, 'utf-8');
      let maxSeq = 0;
      for (const line of jsonl.split('\n')) {
        if (line.length === 0) continue;
        const m = SEQUENCE_REGEX.exec(line);
        if (m) {
          const s = Number.parseInt(m[1], 10);
          if (Number.isFinite(s) && s > maxSeq) maxSeq = s;
        }
      }
      return maxSeq;
    } catch {
      return 0;
    }
  }

  /**
   * Read events from the main `{streamId}.events.jsonl` file.
   * Preserves the optimized fast-skip + early-termination loop used when no
   * sidecar events exist. Extracted so the merge path (issue #1082) can reuse
   * the same filter semantics without duplicating the loop.
   */
  private async queryMainJsonl(
    streamId: string,
    filters?: QueryFilters,
  ): Promise<WorkflowEvent[]> {
    const filePath = this.getEventFilePath(streamId);

    try {
      await fs.access(filePath);
    } catch {
      return [];
    }

    const events: WorkflowEvent[] = [];
    const input = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });

    let skipped = 0;
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit;

    // Pre-#1293, a "fast-skip" optimization assumed line N contains sequence
    // N and skipped by physical line count alone. After the migration
    // preserves corrupt histories (gaps, duplicates, offset starts), that
    // invariant no longer holds — `[5,6,7]` with `sinceSequence: 6` would
    // skip all three lines and miss event 7. Always use the regex-based
    // parsed-sequence comparison; the JSON.parse cost is paid only by
    // events that survive the filter, so the optimization wasn't load-
    // bearing for the common case anyway. (CR thread 3205805940 /
    // outside-diff for store.ts:911-922.)
    for await (const line of rl) {
      if (!line.trim()) continue;

      if (filters?.sinceSequence !== undefined) {
        const seqMatch = SEQUENCE_REGEX.exec(line);
        if (seqMatch) {
          const extractedSeq = parseInt(seqMatch[1], 10);
          if (!isNaN(extractedSeq) && extractedSeq <= filters.sinceSequence) continue;
        }
      }

      const parsed = JSON.parse(line);
      const event = migrateEvent(parsed) as WorkflowEvent;

      if (filters?.type && event.type !== filters.type) continue;
      if (filters?.since && event.timestamp < filters.since) continue;
      if (filters?.until && event.timestamp > filters.until) continue;

      if (skipped < offset) {
        skipped++;
        continue;
      }

      events.push(event);

      if (limit !== undefined && events.length >= limit) {
        rl.close();
        input.destroy();
        break;
      }
    }

    return events;
  }

  /**
   * Read the sidecar file for a stream, normalize each line into a
   * `WorkflowEvent` with a synthetic sequence continuing from `baseSequence`,
   * sort by timestamp, and apply query filters.
   *
   * Sidecar lines omit streamId/sequence/schemaVersion to keep hook writes
   * minimal; this method populates them so downstream materializers do not
   * need to special-case sidecar-sourced events.
   */
  private async readSidecarForQuery(
    streamId: string,
    baseSequence: number,
    filters?: QueryFilters,
  ): Promise<WorkflowEvent[]> {
    const sidecarPath = getSidecarPath(this.stateDir, streamId);
    let content: string;
    try {
      content = await fs.readFile(sidecarPath, 'utf-8');
    } catch {
      return [];
    }

    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return [];

    type SidecarRaw = {
      type: string;
      data?: Record<string, unknown>;
      timestamp?: string;
      idempotencyKey?: string;
    };
    const raw: SidecarRaw[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SidecarRaw;
        if (parsed && typeof parsed.type === 'string') {
          raw.push(parsed);
        }
      } catch {
        // Skip corrupt lines — the merger counts these as errors at merge time.
      }
    }

    // Stable sort by timestamp so synthetic sequences reflect causal order.
    raw.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));

    const events: WorkflowEvent[] = [];
    for (let i = 0; i < raw.length; i++) {
      const line = raw[i];
      const synthetic: WorkflowEvent = {
        streamId,
        sequence: baseSequence + i + 1,
        // Type assumed valid: sidecar writer validates at the workflow boundary
        // (`writeToSidecar` only accepts events already parsed by workflow tools).
        type: line.type as WorkflowEvent['type'],
        timestamp: line.timestamp ?? new Date(0).toISOString(),
        data: line.data ?? {},
        schemaVersion: '1.0',
        ...(line.idempotencyKey && { idempotencyKey: line.idempotencyKey }),
      };

      if (filters?.type && synthetic.type !== filters.type) continue;
      if (filters?.since && synthetic.timestamp < filters.since) continue;
      if (filters?.until && synthetic.timestamp > filters.until) continue;
      if (
        filters?.sinceSequence !== undefined
        && synthetic.sequence <= filters.sinceSequence
      ) {
        continue;
      }

      events.push(synthetic);
    }

    return events;
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
   * boundary before the JSONL/SQL layer ever sees them.
   *
   * This is the canonical reducer for `team.disbanded` emission: count
   * `task.completed` events across every subagent stream nested under the
   * feature stream, without reading any derived state (INV-1).
   *
   * Implementation note: when a `StorageBackend` is attached and exposes a
   * cross-stream query method, that path is preferred; otherwise the JSONL
   * directory is scanned for `<prefix>.events.jsonl` and
   * `<prefix>/<segment>.events.jsonl` files. Filters from `QueryFilters`
   * (sinceSequence, since, until, limit, offset) apply globally to the
   * merged result.
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

    // Backend fast-path: when the storage backend exposes a cross-stream
    // type query, use the SQL clause directly (`LIKE ? || '/%' OR = ?`)
    // and skip the per-stream merge below. Backends without the method
    // (in-memory, remote) fall through to the listStreams() enumeration.
    if (this.backend && typeof this.backend.queryEventsByType === 'function') {
      const backendEvents = this.backend.queryEventsByType(eventType, prefix, perStream);
      const sortedBackend = backendEvents.slice().sort((a, b) => {
        const byTs = a.timestamp.localeCompare(b.timestamp);
        return byTs !== 0 ? byTs : a.sequence - b.sequence;
      });
      const offset = filters?.offset ?? 0;
      const limit = filters?.limit;
      const slicedBackend = offset > 0 ? sortedBackend.slice(offset) : sortedBackend;
      return limit !== undefined ? slicedBackend.slice(0, limit) : slicedBackend;
    }

    // Stream selection (fallback): enumerate streams via backend.listStreams()
    // when present, plus the JSONL state-dir scan, then apply the structural
    // prefix filter locally.
    const matchingStreams = await this.listStreamsMatchingPrefix(prefix);

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
   * Enumerate streams whose `streamId` is the given prefix or a namespaced
   * descendant under it. Prefers the backend's `listStreams()` when available
   * (SQL query at the SqliteBackend layer reduces to
   * `WHERE streamId LIKE ? || '/%' OR streamId = ?`); otherwise scans the
   * state directory for matching `*.events.jsonl` files.
   *
   * Substring lookalikes (`feat-1-extra` for prefix `feat-1`) are excluded —
   * the namespaced form requires a literal `/` to be a descendant.
   */
  private async listStreamsMatchingPrefix(prefix: string): Promise<string[]> {
    const matches: string[] = [];
    const seen = new Set<string>();

    const considerStream = (streamId: string): void => {
      if (seen.has(streamId)) return;
      const isExact = streamId === prefix;
      const isDescendant = streamId.startsWith(`${prefix}/`);
      if (isExact || isDescendant) {
        matches.push(streamId);
        seen.add(streamId);
      }
    };

    // Backend path: trust listStreams() to enumerate every stream the
    // backend has seen; then apply the structural prefix filter locally
    // so the SQL/JSONL paths stay behaviourally indistinguishable.
    if (this.backend) {
      for (const streamId of this.backend.listStreams()) {
        considerStream(streamId);
      }
    }

    // JSONL path: walk `<stateDir>` plus `<stateDir>/<prefix>` (descendants
    // live one level deep under the feature directory). We only need two
    // top-level lookups: the parent stream's `<prefix>.events.jsonl` and
    // the descendants under `<prefix>/`.
    try {
      const topEntries = await fs.readdir(this.stateDir, { withFileTypes: true });
      for (const entry of topEntries) {
        if (entry.isFile() && entry.name.endsWith('.events.jsonl')) {
          const streamId = entry.name.slice(0, -'.events.jsonl'.length);
          considerStream(streamId);
        } else if (entry.isDirectory() && entry.name === prefix) {
          // A namespaced directory holds `<prefix>/<segment>.events.jsonl`.
          const childEntries = await fs.readdir(
            path.join(this.stateDir, entry.name),
            { withFileTypes: true },
          );
          for (const child of childEntries) {
            if (child.isFile() && child.name.endsWith('.events.jsonl')) {
              const segment = child.name.slice(0, -'.events.jsonl'.length);
              considerStream(`${prefix}/${segment}`);
            }
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    return matches;
  }

  /**
   * List all known stream IDs.
   * Delegates to backend when available; returns null otherwise
   * (caller should fall back to directory scanning).
   */
  listStreams(): string[] | null {
    if (this.backend) {
      return this.backend.listStreams();
    }
    return null;
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
   *   - No backend attached (JSONL-only install) → `{ok: 'skipped', ...}`
   *   - Backend attached but does not implement `runIntegrityPragma`
   *     (e.g. in-memory, remote) → `{ok: 'skipped', ...}`
   *   - Backend verdict exactly `"ok"` → `{ok: true}`
   *   - Any other verdict → `{ok: false, details}` (corruption)
   *   - Probe exceeds `timeoutMs` → `{ok: false, details: 'integrity_check timed out after Nms'}`
   *   - External abort → rejects with AbortError (caller-initiated
   *     cancellation is an exception, not a result)
   */
  async runIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<IntegrityResult> {
    if (!this.backend) {
      return {
        ok: 'skipped',
        reason: 'JSONL-only install; no sqlite backend attached',
      };
    }
    if (typeof this.backend.runIntegrityPragma !== 'function') {
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
      const probe = this.backend!.runIntegrityPragma!.bind(this.backend);
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
   * Clean up orphaned `.seq.tmp` files left behind by a crashed atomic
   * sequence write, and ensure the AtomicAppender will rebuild its
   * sequence counter for this stream from JSONL on next contact.
   *
   * Pre-#1293 this was the legacy "re-read sequence from disk" recovery
   * path used after a SequenceConflictError. The new substrate makes
   * sequence rebuild implicit (every first-contact append rebuilds from
   * JSONL under the lock), so this method now does only the housekeeping
   * the rebuild can't safely do during an append:
   *   - delete `<stream>.seq.tmp` if a previous process crashed mid-write.
   * Sequence counters live inside AtomicAppender and self-recover via the
   * normal append path.
   */
  async refreshSequence(streamId: string): Promise<void> {
    const tmpPath = `${this.getSeqFilePath(streamId)}.tmp`;
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

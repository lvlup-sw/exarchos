import * as fs from 'node:fs/promises';
import { createReadStream, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { WorkflowEventBase } from './schemas.js';
import type { WorkflowEvent } from './schemas.js';
import type { Outbox } from '../sync/outbox.js';
import type { StorageBackend } from '../storage/backend.js';
import { migrateEvent } from './event-migration.js';
import { storeLogger } from '../logger.js';
import { isPidAlive } from '../utils/process.js';
import { getSidecarPath } from './hook-event-writer.js';
import { validateStreamId } from '../shared/validation.js';

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

/** Parse an integer from an environment variable with a fallback default. */
function parseEnvInt(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return defaultValue;
  return parsed;
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
  private sequenceCounters: Map<string, number> = new Map();
  private locks: Map<string, Promise<void>> = new Map();

  /** In-memory dedup cache: streamId -> (idempotencyKey -> event) */
  private idempotencyCache: Map<string, Map<string, WorkflowEvent>> = new Map();
  /**
   * Maximum number of idempotency keys retained per stream.
   * Keys older than this limit are evicted via FIFO.
   * Retries with evicted keys will NOT be deduplicated.
   * Acceptable because retries occur within the same session, not across long time spans.
   */
  private readonly maxIdempotencyKeys: number;

  /** Tracks which streams have had their idempotency cache rebuilt from JSONL */
  private idempotencyCacheInitialized: Set<string> = new Set();

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

  constructor(private readonly stateDir: string, options?: EventStoreOptions) {
    this.lockFilePath = path.join(stateDir, '.event-store.lock');
    this.maxIdempotencyKeys = parseEnvInt('EXARCHOS_MAX_IDEMPOTENCY_KEYS', 200);
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

  private async withLock<T>(streamId: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.locks.get(streamId) ?? Promise.resolve();
    let release: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(streamId, lock);
    try {
      await existing;
      return await fn();
    } finally {
      release!();
      if (this.locks.get(streamId) === lock) {
        this.locks.delete(streamId);
      }
    }
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
    return this.withLock(streamId, async () => {
      const cached = await this.checkIdempotencyAndSequence(streamId, options);
      if (cached) return cached;

      const sequence = (this.sequenceCounters.get(streamId) ?? 0) + 1;

      const fullEvent = WorkflowEventBase.parse({
        ...event,
        streamId,
        sequence,
        timestamp: event.timestamp || new Date().toISOString(),
        idempotencyKey: options?.idempotencyKey ?? event.idempotencyKey,
      });

      await this.persistAndReplicate(streamId, fullEvent);
      this.sequenceCounters.set(streamId, sequence);
      return fullEvent;
    });
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
    return this.withLock(streamId, async () => {
      const cached = await this.checkIdempotencyAndSequence(streamId, options);
      if (cached) return cached;

      const sequence = (this.sequenceCounters.get(streamId) ?? 0) + 1;

      // Construct the final event WITHOUT Zod parse
      const fullEvent: WorkflowEvent = {
        ...event,
        streamId,
        sequence,
        timestamp: event.timestamp || new Date().toISOString(),
        idempotencyKey: options?.idempotencyKey ?? event.idempotencyKey,
      } as WorkflowEvent;

      await this.persistAndReplicate(streamId, fullEvent);
      this.sequenceCounters.set(streamId, sequence);
      return fullEvent;
    });
  }

  /**
   * Shared pre-append checks: rebuild idempotency cache, check for cached duplicate,
   * initialize sequence counter, and validate optimistic concurrency.
   * Returns the cached event if idempotency key matched, otherwise undefined.
   * Must be called within withLock().
   */
  private async checkIdempotencyAndSequence(
    streamId: string,
    options?: AppendOptions,
  ): Promise<WorkflowEvent | undefined> {
    // Rebuild idempotency cache from JSONL on first access per stream
    if (options?.idempotencyKey && !this.idempotencyCacheInitialized.has(streamId)) {
      await this.rebuildIdempotencyCache(streamId);
    }

    // Idempotency check: return cached event if key was already seen
    if (options?.idempotencyKey) {
      const streamCache = this.idempotencyCache.get(streamId);
      const cached = streamCache?.get(options.idempotencyKey);
      if (cached) return cached;
    }

    // Initialize sequence from file if not cached
    if (!this.sequenceCounters.has(streamId)) {
      await this.initializeSequence(streamId);
    }

    // Optimistic concurrency check
    if (options?.expectedSequence !== undefined) {
      // Re-read from file for freshest state
      await this.initializeSequence(streamId);
      const actualSequence = this.sequenceCounters.get(streamId) ?? 0;

      if (actualSequence !== options.expectedSequence) {
        throw new SequenceConflictError(options.expectedSequence, actualSequence);
      }
    }

    return undefined;
  }

  /**
   * Shared post-construct logic: write to JSONL, cache idempotency key,
   * dual-write to backend, and write to outbox.
   * Must be called within withLock().
   */
  private async persistAndReplicate(streamId: string, fullEvent: WorkflowEvent): Promise<void> {
    await this.writeEvents(streamId, [fullEvent]);
    this.cacheIdempotencyKey(streamId, fullEvent);

    // Backend dual-write: replicate to backend if available
    // JSONL is the source of truth; backend write failure is logged but does not fail the append
    if (this.backend) {
      try {
        this.backend.appendEvent(streamId, fullEvent);
      } catch (err) {
        storeLogger.warn(
          { err: err instanceof Error ? err.message : String(err), streamId, sequence: fullEvent.sequence },
          'Backend dual-write failed — stores may diverge',
        );
      }
    }

    /**
     * Outbox integration: write supplementary entry under the same lock.
     *
     * KNOWN LIMITATION — Atomicity gap: The JSONL event append (above) and
     * this outbox write are NOT transactionally atomic. A crash between them
     * could leave an event in JSONL without a corresponding outbox entry.
     * This is acceptable because:
     * 1. The outbox is supplementary — JSONL is the source of truth
     * 2. The sync layer reconciles from JSONL, catching any missed entries
     * 3. In-process lock serialization prevents concurrent partial writes
     */
    if (this.outbox) {
      try {
        await this.outbox.addEntry(streamId, fullEvent);
      } catch (err) {
        // Outbox is supplementary; log but don't fail the append
        storeLogger.error({ err: err instanceof Error ? err.message : String(err) }, 'Outbox entry failed');
      }
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
    return this.withLock(streamId, async () => {
      // Rebuild idempotency cache if any event has an idempotency key
      const hasIdempotencyKeys = events.some(e => e.idempotencyKey);
      if (hasIdempotencyKeys && !this.idempotencyCacheInitialized.has(streamId)) {
        await this.rebuildIdempotencyCache(streamId);
      }

      // Initialize sequence from file if not cached
      if (!this.sequenceCounters.has(streamId)) {
        await this.initializeSequence(streamId);
      }

      // Phase 1: Validate all events before writing any (atomic: all-or-nothing)
      const toAppend: WorkflowEvent[] = [];
      const batchKeys = new Set<string>();
      let nextSequence = (this.sequenceCounters.get(streamId) ?? 0) + 1;

      for (const event of events) {
        // Idempotency dedup within batch and against cache
        if (event.idempotencyKey) {
          const streamCache = this.idempotencyCache.get(streamId);
          const cached = streamCache?.get(event.idempotencyKey);
          if (cached) continue;

          // Also check within this batch (O(1) Set lookup)
          if (batchKeys.has(event.idempotencyKey)) continue;
          batchKeys.add(event.idempotencyKey);
        }

        const fullEvent = WorkflowEventBase.parse({
          ...event,
          streamId,
          sequence: nextSequence,
          timestamp: event.timestamp || new Date().toISOString(),
          idempotencyKey: event.idempotencyKey,
        });
        toAppend.push(fullEvent);
        nextSequence++;
      }

      // Phase 2: Write all validated events in a single append
      if (toAppend.length > 0) {
        await this.writeEvents(streamId, toAppend);
        for (const fullEvent of toAppend) {
          this.cacheIdempotencyKey(streamId, fullEvent);
        }

        // Backend dual-write: replicate batch to backend if available
        if (this.backend) {
          try {
            for (const fullEvent of toAppend) {
              this.backend.appendEvent(streamId, fullEvent);
            }
          } catch (err) {
            storeLogger.warn(
              { err: err instanceof Error ? err.message : String(err), streamId, count: toAppend.length },
              'Backend batch dual-write failed — stores may diverge',
            );
          }
        }

        // Outbox replication: write entries for at-least-once delivery
        if (this.outbox) {
          for (const fullEvent of toAppend) {
            try {
              await this.outbox.addEntry(streamId, fullEvent);
            } catch (err) {
              storeLogger.error(
                { err: err instanceof Error ? err.message : String(err) },
                'Outbox entry failed during batch append',
              );
            }
          }
        }
      }

      return toAppend;
    });
  }

  // ─── Shared Helpers ────────────────────────────────────────────────────────

  /** Writes events to JSONL and updates the .seq counter file. */
  private async writeEvents(streamId: string, events: WorkflowEvent[]): Promise<void> {
    if (events.length === 0) return;

    const filePath = this.getEventFilePath(streamId);

    // Ensure directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // Append as JSONL
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.appendFile(filePath, lines, 'utf-8');

    // Update in-memory sequence counter
    const finalSequence = events[events.length - 1].sequence;
    this.sequenceCounters.set(streamId, finalSequence);

    // Write sequence counter atomically (best-effort: JSONL is source of truth)
    const seqPath = this.getSeqFilePath(streamId);
    const tmpPath = `${seqPath}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify({ sequence: finalSequence }), 'utf-8');
      await fs.rename(tmpPath, seqPath);
    } catch {
      // Best-effort: JSONL is source of truth, .seq is just a cache
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      await fs.rm(seqPath, { force: true }).catch(() => {});
    }
  }

  /** Caches an event's idempotency key with FIFO eviction. */
  private cacheIdempotencyKey(streamId: string, event: WorkflowEvent): void {
    if (!event.idempotencyKey) return;

    let streamCache = this.idempotencyCache.get(streamId);
    if (!streamCache) {
      streamCache = new Map();
      this.idempotencyCache.set(streamId, streamCache);
    }
    streamCache.set(event.idempotencyKey, event);

    // FIFO eviction: remove oldest key when cache exceeds max
    if (streamCache.size > this.maxIdempotencyKeys) {
      const oldest = streamCache.keys().next().value;
      if (oldest) streamCache.delete(oldest);
    }
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
    // `persistAndReplicate`), so `backend.getSequence()` can lag the real
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
   * events when the backend is lagging — the JSONL append is the barrier
   * for correctness (see `persistAndReplicate`: JSONL is source of truth,
   * backend dual-write is best-effort). Prefers the O(1) `.seq` file and
   * falls back to JSONL line-counting; returns the backend sequence only
   * when no local JSONL exists.
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
        // Cross-validate against JSONL so a stale .seq (e.g. interrupted
        // write) doesn't feed the sidecar path a wrong baseline.
        try {
          const jsonl = await fs.readFile(mainPath, 'utf-8');
          const lineCount = jsonl.trim().split('\n').filter(Boolean).length;
          if (parsed.sequence === lineCount) return parsed.sequence;
        } catch {
          return parsed.sequence;
        }
      }
    } catch {
      // .seq unreadable — fall through to JSONL line count.
    }

    try {
      const jsonl = await fs.readFile(mainPath, 'utf-8');
      return jsonl.trim().split('\n').filter(Boolean).length;
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

    // Fast-skip relies on the invariant that line N contains sequence N
    // (monotonically increasing); only safe when filtering solely by sequence.
    const canFastSkip = filters?.sinceSequence !== undefined
      && !filters.type && !filters.since && !filters.until;
    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      if (canFastSkip && lineCount <= filters!.sinceSequence!) continue;

      if (!canFastSkip && filters?.sinceSequence !== undefined) {
        const seqMatch = SEQUENCE_REGEX.exec(line);
        if (seqMatch) {
          const extractedSeq = parseInt(seqMatch[1], 10);
          if (!isNaN(extractedSeq) && extractedSeq <= filters.sinceSequence) continue;
        }
      }

      const parsed = JSON.parse(line);
      const event = migrateEvent(parsed) as WorkflowEvent;

      if (!canFastSkip) {
        if (filters?.type && event.type !== filters.type) continue;
        if (filters?.since && event.timestamp < filters.since) continue;
        if (filters?.until && event.timestamp > filters.until) continue;
      }

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

  async refreshSequence(streamId: string): Promise<void> {
    await this.initializeSequence(streamId);
  }

  private async rebuildIdempotencyCache(streamId: string): Promise<void> {
    if (this.idempotencyCacheInitialized.has(streamId)) return;
    // Do NOT mark as initialized yet — wait until cache is fully populated

    const filePath = this.getEventFilePath(streamId);
    try {
      await fs.access(filePath);
    } catch {
      this.idempotencyCacheInitialized.add(streamId); // Mark even if no file
      return;
    }

    const input = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });

    // Collect all events with idempotency keys
    const keyed: Array<{ key: string; event: WorkflowEvent }> = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      // Pre-filter: skip lines that don't contain an idempotency key (avoids JSON.parse)
      if (!line.includes('"idempotencyKey"')) continue;
      const event = JSON.parse(line) as WorkflowEvent;
      if (event.idempotencyKey) {
        keyed.push({ key: event.idempotencyKey, event });
      }
    }

    // Take only the last MAX_IDEMPOTENCY_KEYS entries
    const toCache = keyed.slice(-this.maxIdempotencyKeys);

    if (toCache.length > 0) {
      const streamCache = new Map<string, WorkflowEvent>();
      for (const { key, event } of toCache) {
        streamCache.set(key, event);
      }
      this.idempotencyCache.set(streamId, streamCache);
    }

    this.idempotencyCacheInitialized.add(streamId); // Mark AFTER fully populated
  }

  private async initializeSequence(streamId: string): Promise<void> {
    // Delegate to backend if available
    if (this.backend) {
      const seq = this.backend.getSequence(streamId);
      this.sequenceCounters.set(streamId, seq);
      return;
    }

    // Try .seq file first (O(1)), cross-validated against JSONL line count
    const seqPath = this.getSeqFilePath(streamId);
    // Clean up orphaned .seq.tmp files left by crashed atomic writes
    const tmpPath = `${seqPath}.tmp`;
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    try {
      const content = await fs.readFile(seqPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed.sequence === 'number' && parsed.sequence >= 0) {
        // Cross-validate against JSONL line count to detect stale .seq files
        const filePath = this.getEventFilePath(streamId);
        try {
          const jsonlContent = await fs.readFile(filePath, 'utf-8');
          const lineCount = jsonlContent.trim().split('\n').filter(Boolean).length;
          if (parsed.sequence !== lineCount) {
            storeLogger.warn(
              { streamId, seqFile: parsed.sequence, jsonlLines: lineCount },
              'Stale .seq detected — falling through to JSONL',
            );
            // Fall through to JSONL line counting below
          } else {
            this.sequenceCounters.set(streamId, parsed.sequence);
            return;
          }
        } catch {
          // JSONL unreadable — trust .seq value
          this.sequenceCounters.set(streamId, parsed.sequence);
          return;
        }
      }
    } catch {
      // Fall through to line counting
    }

    // Fallback: count lines in JSONL file (O(n)) with full monotonicity validation
    const filePath = this.getEventFilePath(streamId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      if (lines.length > 0) {
        // Full monotonicity check: every event must have sequence === lineIndex + 1
        let needsRepair = false;
        for (let i = 0; i < lines.length; i++) {
          const match = SEQUENCE_REGEX.exec(lines[i]);
          const seq = match ? parseInt(match[1], 10) : NaN;
          if (seq !== i + 1) {
            needsRepair = true;
            break;
          }
        }

        if (needsRepair) {
          storeLogger.warn(
            { streamId, lineCount: lines.length },
            'Sequence corruption detected — repairing stream with monotonic re-sequencing',
          );
          // Re-sequence all events with correct monotonic sequence numbers
          const repaired: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            const event = JSON.parse(lines[i]) as WorkflowEvent;
            const fixed = { ...event, sequence: i + 1 };
            repaired.push(JSON.stringify(fixed));
          }
          const tmpJsonl = `${filePath}.repair.tmp`;
          await fs.writeFile(tmpJsonl, repaired.join('\n') + '\n', 'utf-8');
          await fs.rename(tmpJsonl, filePath);
          // Update .seq cache to match repaired state
          const seqPath = this.getSeqFilePath(streamId);
          const tmpPath = `${seqPath}.tmp`;
          try {
            await fs.writeFile(tmpPath, JSON.stringify({ sequence: lines.length }), 'utf-8');
            await fs.rename(tmpPath, seqPath);
          } catch {
            await fs.rm(tmpPath, { force: true }).catch(() => {});
          }
        }
      }

      this.sequenceCounters.set(streamId, lines.length);
    } catch (err) {
      storeLogger.warn(
        { streamId, err: err instanceof Error ? err.message : String(err) },
        'Failed to initialize sequence from JSONL — defaulting to 0',
      );
      this.sequenceCounters.set(streamId, 0);
    }
  }
}

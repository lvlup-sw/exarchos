import * as fs from 'node:fs/promises';
import { createReadStream, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import * as path from 'node:path';
import { WorkflowEventBase } from './schemas.js';
import type { WorkflowEvent } from './schemas.js';

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

export class PidLockError extends Error {
  constructor(
    public readonly existingPid: number,
  ) {
    super(
      `Event store is locked by live process PID ${existingPid}`,
    );
    this.name = 'PidLockError';
  }
}

// ─── PID Helpers ─────────────────────────────────────────────────────────────

/** Check if a process with the given PID is alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

// ─── Stream ID Validation ────────────────────────────────────────────────────

const SAFE_STREAM_ID_PATTERN = /^[a-z0-9-]+$/;

/** Validates that a stream ID matches the safe pattern (lowercase alphanumeric and hyphens). */
function validateStreamId(streamId: string): void {
  if (!SAFE_STREAM_ID_PATTERN.test(streamId)) {
    throw new Error(
      `Invalid streamId "${streamId}": must match ${SAFE_STREAM_ID_PATTERN} (lowercase alphanumeric and hyphens only)`,
    );
  }
}

/** Parse an integer from an environment variable with a fallback default. */
function parseEnvInt(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

// ─── Event Store ────────────────────────────────────────────────────────────

/**
 * Append-only event store backed by JSONL files with .seq sequence caches.
 *
 * Uses in-memory promise-chain locks that only protect within a single Node.js process.
 * Multiple EventStore instances sharing the same stateDir will corrupt data.
 * The MCP server ensures a single EventStore per stateDir via the singleton in views/tools.ts.
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

  /** Path to the PID lock file */
  private lockFilePath: string;

  constructor(private readonly stateDir: string) {
    this.lockFilePath = path.join(stateDir, '.event-store.lock');
    this.maxIdempotencyKeys = parseEnvInt('EXARCHOS_MAX_IDEMPOTENCY_KEYS', 200);
  }

  // ─── PID Lock ──────────────────────────────────────────────────────────────

  /**
   * Initialize the event store: acquire PID lock and register cleanup handler.
   * Must be called before first use when cross-process safety is needed.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.acquirePidLock();
    this.initialized = true;
  }

  private async acquirePidLock(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });

    try {
      // Attempt atomic creation
      const fd = openSync(this.lockFilePath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Lock file exists — check if holding PID is alive
      const content = await fs.readFile(this.lockFilePath, 'utf-8');
      const existingPid = parseInt(content.trim(), 10);

      if (!isNaN(existingPid) && isPidAlive(existingPid)) {
        throw new PidLockError(existingPid);
      }

      // Stale lock — reclaim by overwriting
      await fs.writeFile(this.lockFilePath, String(process.pid), 'utf-8');
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
    return this.withLock(streamId, async () => {
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

      const sequence = (this.sequenceCounters.get(streamId) ?? 0) + 1;
      this.sequenceCounters.set(streamId, sequence);

      const fullEvent = WorkflowEventBase.parse({
        ...event,
        streamId,
        sequence,
        timestamp: event.timestamp || new Date().toISOString(),
        idempotencyKey: options?.idempotencyKey,
      });

      await this.writeEvents(streamId, [fullEvent]);
      this.cacheIdempotencyKey(streamId, fullEvent);

      return fullEvent;
    });
  }

  async batchAppend(
    streamId: string,
    events: Array<Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & { type: string; idempotencyKey?: string }>,
  ): Promise<WorkflowEvent[]> {
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
    const filePath = this.getEventFilePath(streamId);

    // Check if file exists
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

    // Fast path: when only sinceSequence is set (no type/date filtering),
    // skip JSON.parse for lines where lineCount <= sinceSequence.
    // This works because line N contains sequence N (monotonically increasing).
    const canFastSkip = filters?.sinceSequence !== undefined
      && !filters.type && !filters.since && !filters.until;
    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      // Fast skip: line N = sequence N, skip without parsing
      if (canFastSkip && lineCount <= filters!.sinceSequence!) continue;

      const event = JSON.parse(line) as WorkflowEvent;

      // Apply filters for non-fast-path (sinceSequence still needs checking when combined with other filters)
      if (!canFastSkip) {
        if (filters?.sinceSequence !== undefined && event.sequence <= filters.sinceSequence) continue;
        if (filters?.type && event.type !== filters.type) continue;
        if (filters?.since && event.timestamp < filters.since) continue;
        if (filters?.until && event.timestamp > filters.until) continue;
      }

      // Apply offset
      if (skipped < offset) {
        skipped++;
        continue;
      }

      events.push(event);

      // Early termination on limit
      if (limit !== undefined && events.length >= limit) {
        rl.close();
        input.destroy();
        break;
      }
    }

    return events;
  }

  async refreshSequence(streamId: string): Promise<void> {
    await this.initializeSequence(streamId);
  }

  private async rebuildIdempotencyCache(streamId: string): Promise<void> {
    if (this.idempotencyCacheInitialized.has(streamId)) return;
    this.idempotencyCacheInitialized.add(streamId);

    const filePath = this.getEventFilePath(streamId);
    try {
      await fs.access(filePath);
    } catch {
      return; // No events file yet
    }

    const input = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });

    // Collect all events with idempotency keys
    const keyed: Array<{ key: string; event: WorkflowEvent }> = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
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
  }

  private async initializeSequence(streamId: string): Promise<void> {
    // Try .seq file first (O(1))
    const seqPath = this.getSeqFilePath(streamId);
    // Clean up orphaned .seq.tmp files left by crashed atomic writes
    const tmpPath = `${seqPath}.tmp`;
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    try {
      const content = await fs.readFile(seqPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (typeof parsed.sequence === 'number' && parsed.sequence >= 0) {
        this.sequenceCounters.set(streamId, parsed.sequence);
        return;
      }
    } catch {
      // Fall through to line counting
    }

    // Fallback: count lines in JSONL file (O(n)) with sequence invariant validation
    const filePath = this.getEventFilePath(streamId);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      // Sequence invariant validation: sample first and last line
      if (lines.length > 0) {
        const firstEvent = JSON.parse(lines[0]) as WorkflowEvent;
        if (firstEvent.sequence !== 1) {
          throw new Error(
            `Sequence invariant violated for stream '${streamId}': first event has sequence ${firstEvent.sequence}, expected 1`,
          );
        }

        const lastEvent = JSON.parse(lines[lines.length - 1]) as WorkflowEvent;
        if (lastEvent.sequence !== lines.length) {
          throw new Error(
            `Sequence invariant violated for stream '${streamId}': last event has sequence ${lastEvent.sequence}, expected ${lines.length}`,
          );
        }
      }

      this.sequenceCounters.set(streamId, lines.length);
    } catch (err) {
      // Re-throw sequence invariant errors
      if (err instanceof Error && err.message.includes('Sequence invariant')) {
        throw err;
      }
      this.sequenceCounters.set(streamId, 0);
    }
  }
}

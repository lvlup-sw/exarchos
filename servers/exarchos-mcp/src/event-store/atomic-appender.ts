import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * AtomicAppender — single-writer-per-stream append primitive (v2.9.0).
 *
 * Closes the substrate-level half of #1230 (overlapping sequence allocation under
 * concurrency) and #1228 (phantom idempotencyKey claim on partial-write failure).
 *
 * The four-phase append (validate → allocate sequences → write JSONL → write .seq
 * → cache idempotencyKey) is serialized per stream with a Promise-chain mutex
 * (no `async-mutex` dep — the chain primitive is ~5 lines and matches semantics).
 * The idempotencyKey cache mutation is the LAST step: it commits ONLY after JSONL
 * and `.seq` writes both succeed. A failed append leaves the key uncommitted, so
 * retries are admissible (the bug #1228 closes).
 *
 * This module is a NEW substrate; the existing four-phase path in `store.ts` is
 * intentionally untouched in this commit. Consumer migration lands in C2.
 *
 * The interface is the seam #1259's SQLite implementation drops into: same
 * `AppendResult` shape, same per-stream serialization semantics.
 */

export type AppendResult =
  | { ok: true; sequences: number[]; eventIds: string[] }
  | { ok: false; reason: 'idempotency-claimed' | 'sequence-conflict' | 'io-error'; cause?: Error };

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
 * Test-only failure-injection hook.
 *
 * Receives the phase being executed (`'jsonl'` or `'seq'`), the absolute file
 * path the default writer would target, the contents the default writer would
 * write, and a `runDefault` callback that performs the actual filesystem write.
 *
 * Production code passes no `writeFn`; the appender uses the default writer.
 * Tests can throw before / after / instead of calling `runDefault` to simulate
 * partial failures deterministically.
 */
export type WriteFn = (
  phase: 'jsonl' | 'seq',
  filePath: string,
  contents: string,
  runDefault: () => Promise<void>,
) => Promise<void>;

export interface AtomicAppenderOptions {
  /** Directory under which `<streamId>.events.jsonl` and `<streamId>.seq` live. */
  stateDir: string;
  /** Test-only failure-injection writer; defaults to the production filesystem writer. */
  writeFn?: WriteFn;
  /**
   * Per-stream cap on cached idempotencyKey entries. Defaults to env
   * `EXARCHOS_MAX_IDEMPOTENCY_KEYS` (or 200 when unset / invalid). Eviction
   * is FIFO (insertion order) — matches the legacy `EventStore` semantics
   * at `event-store/store.ts:798`.
   */
  maxIdempotencyKeys?: number;
}

function parseEnvInt(envVar: string, defaultValue: number): number {
  const raw = process.env[envVar];
  if (raw === undefined) return defaultValue;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return defaultValue;
  return parsed;
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

const SEQUENCE_REGEX = /"sequence":(\d+)/;

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
  private readonly writeFn?: WriteFn;
  private readonly locks = new StreamLockManager();
  /** Per-stream in-memory sequence high-water mark. Authoritative source is JSONL. */
  private readonly sequenceCounters = new Map<string, number>();
  /** streamId → idempotencyKey → committed event(s). Populated only after success. */
  private readonly idempotencyCache = new Map<string, Map<string, PersistedEvent[]>>();
  private readonly idempotencyInitialized = new Set<string>();
  /** Per-stream cap on idempotencyCache size; FIFO eviction matches legacy EventStore. */
  private readonly maxIdempotencyKeys: number;

  constructor(options: AtomicAppenderOptions) {
    this.stateDir = options.stateDir;
    this.writeFn = options.writeFn;
    this.maxIdempotencyKeys =
      options.maxIdempotencyKeys ?? parseEnvInt('EXARCHOS_MAX_IDEMPOTENCY_KEYS', 200);
  }

  async append(
    streamId: string,
    events: EventInput[],
    idempotencyKey: string,
  ): Promise<AppendResult> {
    return this.locks.runExclusive(streamId, () => this.appendLocked(streamId, events, idempotencyKey));
  }

  private async appendLocked(
    streamId: string,
    events: EventInput[],
    idempotencyKey: string,
  ): Promise<AppendResult> {
    // ─── Phase 1: validate ───────────────────────────────────────────────
    if (!streamId || streamId.length === 0) {
      return { ok: false, reason: 'io-error', cause: new Error('streamId required') };
    }
    if (!Array.isArray(events) || events.length === 0) {
      return { ok: false, reason: 'io-error', cause: new Error('events must be non-empty array') };
    }
    if (!idempotencyKey || idempotencyKey.length === 0) {
      return { ok: false, reason: 'io-error', cause: new Error('idempotencyKey required') };
    }

    // Idempotency check — rebuild cache from JSONL on first contact with stream.
    if (!this.idempotencyInitialized.has(streamId)) {
      try {
        await this.rebuildCachesFromJsonl(streamId);
      } catch (err) {
        return { ok: false, reason: 'io-error', cause: toError(err) };
      }
      this.idempotencyInitialized.add(streamId);
    }
    const streamIdemCache = this.idempotencyCache.get(streamId);
    const cachedEvents = streamIdemCache?.get(idempotencyKey);
    if (cachedEvents && cachedEvents.length > 0) {
      return {
        ok: true,
        sequences: cachedEvents.map(e => e.sequence),
        eventIds: cachedEvents.map(e => e.eventId),
      };
    }

    // ─── Phase 2: allocate sequences ─────────────────────────────────────
    const baseSeq = (this.sequenceCounters.get(streamId) ?? 0);
    const persisted: PersistedEvent[] = events.map((evt, i) => ({
      ...evt,
      streamId,
      sequence: baseSeq + i + 1,
      timestamp: evt.timestamp ?? new Date().toISOString(),
      type: evt.type,
      eventId: randomUUID(),
      idempotencyKey,
    }));
    const finalSequence = persisted[persisted.length - 1].sequence;

    // ─── Phase 3: write JSONL ────────────────────────────────────────────
    const jsonlPath = this.getEventFilePath(streamId);
    const seqPath = this.getSeqFilePath(streamId);
    const lines = persisted.map(e => JSON.stringify(e)).join('\n') + '\n';
    try {
      await fs.mkdir(path.dirname(jsonlPath), { recursive: true });
      await this.runWrite('jsonl', jsonlPath, lines, async () => {
        await fs.appendFile(jsonlPath, lines, 'utf-8');
      });
    } catch (err) {
      // No partial state to roll back: nothing was written, idempotencyKey
      // never reached the cache, sequence counter never advanced.
      return { ok: false, reason: 'io-error', cause: toError(err) };
    }

    // ─── Phase 4: write .seq ─────────────────────────────────────────────
    // Failure here is structured: the JSONL is the source of truth, but the
    // caller MUST NOT see a silent success — that's exactly what hid #1228.
    // We unwind the JSONL append on .seq failure to preserve the all-or-none
    // contract callers rely on.
    const tmpPath = `${seqPath}.tmp`;
    const seqContents = JSON.stringify({ sequence: finalSequence });
    try {
      await this.runWrite('seq', seqPath, seqContents, async () => {
        await fs.writeFile(tmpPath, seqContents, 'utf-8');
        await fs.rename(tmpPath, seqPath);
      });
    } catch (err) {
      // Roll back the JSONL append: rewrite the file without the lines we just
      // appended. Best-effort cleanup of any tmp file. If rollback itself fails,
      // we still surface the original .seq failure (the JSONL on-disk state
      // becomes the recovery target for the next appender via the cache rebuild).
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      await this.rollbackJsonlAppend(jsonlPath, persisted.length).catch(() => {});
      return { ok: false, reason: 'io-error', cause: toError(err) };
    }

    // ─── Phase 5: cache idempotencyKey (commit point) ────────────────────
    // ONLY reached if all prior phases succeeded. This is the bug-#1228 fix:
    // the key is admissible for retry until and unless the append commits.
    let cache = this.idempotencyCache.get(streamId);
    if (!cache) {
      cache = new Map();
      this.idempotencyCache.set(streamId, cache);
    }
    cache.set(idempotencyKey, persisted);
    // FIFO eviction at cap — matches legacy EventStore.cacheIdempotencyKey
    // semantics (store.ts:798). Map iteration order is insertion order, so
    // `keys().next().value` is the oldest entry.
    while (cache.size > this.maxIdempotencyKeys) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    this.sequenceCounters.set(streamId, finalSequence);

    return {
      ok: true,
      sequences: persisted.map(e => e.sequence),
      eventIds: persisted.map(e => e.eventId),
    };
  }

  private async runWrite(
    phase: 'jsonl' | 'seq',
    filePath: string,
    contents: string,
    runDefault: () => Promise<void>,
  ): Promise<void> {
    if (this.writeFn) {
      await this.writeFn(phase, filePath, contents, runDefault);
    } else {
      await runDefault();
    }
  }

  /**
   * Rebuild sequence counter and idempotencyKey cache from JSONL on first
   * contact with a stream. Cheap on cold start; subsequent appends use the
   * in-memory counters.
   */
  private async rebuildCachesFromJsonl(streamId: string): Promise<void> {
    const filePath = this.getEventFilePath(streamId);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return; // fresh stream
      }
      throw err;
    }
    let maxSeq = 0;
    const cache = new Map<string, PersistedEvent[]>();
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      const seqMatch = SEQUENCE_REGEX.exec(line);
      if (seqMatch) {
        const s = Number.parseInt(seqMatch[1], 10);
        if (s > maxSeq) maxSeq = s;
      }
      let parsed: PersistedEvent;
      try {
        parsed = JSON.parse(line) as PersistedEvent;
      } catch {
        continue; // skip malformed line; JSONL is source of truth, but tolerate corruption
      }
      if (parsed.idempotencyKey) {
        const existing = cache.get(parsed.idempotencyKey) ?? [];
        existing.push(parsed);
        cache.set(parsed.idempotencyKey, existing);
        // FIFO eviction at cap during rebuild — preserves the most-recent
        // N keys (matches legacy `keyed.slice(-this.maxIdempotencyKeys)` at
        // store.ts:1227 since insertion order tracks file order).
        while (cache.size > this.maxIdempotencyKeys) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
    }
    this.sequenceCounters.set(streamId, maxSeq);
    this.idempotencyCache.set(streamId, cache);
  }

  /**
   * Truncate the most-recent N JSONL lines from a stream file. Used to unwind
   * a partial append on `.seq` failure so the caller's all-or-none contract
   * holds. JSONL is line-delimited so truncation by line count is safe.
   */
  private async rollbackJsonlAppend(filePath: string, lineCount: number): Promise<void> {
    const raw = await fs.readFile(filePath, 'utf-8');
    // The append wrote `lines.join('\n') + '\n'` so the file ends with a
    // newline-terminated block of `lineCount` lines. Drop them.
    const allLines = raw.split('\n');
    // The trailing '\n' after the last newline yields an empty final element;
    // preserve that to keep the file's line-terminator semantics consistent.
    const trailingEmpty = allLines[allLines.length - 1] === '' ? 1 : 0;
    const keep = allLines.slice(0, allLines.length - lineCount - trailingEmpty);
    const rewritten = keep.length === 0 ? '' : keep.join('\n') + '\n';
    await fs.writeFile(filePath, rewritten, 'utf-8');
  }

  private getEventFilePath(streamId: string): string {
    return path.join(this.stateDir, `${streamId}.events.jsonl`);
  }

  private getSeqFilePath(streamId: string): string {
    return path.join(this.stateDir, `${streamId}.seq`);
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

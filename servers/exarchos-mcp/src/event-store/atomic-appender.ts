import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { validateStreamId } from '../shared/validation.js';

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

/**
 * Public-shaped persisted event surfaced on cache-hit so callers can return
 * the actual stored shape (not a synthesized event from the request body).
 *
 * Mirrors the internal `PersistedEvent` but is exported so consumers like
 * `EventStore.delegateAppend` can hand it back to their own callers without
 * reaching into AtomicAppender internals.
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
      reason: 'idempotency-claimed' | 'sequence-conflict' | 'io-error';
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
 * `appendComputed` callback — the check runs after `rebuildCachesFromJsonl`
 * which is the same lock context the callback is already holding. The
 * caller's outer-most `append` invocation owns the check.
 */
export interface AppendOptions {
  /**
   * The current sequence counter the caller observed before issuing this
   * append. Compared against the in-memory counter under the per-stream
   * lock; a mismatch returns `{ ok: false, reason: 'sequence-conflict',
   * expected, actual }` so the caller can translate to a typed error
   * without needing access to internal state.
   */
  expectedSequence?: number;
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
    options?: AppendOptions,
  ): Promise<AppendResult> {
    return this.locks.runExclusive(streamId, () =>
      this.appendLocked(streamId, events, { idempotencyKey }, options),
    );
  }

  /**
   * Append without idempotency dedup.
   *
   * Used by callers (e.g. `EventStore.append` for events without an explicit
   * key) that want a single write but no cache entry. Equivalent to passing
   * a synthetic key, except:
   *   - The idempotency cache is NOT polluted with one-shot keys (which
   *     would FIFO-evict legitimate retry keys at the configured cap).
   *   - The persisted event has `idempotencyKey: undefined`, so a JSONL
   *     scan will not associate it with any retry chain.
   *
   * Sequence allocation, JSONL write, .seq write, and rollback semantics
   * are identical to `append`.
   */
  async appendUnkeyed(
    streamId: string,
    events: EventInput[],
    options?: AppendOptions,
  ): Promise<AppendResult> {
    return this.locks.runExclusive(streamId, () =>
      this.appendLocked(streamId, events, null, options),
    );
  }

  /**
   * Compute-then-append under a single per-stream lock.
   *
   * `compute` runs while the per-stream lock is held; the events it returns
   * are appended in the same critical section. This is the primitive
   * `SubagentStreamRouter.emitDisbanded` needs: it queries the parent stream
   * for `task.completed` events scoped to a team and immediately appends
   * `team.disbanded` with the count. Without the lock-coupled compute,
   * concurrent `onTaskCompleted` calls (which are serialized through the
   * same lock) can be in flight when the read happens, producing a stale
   * count and an off-by-N `tasksCompleted` — the exact regression #1224
   * was meant to close.
   *
   * `compute` must NOT call back into `append`/`appendComputed` for the
   * same `streamId`: the Promise-chain mutex is non-reentrant and a
   * recursive call deadlocks the chain. Side reads (e.g. `fs.readFile`
   * on the JSONL) are fine.
   */
  async appendComputed(
    streamId: string,
    idempotencyKey: string,
    compute: () => Promise<EventInput[]>,
  ): Promise<AppendResult> {
    return this.locks.runExclusive(streamId, async () => {
      const events = await compute();
      return this.appendLocked(streamId, events, { idempotencyKey });
    });
  }

  private async appendLocked(
    streamId: string,
    events: EventInput[],
    keyed: { idempotencyKey: string } | null,
    options?: AppendOptions,
  ): Promise<AppendResult> {
    // ─── Phase 1: validate ───────────────────────────────────────────────
    if (!streamId || streamId.length === 0) {
      return { ok: false, reason: 'io-error', cause: new Error('streamId required') };
    }
    // Defense in depth: reject streamIds that could escape `stateDir` via
    // path separators or `..` segments. EventStore consumers already
    // validate at the boundary, but AtomicAppender is also exposed to
    // SubagentStreamRouter and event_batch_append directly; a guard here
    // means future consumers can't bypass it.
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

    // Idempotency check — rebuild cache from JSONL on first contact with stream.
    // Even unkeyed appends rebuild here so the sequence counter is authoritative
    // (the `.seq` value is read during rebuild). Skipping the rebuild for
    // unkeyed callers would re-introduce overlapping-allocation under
    // concurrency from a fresh process.
    if (!this.idempotencyInitialized.has(streamId)) {
      try {
        await this.rebuildCachesFromJsonl(streamId);
      } catch (err) {
        return { ok: false, reason: 'io-error', cause: toError(err) };
      }
      this.idempotencyInitialized.add(streamId);
    }
    if (keyed !== null) {
      const streamIdemCache = this.idempotencyCache.get(streamId);
      const cachedEvents = streamIdemCache?.get(keyed.idempotencyKey);
      if (cachedEvents && cachedEvents.length > 0) {
        return {
          ok: true,
          kind: 'cache-hit',
          sequences: cachedEvents.map(e => e.sequence),
          eventIds: cachedEvents.map(e => e.eventId),
          timestamps: cachedEvents.map(e => e.timestamp),
          // Surface the originally-persisted events so callers don't
          // reconstruct from the (possibly different) current request
          // payload — that's the bug CR-thread #3205805943 closes.
          persistedEvents: cachedEvents.map(e => ({ ...e } as PublicPersistedEvent)),
        };
      }
    }

    // ─── Phase 1b: optimistic-concurrency check ──────────────────────────
    // Compare the caller's observed sequence (if any) against the
    // post-rebuild authoritative counter. Mismatch returns a typed result
    // so callers can translate to their own error shape (e.g.
    // EventStore.SequenceConflictError) without reaching into internals.
    if (options?.expectedSequence !== undefined) {
      const actual = this.sequenceCounters.get(streamId) ?? 0;
      if (actual !== options.expectedSequence) {
        return {
          ok: false,
          reason: 'sequence-conflict',
          expected: options.expectedSequence,
          actual,
        };
      }
    }

    // ─── Phase 2: allocate sequences ─────────────────────────────────────
    const baseSeq = (this.sequenceCounters.get(streamId) ?? 0);
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
    // Skipped entirely for unkeyed appends — those callers explicitly opted
    // out of dedup, and writing them to the cache would FIFO-evict
    // legitimate retry keys at the configured cap.
    if (keyed !== null) {
      let cache = this.idempotencyCache.get(streamId);
      if (!cache) {
        cache = new Map();
        this.idempotencyCache.set(streamId, cache);
      }
      cache.set(keyed.idempotencyKey, persisted);
      // FIFO eviction at cap — matches legacy EventStore.cacheIdempotencyKey
      // semantics (store.ts:798). Map iteration order is insertion order, so
      // `keys().next().value` is the oldest entry.
      while (cache.size > this.maxIdempotencyKeys) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    this.sequenceCounters.set(streamId, finalSequence);

    return {
      ok: true,
      kind: 'committed',
      sequences: persisted.map(e => e.sequence),
      eventIds: persisted.map(e => e.eventId),
      timestamps: persisted.map(e => e.timestamp),
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
   *
   * Performs an atomic temp-file + rename rather than an in-place rewrite:
   * concurrent readers (projection materializers, log tailers) never observe
   * a partially written file. The per-stream lock already serializes
   * appenders, so this only matters for external readers that don't
   * coordinate through the lock.
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
    const tmpPath = `${filePath}.rollback-${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmpPath, rewritten, 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import { EventStore } from './store.js';
import { runWithDispatchContext } from '../dispatch/dispatch-context.js';
import { SqliteBackend } from '../storage/sqlite-backend.js';

/**
 * AtomicAppender — substrate primitive for v2.9 bug cluster (#1230, #1228, #1241).
 *
 * Tests verify the SQLite append (validate → ensure backend → idempotency
 * pre-check → optimistic-concurrency → BEGIN IMMEDIATE) is atomic from the
 * caller's perspective: either the transaction commits (success path) or
 * none of its effects are observable (failure path). The idempotency claim
 * lives in the same transaction so a partial failure never claims a key
 * that has no underlying event in the log (#1228 phantom claim).
 *
 * v2.11 substrate-cut (Phase 2): the JSONL primary body and `backend`
 * discriminator were removed. The SQLite body is now the only path; the
 * JSONL-parametric and JSONL-internals describe blocks that exercised the
 * legacy four-phase JSONL writer + WriteFn fault hook were deleted.
 *
 * SQLite-specific fault-injection (transaction rollback, BUSY retry budget)
 * lives in `atomic-appender-sqlite.test.ts`. Singleton + race fixtures
 * live in `atomic-appender.race.test.ts`. This file holds the
 * substrate-agnostic semantic contract.
 */
describe('AtomicAppender', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-test-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('AtomicAppender_concurrentAppends_uniqueMonotonicSequences', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'test-stream-concurrent';

    const results = await Promise.all([
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 1 } }], 'idem-1'),
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 2 } }], 'idem-2'),
      appender.append(streamId, [{ type: 'task.assigned', data: { n: 3 } }], 'idem-3'),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    const allSequences = results.flatMap(r => (r.ok ? r.sequences : []));
    const sorted = [...allSequences].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3]);
    expect(new Set(allSequences).size).toBe(3);
  });

  it('AtomicAppender_successfulAppend_commitsAndIsCachedForIdempotencyRetry', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'test-stream-success';
    const idempotencyKey = 'idem-success';

    const result = await appender.append(
      streamId,
      [
        { type: 'task.assigned', data: { n: 1 } },
        { type: 'task.completed', data: { n: 1 } },
      ],
      idempotencyKey,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([1, 2]);
    expect(result.eventIds).toHaveLength(2);
    expect(result.timestamps).toHaveLength(2);

    // Idempotency cache-hit on retry — no new sequences allocated, original
    // sequences returned.
    const retry = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 99 } }],
      idempotencyKey,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.kind).toBe('cache-hit');
      expect(retry.sequences).toEqual([1, 2]);
    }

    // Substrate witness: the SQLite body writes a `.db` file and MUST NOT
    // create any JSONL artifact. Guards against a misconfigured dispatch
    // silently routing to a deleted JSONL writer.
    const entries = await readdir(stateDir);
    expect(entries.some(e => e.endsWith('.events.jsonl'))).toBe(false);
    expect(entries.some(e => e.endsWith('.db'))).toBe(true);
  });

  // ─── expectedSequence (T1, #1293) ────────────────────────────────────────
  //
  // Optimistic-concurrency check: callers that observed a sequence before
  // calling append want to fail the append if the stream advanced under
  // them. The check runs inside the per-stream lock so concurrent
  // appends can't slip a counter advance between the read and the write.

  it('AtomicAppender_appendWithMatchingExpectedSequence_succeeds', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'expected-seq-match';

    // Stream is empty → high-water mark is 0.
    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 1 } }],
      'k1',
      { expectedSequence: 0 },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sequences).toEqual([1]);
  });

  it('AtomicAppender_appendWithStaleExpectedSequence_returnsSequenceConflict', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'expected-seq-stale';

    // Advance counter to 1.
    await appender.append(streamId, [{ type: 'task.assigned', data: { n: 1 } }], 'k1');

    // Caller observed sequence 0 but counter is now 1 — conflict.
    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 2 } }],
      'k2',
      { expectedSequence: 0 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('sequence-conflict');
      expect(result.expected).toBe(0);
      expect(result.actual).toBe(1);
    }
  });

  it('AtomicAppender_expectedSequenceUndefined_skipsCheck', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'expected-seq-undef';

    // Without expectedSequence, counter mismatches don't fail.
    await appender.append(streamId, [{ type: 'task.assigned' }], 'k1');
    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned' }],
      'k2', // no options — must succeed regardless of counter state
    );
    expect(result.ok).toBe(true);
  });

  // ─── appendUnkeyed (T2, #1293) ───────────────────────────────────────────
  //
  // Bypasses idempotency dedup for callers that don't have meaningful retry
  // semantics (e.g. EventStore.append callers with no key). The persisted
  // claim row is null so the caller cannot accidentally collide with a
  // retry chain.

  it('AtomicAppender_appendUnkeyed_writesEventsAndAdvancesSequence', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'unkeyed-basic';

    const r1 = await appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]);
    const r2 = await appender.appendUnkeyed(streamId, [{ type: 'task.completed' }]);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) expect(r1.sequences).toEqual([1]);
    if (r2.ok) expect(r2.sequences).toEqual([2]);

    // Substrate witness: SQLite body, no JSONL artifact.
    const entries = await readdir(stateDir);
    expect(entries.some(e => e.endsWith('.events.jsonl'))).toBe(false);
  });

  it('AtomicAppender_appendUnkeyed_doesNotPopulateIdempotencyCache', async () => {
    // The SQLite body persists every claim in the `idempotency_claims`
    // table with no FIFO eviction (the legacy in-memory cap was JSONL-only
    // and was removed in v2.11). The semantic that holds: unkeyed appends
    // don't make keyed entries un-retrievable.
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'unkeyed-no-pollute';

    // Seed two keyed entries.
    await appender.append(streamId, [{ type: 'task.assigned' }], 'keep-a');
    await appender.append(streamId, [{ type: 'task.assigned' }], 'keep-b');

    // 5 unkeyed appends.
    for (let i = 0; i < 5; i++) {
      await appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]);
    }

    // Retry both keyed entries; they should still be cache-hit (returns
    // the original sequence, no new events appended).
    const retryA = await appender.append(streamId, [{ type: 'x' }], 'keep-a');
    const retryB = await appender.append(streamId, [{ type: 'x' }], 'keep-b');
    expect(retryA.ok && retryB.ok).toBe(true);
    if (retryA.ok) expect(retryA.sequences).toEqual([1]);
    if (retryB.ok) expect(retryB.sequences).toEqual([2]);
  });

  it('AtomicAppender_appendUnkeyed_concurrentCallsSerialize', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'unkeyed-concurrent';

    const results = await Promise.all([
      appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]),
      appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]),
      appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]),
    ]);
    for (const r of results) expect(r.ok).toBe(true);

    const seqs = results.flatMap(r => (r.ok ? r.sequences : []));
    expect([...seqs].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(new Set(seqs).size).toBe(3);
  });
});

// ─── Wave 3 (#1437) — correlation columns populated on every write ──────────
//
// Tasks 7 + 8 wire the three V6 correlation columns into the writer path so
// that new appends under an active dispatch context land with non-NULL
// values in `operation_id` / `correlation_id` / `causation_id`. The payload
// JSON remains source of truth (INV-1); these columns are the indexed
// filter handle for the Wave-4 query path.
//
// Both tests open a SECOND `SqliteBackend` handle against the same on-disk
// db file the EventStore is writing to so we can issue raw SQL against the
// `events` table. `rowToEvent` is intentionally NOT used: the test asserts
// the *column* values directly, since that's the new substrate behavior
// under test (the payload-rehydration path was already wired pre-Wave-3).
//
// Bypassing the EventStore-owned appender for reads is safe here because
// after `eventStore.append(...)` resolves the write transaction is fully
// committed; the second backend handle just opens a SELECT-only connection
// to the same file (WAL mode allows concurrent readers).
describe('AtomicAppender correlation column persistence (#1437 Wave 3)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-corr-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('AtomicAppender_AppendEvent_PopulatesCorrelationColumnsFromPayload', async () => {
    const store = new EventStore(stateDir);
    await store.initialize();

    const streamId = 's1';
    const appended = await runWithDispatchContext(
      { operationId: 'op-A', correlationId: 'cor-A', causationId: 'cause-A' },
      () => store.append(streamId, { type: 'task.assigned', data: {} }),
    );
    expect(appended.sequence).toBe(1);

    // Open a side SqliteBackend handle against the same on-disk db the
    // EventStore-owned appender writes to. The appender's default
    // `sqliteDbFilename` is `exarchos.db` (atomic-appender.ts:358).
    const dbPath = path.join(stateDir, 'exarchos.db');
    const sideBackend = new SqliteBackend(dbPath);
    sideBackend.initialize();
    try {
      const db = (sideBackend as unknown as {
        db: import('bun:sqlite').Database;
      }).db;
      const row = db
        .prepare(
          'SELECT operation_id, correlation_id, causation_id FROM events WHERE streamId = ? AND sequence = ?',
        )
        .get(streamId, appended.sequence) as
        | { operation_id: string | null; correlation_id: string | null; causation_id: string | null }
        | undefined;
      expect(row).toBeDefined();
      expect(row?.operation_id).toBe('op-A');
      expect(row?.correlation_id).toBe('cor-A');
      expect(row?.causation_id).toBe('cause-A');
    } finally {
      sideBackend.close();
    }
  });

});

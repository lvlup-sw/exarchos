import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from './store.js';
import { AtomicAppender } from './atomic-appender.js';

/**
 * Cross-path race regression suite (#1293, post-#1265).
 *
 * Before the C2 consumer migration, `EventStore.append` and
 * `AtomicAppender.append` (the path used by `event_batch_append` and the
 * subagent stream router) maintained disjoint per-stream locks and
 * sequence counters while writing the same JSONL file. CodeRabbit flagged
 * this on PR #1265 review (thread 3199528959); Sentry surfaced the race
 * firing in code on the post-fix re-review.
 *
 * These tests drive concurrent writes from both legacy-shaped paths
 * (`EventStore.append`, `EventStore.batchAppend`) and the underlying
 * `AtomicAppender` directly, then assert the cross-path invariants:
 *
 *   - Strict sequence monotonicity per stream — no overlapping sequences,
 *     no gaps from collision retries.
 *   - JSONL parses cleanly line-by-line — no truncated or interleaved
 *     records from concurrent appendFile calls.
 *   - Total event count matches the number of writes issued — no drops,
 *     no duplicates beyond the explicit idempotency-dedup contract.
 *
 * Pre-migration these tests fail (overlapping sequences and JSONL
 * corruption). Post-migration they pass because both paths now share the
 * single `AtomicAppender` instance returned by `EventStore.getAppender()`.
 */
describe('EventStore cross-path race (#1293)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'eventstore-race-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('EventStore_concurrentLegacyAppendAndBatchAppend_strictSequenceMonotonicity', async () => {
    const store = new EventStore(stateDir);
    const streamId = 'race-stream';
    const N = 50;

    // Mix three paths concurrently: single append, batch append, and direct
    // AtomicAppender. Production load looks like this — HSM transitions go
    // through `append`, `event_batch_append` goes through batch, and the
    // subagent stream router goes through the appender directly.
    const single = Array.from({ length: N }, (_, i) =>
      store.append(streamId, { type: 'task.assigned', data: { i, source: 'single' } }),
    );
    const batched = Array.from({ length: N }, (_, i) =>
      store.batchAppend(streamId, [
        { type: 'task.completed', data: { i, source: 'batched' } },
      ]),
    );
    const direct = Array.from({ length: N }, (_, i) =>
      store.getAppender().append(
        streamId,
        [{ type: 'workflow.transition', data: { i, source: 'direct' } }],
        `direct-${i}`,
      ),
    );

    const allResults = await Promise.all([
      ...single,
      ...batched.map(p => p.then(arr => arr[0])),
      ...direct.map(p => p.then(r => (r.ok ? r.sequences[0] : -1))),
    ]);
    expect(allResults).toHaveLength(3 * N);

    // Read the JSONL and assert monotonicity + no duplicates.
    const jsonl = await readFile(
      path.join(stateDir, `${streamId}.events.jsonl`),
      'utf-8',
    );
    const lines = jsonl.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3 * N);

    const sequences = lines.map((line) => JSON.parse(line).sequence as number);
    const sorted = [...sequences].sort((a, b) => a - b);
    // Sequences cover 1..3N exactly (strict monotonicity, no gaps).
    expect(sorted).toEqual(Array.from({ length: 3 * N }, (_, i) => i + 1));
    // Uniqueness check — implied by sorted equality, but explicit for clarity.
    expect(new Set(sequences).size).toBe(3 * N);
  });

  it('EventStore_concurrentSingleAppendOnly_noOverlappingSequences', async () => {
    // Targeted regression for the path that #1265 left unmigrated: pure
    // EventStore.append concurrency. Pre-migration this contended on a
    // separate lock from the AtomicAppender path; post-migration it
    // routes through the same per-stream serialization.
    const store = new EventStore(stateDir);
    const streamId = 'append-only-race';
    const N = 100;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.append(streamId, { type: 'task.assigned', data: { i } }),
      ),
    );
    const sequences = results.map(r => r.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const jsonl = await readFile(
      path.join(stateDir, `${streamId}.events.jsonl`),
      'utf-8',
    );
    const lines = jsonl.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(N);
    // Every line must parse cleanly — no truncated or interleaved records.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // ─── T11: SQLite-backed appender retains the per-stream Promise mutex ────
  //
  // The substrate flip (#1259, T06) replaces the JSONL/`.seq` body with a
  // single `BEGIN IMMEDIATE` SQLite transaction. The Promise-chain mutex
  // (`StreamLockManager`) is the FIRST-tier guard; the SQLite transaction
  // is the SECOND-tier guard. Both must be active.
  //
  // This test drives 50 concurrent appends to ONE stream against the
  // SQLite-backed body and asserts: zero duplicate sequences, sequences
  // strictly monotonic and dense (1..50). If T06 inadvertently bypassed
  // the mutex, the SQLite layer alone would still serialize writes (the
  // strict events PK on (streamId, sequence) blocks duplicates), but a
  // burst of `sequence-conflict` retries would surface as missing
  // sequences — the assertion catches that drift.

  it('SqliteAtomicAppender_50ConcurrentAppendsOneStream_NoDuplicateSequences', async () => {
    const appender = new AtomicAppender({ stateDir, backend: 'sqlite' });
    const streamId = 'sqlite-50-concurrent';
    const N = 50;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appender.append(
          streamId,
          [{ type: 'task.assigned', data: { i } }],
          `idem-${i}`,
        ),
      ),
    );

    for (const r of results) {
      expect(r.ok).toBe(true);
    }
    const seqs = results.flatMap(r => (r.ok ? r.sequences : []));
    expect(seqs).toHaveLength(N);
    // Strict monotonicity + density: every sequence in 1..N appears once.
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // Uniqueness — implied by the equality above, but explicit for clarity.
    expect(new Set(seqs).size).toBe(N);
  });

  it('EventStore_concurrentLegacyAndDirectAppender_jsonlIntegrity', async () => {
    // Sentry's specific concern from the #1265 re-review:
    // "Concurrent calls to handleEventAppend and handleBatchAppend can
    //  cause a race condition" (event-store/tools.ts:424). This test
    // reproduces that interleaving by issuing N legacy + N direct writes
    // simultaneously and verifying the on-disk JSONL is internally
    // consistent (every line parses; sequences are unique and dense).
    const store = new EventStore(stateDir);
    const streamId = 'sentry-flag';
    const N = 50;

    await Promise.all([
      ...Array.from({ length: N }, () =>
        store.append(streamId, { type: 'task.assigned' }),
      ),
      ...Array.from({ length: N }, (_, i) =>
        store
          .getAppender()
          .append(streamId, [{ type: 'task.completed' }], `direct-${i}`),
      ),
    ]);

    const jsonl = await readFile(
      path.join(stateDir, `${streamId}.events.jsonl`),
      'utf-8',
    );
    const lines = jsonl.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2 * N);

    const parsed = lines.map((l) => JSON.parse(l));
    const sequences = parsed.map((e) => e.sequence as number);
    expect(new Set(sequences).size).toBe(2 * N);
    expect([...sequences].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 2 * N }, (_, i) => i + 1),
    );
  });
});

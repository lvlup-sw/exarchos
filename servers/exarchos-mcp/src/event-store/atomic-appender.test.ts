import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';

/**
 * AtomicAppender — substrate primitive for v2.9 bug cluster (#1230, #1228, #1241).
 *
 * Tests verify the four-phase append (validate → allocate → write JSONL → write .seq
 * → cache idempotencyKey) is atomic from the caller's perspective: either all phases
 * commit (success path) or none of them are observable (failure path). The
 * idempotencyKey cache is the LAST write so a partial failure never claims a key
 * that has no underlying event in the log (#1228 phantom claim).
 *
 * Substrate parametrization (T50, #1259):
 *
 *   The substrate-agnostic semantic cases run twice — once against the JSONL
 *   body (legacy v2.9 substrate) and once against the SQLite body (DR-1
 *   #1259 substrate). The constructor accepts `{ stateDir, backend }` where
 *   `backend` is `'jsonl' | 'sqlite'`. Tests at this layer assert the
 *   contract that BOTH bodies must honour: per-stream serialization,
 *   monotonic sequence allocation, idempotency cache-hit on retry, retry
 *   admissibility after a failed attempt, and `expectedSequence`
 *   optimistic-concurrency.
 *
 *   Substrate-specific cases (JSONL fault injection via the `writeFn` seam,
 *   on-disk `.events.jsonl`/`.seq` file shape, FIFO cap on the in-memory
 *   idempotency cache) live in a non-parametric `[JSONL-internals]` block
 *   at the bottom. They are JSONL-only by design — SQLite has no
 *   equivalent fault-injection seam exposed at this layer (the
 *   `atomic-appender-sqlite.test.ts` fixtures monkey-patch
 *   `_testOnly_getSqliteBackend()` directly to exercise transaction
 *   rollback) and SQLite persists every idempotency claim with no
 *   FIFO eviction.
 */
describe.each([
  { backend: 'jsonl' as const },
  { backend: 'sqlite' as const },
])('AtomicAppender [$backend]', ({ backend }) => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), `atomic-appender-test-${backend}-`));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('AtomicAppender_concurrentAppends_uniqueMonotonicSequences', async () => {
    const appender = new AtomicAppender({ stateDir, backend });
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
    // Uniqueness implied by the sort equality, but assert explicitly:
    expect(new Set(allSequences).size).toBe(3);
  });

  it('AtomicAppender_successfulAppend_commitsAndIsCachedForIdempotencyRetry', async () => {
    const appender = new AtomicAppender({ stateDir, backend });
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

    // Idempotency cache-hit on retry — substrate-agnostic semantic.
    // No new sequences allocated, original sequences returned.
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

    // Substrate-specific commit witness: the JSONL body writes
    // `<streamId>.events.jsonl` + `<streamId>.seq`; the SQLite body
    // writes a `.db` file and MUST NOT create a JSONL file. Asserting
    // this in the parametric block guards against the SQLite body
    // silently falling through to the JSONL writer on a misconfigured
    // dispatch.
    const entries = await readdir(stateDir);
    if (backend === 'jsonl') {
      const jsonlPath = path.join(stateDir, `${streamId}.events.jsonl`);
      await access(jsonlPath);
      const contents = await readFile(jsonlPath, 'utf-8');
      const lines = contents.trim().split('\n').filter(l => l.length > 0);
      expect(lines).toHaveLength(2);
      const events = lines.map(l => JSON.parse(l));
      expect(events[0].sequence).toBe(1);
      expect(events[1].sequence).toBe(2);
      expect(events[0].type).toBe('task.assigned');
      expect(events[1].type).toBe('task.completed');
      const seqPath = path.join(stateDir, `${streamId}.seq`);
      const seqContents = JSON.parse(await readFile(seqPath, 'utf-8'));
      expect(seqContents.sequence).toBe(2);
    } else {
      // SQLite body: no JSONL artifacts; a .db file must exist.
      expect(entries.some(e => e.endsWith('.events.jsonl'))).toBe(false);
      expect(entries.some(e => e.endsWith('.db'))).toBe(true);
    }
  });

  // ─── expectedSequence (T1, #1293) ────────────────────────────────────────
  //
  // Optimistic-concurrency check: callers that observed a sequence before
  // calling append want to fail the append if the stream advanced under
  // them. The check must run under the per-stream lock so concurrent
  // appends can't slip a counter advance between the read and the write.

  it('AtomicAppender_appendWithMatchingExpectedSequence_succeeds', async () => {
    const appender = new AtomicAppender({ stateDir, backend });
    const streamId = 'expected-seq-match';

    // Stream is empty → counter is 0.
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
    const appender = new AtomicAppender({ stateDir, backend });
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
    const appender = new AtomicAppender({ stateDir, backend });
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
  // Bypasses idempotency dedup for callers that don't have a meaningful
  // retry semantics (e.g. EventStore.append callers with no key). The
  // alternative — synthesizing a random key per call — would FIFO-evict
  // legitimate retry keys at the cap.

  it('AtomicAppender_appendUnkeyed_writesEventsAndAdvancesSequence', async () => {
    const appender = new AtomicAppender({ stateDir, backend });
    const streamId = 'unkeyed-basic';

    const r1 = await appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]);
    const r2 = await appender.appendUnkeyed(streamId, [{ type: 'task.completed' }]);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) expect(r1.sequences).toEqual([1]);
    if (r2.ok) expect(r2.sequences).toEqual([2]);

    // Substrate-specific commit witness: the JSONL body persists events
    // line-delimited and MUST NOT carry an idempotencyKey field. The
    // SQLite body persists rows in `events`; we don't open the DB here
    // (that's the SQLite-internals fixture's job) — for parametric
    // purposes the AppendResult contract already covers sequence
    // allocation.
    if (backend === 'jsonl') {
      const jsonl = await readFile(
        path.join(stateDir, `${streamId}.events.jsonl`),
        'utf-8',
      );
      const lines = jsonl.trim().split('\n');
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        const evt = JSON.parse(line);
        expect(evt.idempotencyKey).toBeUndefined();
      }
    } else {
      // SQLite body: no JSONL artifact.
      const entries = await readdir(stateDir);
      expect(entries.some(e => e.endsWith('.events.jsonl'))).toBe(false);
    }
  });

  it('AtomicAppender_appendUnkeyed_doesNotPopulateIdempotencyCache', async () => {
    // Cap the cache aggressively so legitimate keys would evict if unkeyed
    // calls polluted the cache. With the bypass, the cap is unaffected.
    //
    // SQLite body has no in-memory FIFO cap (every claim persists in the
    // `idempotency_claims` table), so the cap option is effectively a
    // JSONL-only knob — but the test still passes against SQLite because
    // the SEMANTIC under test ("unkeyed appends don't make keyed entries
    // un-retrievable") holds in either substrate.
    const appender = new AtomicAppender({ stateDir, backend, maxIdempotencyKeys: 2 });
    const streamId = 'unkeyed-no-pollute';

    // Seed two keyed entries — these MUST stay retrievable.
    await appender.append(streamId, [{ type: 'task.assigned' }], 'keep-a');
    await appender.append(streamId, [{ type: 'task.assigned' }], 'keep-b');

    // 5 unkeyed appends — would evict both if the cache were polluted.
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
    const appender = new AtomicAppender({ stateDir, backend });
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

// ─── JSONL-internals (NOT parametrized over backends) ──────────────────────
//
// These tests exercise mechanics that are intrinsic to the JSONL body and
// have no SQLite analogue at this layer:
//
//   - The `writeFn` failure-injection seam (`phase: 'jsonl' | 'seq'`) is a
//     JSONL-flavored hook — the SQLite body has no equivalent (SQLite
//     transactions are rolled back by `db.transaction(fn)` automatically;
//     fault-injection there is done by monkey-patching prepared statements
//     in `atomic-appender-sqlite.test.ts`).
//   - The FIFO cap on the in-memory idempotency cache is a JSONL-body
//     concept; the SQLite body has no cap (every claim persists with no
//     eviction).
//   - The `<streamId>.events.jsonl` / `<streamId>.seq` on-disk shape is the
//     JSONL body's commit format; the SQLite body writes rows in the
//     `exarchos.db` SQLite database instead.
describe('AtomicAppender [JSONL-internals]', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-test-jsonl-internals-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('AtomicAppender_jsonlWriteFails_idempotencyKeyAdmissibleForRetry', async () => {
    const streamId = 'test-stream-retry';
    const idempotencyKey = 'retry-key-1';

    // First attempt with a writer that always fails on JSONL write
    let calls = 0;
    const failingWriteFn = async (): Promise<void> => {
      calls++;
      throw new Error('simulated disk full');
    };

    const failingAppender = new AtomicAppender({ stateDir, writeFn: failingWriteFn });
    const failed = await failingAppender.append(
      streamId,
      [{ type: 'task.assigned', data: { attempt: 1 } }],
      idempotencyKey,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toBe('io-error');
    }
    expect(calls).toBeGreaterThan(0);

    // Retry with a working appender — same idempotencyKey must be admissible
    // (i.e. not phantom-claimed by the prior failure).
    const workingAppender = new AtomicAppender({ stateDir });
    const retried = await workingAppender.append(
      streamId,
      [{ type: 'task.assigned', data: { attempt: 2 } }],
      idempotencyKey,
    );
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.sequences).toEqual([1]);
    }
  });

  it('AtomicAppender_seqFileWriteFails_returnsStructuredFailureNotSilentSuccess', async () => {
    const streamId = 'test-stream-seq-fail';

    // writeFn signature: ('jsonl' | 'seq', filePath, contents) — caller decides which
    // phase to fail. A failure on the .seq phase must surface as ok:false, not the
    // best-effort silent success the legacy four-phase path produces.
    //
    // We need JSONL write to succeed but .seq to fail. Inject a writer that
    // delegates to default behavior on jsonl and throws on seq.
    const appender = new AtomicAppender({
      stateDir,
      writeFn: async (phase, _filePath, _contents, runDefault) => {
        if (phase === 'seq') throw new Error('seq write failed');
        await runDefault();
      },
    });

    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 1 } }],
      'idem-seq-fail',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('io-error');
    }
  });

  // ─── WriteFn after-runDefault rollback (CR review 4248981786) ────────────
  //
  // The WriteFn contract permits throwing AFTER `runDefault()` completes
  // (partial-failure simulation). Without rollback, the JSONL/.seq writes
  // are durable on disk but the append returns `ok: false`, so a retry
  // would produce duplicate sequences (JSONL phase) or leave .seq ahead
  // of the rolled-back JSONL (seq phase).

  it('AtomicAppender_jsonlWriteFnThrowsAfterRunDefault_rollsBackJsonl', async () => {
    const streamId = 'after-run-default-jsonl';
    const appender = new AtomicAppender({
      stateDir,
      writeFn: async (phase, _filePath, _contents, runDefault) => {
        if (phase === 'jsonl') {
          await runDefault(); // actually writes the JSONL
          throw new Error('after-runDefault failure'); // then throws
        }
        await runDefault();
      },
    });

    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 1 } }],
      'idem-after-default',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('io-error');

    // The append should have been rolled back. Either the file does not
    // exist or it is empty.
    const jsonlPath = path.join(stateDir, `${streamId}.events.jsonl`);
    let exists = true;
    try {
      await access(jsonlPath);
    } catch {
      exists = false;
    }
    if (exists) {
      const raw = await readFile(jsonlPath, 'utf-8');
      expect(raw.trim()).toBe('');
    }
  });

  it('AtomicAppender_seqWriteFnThrowsAfterRunDefault_rollsBackJsonlAndDeletesSeq', async () => {
    const streamId = 'after-run-default-seq';
    const appender = new AtomicAppender({
      stateDir,
      writeFn: async (phase, _filePath, _contents, runDefault) => {
        if (phase === 'seq') {
          await runDefault(); // .seq is renamed into place
          throw new Error('after-runDefault seq failure');
        }
        await runDefault();
      },
    });

    const result = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 1 } }],
      'idem-seq-after-default',
    );
    expect(result.ok).toBe(false);

    // JSONL must be empty / absent (rolled back).
    const jsonlPath = path.join(stateDir, `${streamId}.events.jsonl`);
    let jsonlExists = true;
    try {
      await access(jsonlPath);
    } catch {
      jsonlExists = false;
    }
    if (jsonlExists) {
      const raw = await readFile(jsonlPath, 'utf-8');
      expect(raw.trim()).toBe('');
    }

    // .seq must NOT remain ahead of the rolled-back JSONL.
    const seqPath = path.join(stateDir, `${streamId}.seq`);
    let seqExists = true;
    try {
      await access(seqPath);
    } catch {
      seqExists = false;
    }
    expect(seqExists).toBe(false);
  });

  it('AtomicAppender_idempotencyCache_capsAtThreshold', async () => {
    // C10 polish: port EXARCHOS_MAX_IDEMPOTENCY_KEYS cap from legacy EventStore
    // (store.ts:798) to AtomicAppender so long-running streams don't grow the
    // idempotency cache unboundedly. Eviction is FIFO (insertion order) to
    // match the legacy semantics — oldest key out first.
    //
    // NOTE: This test is JSONL-only. The SQLite body persists every claim
    // in the `idempotency_claims` table with no FIFO eviction, so the
    // cap option has no effect there. If the cap is ever ported to the
    // SQLite body, parametrize this test.
    const prevCap = process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS;
    process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS = '5';
    try {
      const appender = new AtomicAppender({ stateDir });
      const streamId = 'test-stream-cap';

      // Append 7 events with 7 distinct idempotencyKeys.
      for (let i = 1; i <= 7; i++) {
        const r = await appender.append(
          streamId,
          [{ type: 'task.assigned', data: { n: i } }],
          `key-${i}`,
        );
        expect(r.ok).toBe(true);
      }

      // The two oldest keys (`key-1`, `key-2`) must have been evicted.
      // Retrying them therefore does NOT hit the cache — a fresh event with
      // a NEW sequence is appended (acceptable since JSONL replay still
      // serves the original event, but the in-memory cache is bounded).
      const retryOldest = await appender.append(
        streamId,
        [{ type: 'task.assigned', data: { n: 1, retry: true } }],
        'key-1',
      );
      expect(retryOldest.ok).toBe(true);
      if (retryOldest.ok) {
        // Cache miss → new sequence allocated (would have been [1] had it cached).
        expect(retryOldest.sequences).toEqual([8]);
      }

      const retrySecondOldest = await appender.append(
        streamId,
        [{ type: 'task.assigned', data: { n: 2, retry: true } }],
        'key-2',
      );
      expect(retrySecondOldest.ok).toBe(true);
      if (retrySecondOldest.ok) {
        expect(retrySecondOldest.sequences).toEqual([9]);
      }

      // Conversely, a still-cached recent key (`key-7`) MUST hit the cache:
      // retry returns the original sequence (7), no new event appended.
      const retryRecent = await appender.append(
        streamId,
        [{ type: 'task.assigned', data: { n: 7, retry: true } }],
        'key-7',
      );
      expect(retryRecent.ok).toBe(true);
      if (retryRecent.ok) {
        expect(retryRecent.sequences).toEqual([7]);
      }
    } finally {
      if (prevCap === undefined) {
        delete process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS;
      } else {
        process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS = prevCap;
      }
    }
  });
});

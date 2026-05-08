import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
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
    // Uniqueness implied by the sort equality, but assert explicitly:
    expect(new Set(allSequences).size).toBe(3);
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
    const failingOnSeq = async (phase: 'jsonl' | 'seq'): Promise<void> => {
      if (phase === 'seq') throw new Error('seq write failed');
      // Allow JSONL write to proceed normally — defer to default impl
      throw new Error('default-fallthrough');
    };

    // We need JSONL write to succeed but .seq to fail. So inject a writer that
    // delegates to default behavior on jsonl and throws on seq. The simplest
    // way is to pass a partial-failure writer that the default impl can call
    // through; expose this via writeFn that receives phase + a default executor.
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

  it('AtomicAppender_successfulAppend_commitsAllPhases', async () => {
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
    expect(result.sequences).toEqual([1, 2]);
    expect(result.eventIds).toHaveLength(2);

    // Phase 1: events present in JSONL
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

    // Phase 2: .seq reflects max sequence
    const seqPath = path.join(stateDir, `${streamId}.seq`);
    const seqContents = JSON.parse(await readFile(seqPath, 'utf-8'));
    expect(seqContents.sequence).toBe(2);

    // Phase 3: idempotencyKey cached — observable as a duplicate-detection on retry
    const retry = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { n: 99 } }],
      idempotencyKey,
    );
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      // Cached: no new sequences allocated, original sequences returned
      expect(retry.sequences).toEqual([1, 2]);
    }
    // Verify no extra events were written
    const contentsAfter = await readFile(jsonlPath, 'utf-8');
    const linesAfter = contentsAfter.trim().split('\n').filter(l => l.length > 0);
    expect(linesAfter).toHaveLength(2);
  });

  it('AtomicAppender_idempotencyCache_capsAtThreshold', async () => {
    // C10 polish: port EXARCHOS_MAX_IDEMPOTENCY_KEYS cap from legacy EventStore
    // (store.ts:798) to AtomicAppender so long-running streams don't grow the
    // idempotency cache unboundedly. Eviction is FIFO (insertion order) to
    // match the legacy semantics — oldest key out first.
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

  // ─── expectedSequence (T1, #1293) ────────────────────────────────────────
  //
  // Optimistic-concurrency check: callers that observed a sequence before
  // calling append want to fail the append if the stream advanced under
  // them. The check must run under the per-stream lock so concurrent
  // appends can't slip a counter advance between the read and the write.

  it('AtomicAppender_appendWithMatchingExpectedSequence_succeeds', async () => {
    const appender = new AtomicAppender({ stateDir });
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
  // Bypasses idempotency dedup for callers that don't have a meaningful
  // retry semantics (e.g. EventStore.append callers with no key). The
  // alternative — synthesizing a random key per call — would FIFO-evict
  // legitimate retry keys at the cap.

  it('AtomicAppender_appendUnkeyed_writesEventsAndAdvancesSequence', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'unkeyed-basic';

    const r1 = await appender.appendUnkeyed(streamId, [{ type: 'task.assigned' }]);
    const r2 = await appender.appendUnkeyed(streamId, [{ type: 'task.completed' }]);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok) expect(r1.sequences).toEqual([1]);
    if (r2.ok) expect(r2.sequences).toEqual([2]);

    // JSONL persists both events with no idempotencyKey field.
    const jsonl = await readFile(path.join(stateDir, `${streamId}.events.jsonl`), 'utf-8');
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const evt = JSON.parse(line);
      expect(evt.idempotencyKey).toBeUndefined();
    }
  });

  it('AtomicAppender_appendUnkeyed_doesNotPopulateIdempotencyCache', async () => {
    // Cap the cache aggressively so legitimate keys would evict if unkeyed
    // calls polluted the cache. With the bypass, the cap is unaffected.
    const appender = new AtomicAppender({ stateDir, maxIdempotencyKeys: 2 });
    const streamId = 'unkeyed-no-pollute';

    // Seed two keyed entries — these MUST stay in the cache.
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

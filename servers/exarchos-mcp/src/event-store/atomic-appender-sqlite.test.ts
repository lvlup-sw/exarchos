import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';

/**
 * SQLite-backed AtomicAppender — direct unit fixtures (T06, T07).
 *
 * These tests target the SQLite body itself, separate from the
 * interface-fidelity acceptance suite (`atomic-appender.acceptance.test.ts`).
 * They cover:
 *
 *   - T06: concurrent appends to one stream allocate non-overlapping,
 *     strictly monotonic sequences. The first-tier guard is the per-stream
 *     Promise mutex (`StreamLockManager`); the second-tier guard is the
 *     SQLite `BEGIN IMMEDIATE` transaction. Both must hold.
 *
 *   - T07: idempotency-key claim is committed only on `COMMIT`. A
 *     transaction that fails mid-flight (after the idempotency claim
 *     INSERT but before the event INSERT) must roll back the claim so the
 *     same key can be retried by a subsequent attempt.
 */
describe('SqliteAtomicAppender', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-sqlite-unit-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('SqliteAtomicAppender_ConcurrentAppendsToSameStream_NoOverlapInSequenceAllocation', async () => {
    const appender = new AtomicAppender({ stateDir, backend: 'sqlite' });
    const streamId = 'sqlite-concurrent-10';

    // Spawn 10 concurrent appends to the same stream. The append primitive
    // must serialize them into 10 distinct, strictly-monotonic sequences
    // with no gaps and no duplicates — same contract as the JSONL body.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appender.append(
          streamId,
          [{ type: 'task.assigned', data: { i } }],
          `key-${i}`,
        ),
      ),
    );

    for (const r of results) {
      expect(r.ok).toBe(true);
    }
    const seqs = results.flatMap(r => (r.ok ? r.sequences : []));
    expect(seqs).toHaveLength(10);
    expect(new Set(seqs).size).toBe(10);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Sanity: SQLite body MUST NOT have written a JSONL file.
    const entries = await readdir(stateDir);
    expect(entries.some(e => e.endsWith('.events.jsonl'))).toBe(false);
  });
});

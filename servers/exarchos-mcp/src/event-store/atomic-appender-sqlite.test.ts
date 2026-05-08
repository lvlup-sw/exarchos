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

  // ─── T07: idempotency rollback on transaction failure ────────────────────
  //
  // The BEGIN IMMEDIATE transaction wraps the idempotency-claim INSERT and
  // the event INSERTs. If the event INSERT fails (e.g. driver throws
  // mid-flight), the entire transaction must ROLLBACK — including the
  // idempotency claim row. The retry contract: a subsequent append with
  // the same idempotency key MUST succeed (the claim was rolled back, no
  // phantom claim survives).
  //
  // The fault is injected by monkey-patching the strict event INSERT
  // statement on the SqliteBackend's prepared-statement set so it throws.
  // This surfaces inside the bun:sqlite `db.transaction(fn)` wrapper, which
  // automatically issues ROLLBACK before re-raising. Property under test:
  // ROLLBACK actually clears the idempotency_claims row.

  it('SqliteAtomicAppender_TransactionRollback_IdempotencyKeyNotCommitted', async () => {
    const appender = new AtomicAppender({ stateDir, backend: 'sqlite' });
    const streamId = 'sqlite-txn-rollback';
    const idemKey = 'idem-rollback';

    // First append: poison the event INSERT statement so the transaction
    // raises after the idempotency claim INSERT.
    //
    // We grab the backend AFTER the first call below, but the appender
    // creates the backend lazily; so do a tiny dry-run validation append
    // first, then patch, then run the test scenario. Using a different
    // stream for the warm-up keeps the targeted streamId pristine.
    const warmup = await appender.append(
      'sqlite-txn-warmup',
      [{ type: 'task.assigned', data: { warmup: true } }],
      'warmup-key',
    );
    expect(warmup.ok).toBe(true);

    const backend = appender._testOnly_getSqliteBackend();
    expect(backend).toBeDefined();
    if (!backend) return;

    // Reach into the backend's prepared-statement set and replace the
    // strict event INSERT with a stub that throws. The wrapping
    // `db.transaction(fn).immediate()` call issues ROLLBACK on throw.
    const stmts = (backend as unknown as { stmts: { insertEventStrict: { run: (...args: unknown[]) => unknown } } })
      .stmts;
    const originalRun = stmts.insertEventStrict.run.bind(stmts.insertEventStrict);
    stmts.insertEventStrict.run = () => {
      throw new Error('simulated event INSERT failure');
    };

    let failed: Awaited<ReturnType<typeof appender.append>>;
    try {
      failed = await appender.append(
        streamId,
        [{ type: 'task.assigned', data: { attempt: 1 } }],
        idemKey,
      );
    } finally {
      // Restore the real INSERT before the retry so we can observe the
      // post-rollback admissibility of the same key.
      stmts.insertEventStrict.run = originalRun;
    }
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toBe('io-error');
    }

    // Direct backend probe: no idempotency claim must survive the rollback.
    const claim = backend.lookupIdempotencyClaim(streamId, idemKey);
    expect(claim).toBeUndefined();

    // Retry with the SAME idempotency key — must succeed (a phantom claim
    // would surface as `idempotency-claimed` or as a unique-constraint
    // violation; either is the bug T07 closes).
    const retried = await appender.append(
      streamId,
      [{ type: 'task.assigned', data: { attempt: 2 } }],
      idemKey,
    );
    expect(retried.ok).toBe(true);
    if (retried.ok) {
      expect(retried.kind).toBe('committed');
      expect(retried.sequences).toEqual([1]);
    }
  });
});

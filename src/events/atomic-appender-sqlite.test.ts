import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

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
    await rmrfAsync(stateDir);
  });

  it('SqliteAtomicAppender_ConcurrentAppendsToSameStream_NoOverlapInSequenceAllocation', async () => {
    const appender = new AtomicAppender({ stateDir });
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
    const appender = new AtomicAppender({ stateDir });
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

    const backend = appender.getSqliteBackend();
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

  // ─── T09: SQLITE_BUSY bounded retry ──────────────────────────────────────
  //
  // The SQLite body must wrap its `BEGIN IMMEDIATE` transaction in a bounded
  // retry loop. SQLITE_BUSY surfaces when another writer holds the database
  // lock; per-stream concurrency in-process is already serialized by the
  // Promise mutex, but cross-process writers (and bun:sqlite vs better-
  // sqlite3 driver-level contention) can still raise BUSY against a fresh
  // BEGIN IMMEDIATE attempt. The retry layer transparently re-runs the
  // transaction up to 5 attempts with exponential backoff capped at 100 ms;
  // on exhaustion the appender returns a typed `storage_busy` failure
  // rather than escaping the SQLite reason code through the boundary.
  //
  // We inject the fault by replacing `insertEventStrict.run` with a stub
  // that throws a SqliteError-shaped Error (`code: 'SQLITE_BUSY'`) for the
  // first N attempts. The retry detection contract: the layer must look at
  // `error.code === 'SQLITE_BUSY'`, not message-substring matching.

  function makeBusyError(): Error {
    const err = new Error('database is locked') as Error & { code?: string };
    err.code = 'SQLITE_BUSY';
    return err;
  }

  it('SqliteAtomicAppender_SqliteBusy_RetriesUpToFiveTimesWithBackoff', async () => {
    const appender = new AtomicAppender({ stateDir });

    // Warm up so we have a concrete backend handle to patch.
    const warmup = await appender.append(
      'sqlite-busy-warmup',
      [{ type: 'task.assigned', data: { warmup: true } }],
      'warmup-key',
    );
    expect(warmup.ok).toBe(true);

    const backend = appender.getSqliteBackend();
    expect(backend).toBeDefined();
    if (!backend) return;

    const stmts = (
      backend as unknown as {
        stmts: { insertEventStrict: { run: (...args: unknown[]) => unknown } };
      }
    ).stmts;
    const originalRun = stmts.insertEventStrict.run.bind(stmts.insertEventStrict);
    let attempts = 0;
    stmts.insertEventStrict.run = (...args: unknown[]) => {
      attempts += 1;
      if (attempts <= 4) throw makeBusyError();
      return originalRun(...args);
    };

    const t0 = Date.now();
    let result: Awaited<ReturnType<typeof appender.append>>;
    try {
      result = await appender.append(
        'sqlite-busy-retry',
        [{ type: 'task.assigned', data: { idx: 1 } }],
        'busy-retry-key',
      );
    } finally {
      stmts.insertEventStrict.run = originalRun;
    }
    const elapsed = Date.now() - t0;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([1]);
    // Five attempts: 4 BUSY throws + 1 success.
    expect(attempts).toBe(5);
    // Backoff bounded — 5+10+20+40 ≤ 75 ms total of intentional sleeps,
    // capped well below 1 s. This proves there's no unbounded retry sleep.
    expect(elapsed).toBeLessThan(1000);
  });

  it('SqliteAtomicAppender_SqliteBusy_ExceedsFiveAttempts_ReturnsStorageBusy', async () => {
    const appender = new AtomicAppender({ stateDir });

    const warmup = await appender.append(
      'sqlite-busy-exhaust-warmup',
      [{ type: 'task.assigned', data: { warmup: true } }],
      'warmup-key-exhaust',
    );
    expect(warmup.ok).toBe(true);

    const backend = appender.getSqliteBackend();
    if (!backend) throw new Error('backend not initialized');

    const stmts = (
      backend as unknown as {
        stmts: { insertEventStrict: { run: (...args: unknown[]) => unknown } };
      }
    ).stmts;
    const originalRun = stmts.insertEventStrict.run.bind(stmts.insertEventStrict);
    let attempts = 0;
    stmts.insertEventStrict.run = (..._args: unknown[]) => {
      attempts += 1;
      throw makeBusyError();
    };

    let result: Awaited<ReturnType<typeof appender.append>>;
    try {
      result = await appender.append(
        'sqlite-busy-exhaust',
        [{ type: 'task.assigned', data: { idx: 1 } }],
        'busy-exhaust-key',
      );
    } finally {
      stmts.insertEventStrict.run = originalRun;
    }

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('storage_busy');
    expect(result.cause).toBeInstanceOf(Error);
    // Attempted 5 times before giving up (the budget). One more is fine —
    // either reading is acceptable so long as it's bounded.
    expect(attempts).toBeGreaterThanOrEqual(5);
    expect(attempts).toBeLessThanOrEqual(6);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Unit tests for the SQLite body of `AtomicAppender`. `atomic-appender.acceptance.test.ts` covers
 * the interface contract.
 *
 * Concurrent appends to one stream get distinct, strictly monotonic sequences. The per-stream
 * Promise mutex (`StreamLockManager`) is the first guard, and the `BEGIN IMMEDIATE` transaction
 * is the second. A claim on an idempotency key commits only at `COMMIT`. On SQLITE_BUSY, the
 * backend retries the transaction in a bounded loop.
 */
describe('SqliteAtomicAppender', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-sqlite-unit-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * Ten concurrent appends must get ten distinct sequences with no gap. The SQLite body must
   * write no JSONL file.
   */
  it('SqliteAtomicAppender_ConcurrentAppendsToSameStream_NoOverlapInSequenceAllocation', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-concurrent-10';

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

    const entries = await readdir(stateDir);
    expect(entries.some(e => e.endsWith('.events.jsonl'))).toBe(false);
  });

  /**
   * The transaction holds the claim INSERT and the event INSERTs. If an event INSERT throws, the
   * rollback must also remove the claim, so a retry with the same key commits. A stub on
   * `insertEventStrict.run` injects the fault after the claim INSERT. The appender opens the
   * backend lazily, so a warm-up append on a second stream runs before the patch.
   */
  it('SqliteAtomicAppender_TransactionRollback_IdempotencyKeyNotCommitted', async () => {
    const appender = new AtomicAppender({ stateDir });
    const streamId = 'sqlite-txn-rollback';
    const idemKey = 'idem-rollback';

    const warmup = await appender.append(
      'sqlite-txn-warmup',
      [{ type: 'task.assigned', data: { warmup: true } }],
      'warmup-key',
    );
    expect(warmup.ok).toBe(true);

    const backend = appender.getSqliteBackend();
    expect(backend).toBeDefined();
    if (!backend) return;

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
      stmts.insertEventStrict.run = originalRun;
    }
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.reason).toBe('io-error');
    }

    const claim = backend.lookupIdempotencyClaim(streamId, idemKey);
    expect(claim).toBeUndefined();

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

  function makeBusyError(): Error {
    const err = new Error('database is locked') as Error & { code?: string };
    err.code = 'SQLITE_BUSY';
    return err;
  }

  /**
   * SQLITE_BUSY can come from a writer in a second process. The backend retries the transaction
   * up to 5 attempts with exponential backoff. The stub throws an error with
   * `code: 'SQLITE_BUSY'` for the first 4 attempts, because the retry layer reads `error.code`
   * and not the message. The sleeps are 5, 10, 20 and 40 ms.
   */
  it('SqliteAtomicAppender_SqliteBusy_RetriesUpToFiveTimesWithBackoff', async () => {
    const appender = new AtomicAppender({ stateDir });

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

    const timers = vi.spyOn(globalThis, 'setTimeout');
    let result: Awaited<ReturnType<typeof appender.append>>;
    let backoffMs: number[];
    try {
      result = await appender.append(
        'sqlite-busy-retry',
        [{ type: 'task.assigned', data: { idx: 1 } }],
        'busy-retry-key',
      );
    } finally {
      stmts.insertEventStrict.run = originalRun;
      backoffMs = timers.mock.calls
        .map((call) => call[1])
        .filter((ms): ms is number => typeof ms === 'number' && ms > 0);
      timers.mockRestore();
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([1]);
    expect(attempts).toBe(5);
    expect(backoffMs).toEqual([5, 10, 20, 40]);
  });

  /**
   * If each attempt is busy, the appender returns a typed `storage_busy` failure. The budget is
   * 5 attempts, and the test accepts 5 or 6.
   */
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
    expect(attempts).toBeGreaterThanOrEqual(5);
    expect(attempts).toBeLessThanOrEqual(6);
  });
});

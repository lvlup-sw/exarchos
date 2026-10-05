import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * The stream-version gate allocates the sequence and checks `expectedSequence` inside the
 * `BEGIN IMMEDIATE` transaction (`SqliteBackend.allocateSequence`). Plain appends from separate
 * connections to one stream serialize and never return `sequence-conflict`.
 *
 * Each `AtomicAppender` owns a `StreamLockManager` and a `SqliteBackend` connection. Thus two
 * instances bypass the in-process mutex and contend on the SQLite write lock, as two processes do.
 */
describe('AtomicAppender stream-version gate', () => {
  let stateDir: string;
  let trackedAppenders: AtomicAppender[];

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'gate-test-'));
    trackedAppenders = [];
  });

  /**
   * Closes each SQLite handle, then removes the state directory. An open connection leaks a file
   * descriptor and can block the removal on some platforms. Each test makes its appenders with
   * `makeAppender`, which tracks them for this hook.
   */
  afterEach(async () => {
    for (const appender of trackedAppenders) {
      appender.getSqliteBackend()?.close();
    }
    await rmrfAsync(stateDir);
  });

  const makeAppender = (
    options: { synchronous?: 'normal' | 'full' } = {},
  ): AtomicAppender => {
    const appender = new AtomicAppender({ stateDir, ...options });
    trackedAppenders.push(appender);
    return appender;
  };

  /**
   * Eight appenders, each with its own connection, append to one stream with no key and no
   * `expectedSequence`. A sequence read outside the transaction lets the losers collide on the
   * `events` primary key. With the gate, a loser waits on `busy_timeout` and reads the tail under
   * the write lock, so each append commits.
   */
  it('HotStream_NConnectionConcurrentPlainAppend_ContiguousZeroConflict', async () => {
    const N = 8;
    const streamId = 'hot-stream';
    const appenders = Array.from({ length: N }, () => makeAppender());

    const results = await Promise.all(
      appenders.map((a, i) =>
        a.appendUnkeyed(streamId, [{ type: 'evt', data: { i } }]),
      ),
    );

    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.kind).toBe('committed');
    }

    const seqs = results.flatMap(r => (r.ok ? r.sequences : [])).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(N);

    const events = appenders[0].ensureSqliteBackendSync().queryEvents(streamId);
    expect(events).toHaveLength(N);
  });

  /** A stale `expectedSequence` returns the conflict, and the correct value then commits. */
  it('Occ_StaleExpectedSequence_ReturnsConflictWithExpectedActual', async () => {
    const appender = makeAppender();
    const streamId = 'occ-stream';

    const first = await appender.append(streamId, [{ type: 'evt' }], 'k-first', {
      expectedSequence: 0,
    });
    expect(first.ok).toBe(true);

    const conflict = await appender.append(streamId, [{ type: 'evt' }], 'k-stale', {
      expectedSequence: 0,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.reason).toBe('sequence-conflict');
      expect(conflict.expected).toBe(0);
      expect(conflict.actual).toBe(1);
    }

    const ok = await appender.append(streamId, [{ type: 'evt' }], 'k-fresh', {
      expectedSequence: 1,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sequences).toEqual([2]);
  });

  /**
   * The claim lookup before the transaction returns the stored shape as a cache-hit. The gate
   * does not run again, so the sequence does not advance and one event persists.
   */
  it('KeyedRetry_SameIdempotencyKey_ReturnsCacheHit', async () => {
    const appender = makeAppender();
    const streamId = 'idem-stream';

    const first = await appender.append(streamId, [{ type: 'evt', data: { v: 1 } }], 'dup-key');
    expect(first.ok).toBe(true);
    const firstSeqs = first.ok ? first.sequences : [];

    const retry = await appender.append(streamId, [{ type: 'evt', data: { v: 999 } }], 'dup-key');
    expect(retry.ok).toBe(true);
    if (retry.ok) {
      expect(retry.kind).toBe('cache-hit');
      expect(retry.sequences).toEqual(firstSeqs);
    }

    const events = appender.ensureSqliteBackendSync().queryEvents(streamId);
    expect(events).toHaveLength(1);
  });

  /**
   * The gate always gives a free slot, so an `events` primary-key violation is an integrity
   * anomaly. The translator must return `io-error` with the cause, and not `sequence-conflict`
   * or a cache-hit.
   */
  it('TranslateAtomicAppendError_PkViolation_SurfacesIoErrorAnomaly', async () => {
    const appender = makeAppender();
    const backend = appender.ensureSqliteBackendSync();
    const pkError = new Error(
      'UNIQUE constraint failed: events.streamId, events.sequence',
    );

    const result = (
      appender as unknown as {
        translateAtomicAppendError: (args: {
          error: Error;
          backend: ReturnType<AtomicAppender['ensureSqliteBackendSync']>;
          streamId: string;
          keyed: { idempotencyKey: string } | null;
        }) => { ok: boolean; reason?: string; cause?: unknown };
      }
    ).translateAtomicAppendError({
      error: pkError,
      backend,
      streamId: 'anomaly-stream',
      keyed: null,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('io-error');
    expect(result.reason).not.toBe('sequence-conflict');
    expect(result.cause).toBe(pkError);
  });

  /**
   * The lazy read path must apply the configured `synchronous` value. The write reuses the
   * cached handle, so a read-first open without the value pins the handle to NORMAL. The test
   * forces the read-first path and expects FULL (2).
   */
  it('EnsureSqliteBackendSync_FullDurability_PropagatesToLazyReadBackend', () => {
    const appender = makeAppender({ synchronous: 'full' });
    const backend = appender.ensureSqliteBackendSync();
    const db = (
      backend as unknown as {
        db: { query: (sql: string) => { all: () => Array<{ synchronous: number }> } };
      }
    ).db;
    expect(db.query('PRAGMA synchronous').all()[0]?.synchronous).toBe(2);
  });
});

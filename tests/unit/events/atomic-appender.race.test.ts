import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Race tests for `AtomicAppender`.
 *
 * The lazy SQLite init must open one `SqliteBackend` for concurrent first writes to different
 * streams. `ensureSqliteBackend` caches the in-flight Promise before any await, so each caller
 * shares one handle.
 *
 * A writer can commit between the claim lookup and `atomicAppend`. The loser then gets a UNIQUE
 * failure, and the translation must read the durable state again.
 */
describe('AtomicAppender race fixtures', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-race-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /**
   * The per-stream mutex does not serialize appends to different streams, so ten first writes
   * reach the lazy init together. The spy counts the `initialize` calls and adds no yield. One
   * backend must serve the appender.
   */
  it('SqliteAtomicAppender_ConcurrentFirstWritesOnDifferentStreams_ConstructsOneBackend', async () => {
    const originalInitialize = SqliteBackend.prototype.initialize;
    const initializeSpy = vi.fn(function (this: SqliteBackend) {
      return originalInitialize.call(this);
    });
    SqliteBackend.prototype.initialize = initializeSpy;

    try {
      const appender = new AtomicAppender({ stateDir });
      const N = 10;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          appender.append(
            `race-stream-${i}`,
            [{ type: 'task.assigned', data: { i } }],
            `key-${i}`,
          ),
        ),
      );

      for (const r of results) {
        expect(r.ok).toBe(true);
      }

      expect(initializeSpy).toHaveBeenCalledTimes(1);

      const backend = appender.getSqliteBackend();
      expect(backend).toBeDefined();
    } finally {
      SqliteBackend.prototype.initialize = originalInitialize;
    }
  });

  /**
   * Two appenders share one database file. The winner commits first, and the loser then appends
   * with the same key. A stub hides the claim from the first lookup of the loser, as in a lookup
   * that runs before the commit. A warm-up append opens the backend of the loser for the stub.
   * The `atomicAppend` of the loser fails on `idempotency_claims`. The next lookup is real, so
   * the loser must return the stored events of the winner as a cache-hit.
   */
  it('SqliteAtomicAppender_RaceLoserOnIdempotencyConflict_ReturnsCacheHitFromDurableState', async () => {
    const streamId = 'race-idem-conflict';
    const idemKey = 'shared-key';

    const appenderA = new AtomicAppender({ stateDir });
    const appenderB = new AtomicAppender({ stateDir });

    const winnerEvents = [
      { type: 'task.assigned', data: { winner: true, attempt: 'A' } },
    ];
    const loserEvents = [
      { type: 'task.assigned', data: { winner: false, attempt: 'B' } },
    ];

    const winResult = await appenderA.append(streamId, winnerEvents, idemKey);
    expect(winResult.ok).toBe(true);
    if (!winResult.ok) return;
    expect(winResult.kind).toBe('committed');
    const winnerSequences = winResult.sequences;
    const winnerEventIds = winResult.eventIds;
    const winnerTimestamps = winResult.timestamps;

    const backendB = appenderB.getSqliteBackend();
    const warm = await appenderB.append(
      'warmup-stream',
      [{ type: 'noop' }],
      'warmup-key',
    );
    expect(warm.ok).toBe(true);
    const backend = appenderB.getSqliteBackend();
    if (!backend) throw new Error('backend not initialized for appenderB');
    const originalLookup = backend.lookupIdempotencyClaim.bind(backend);
    let suppressionsRemaining = 1;
    backend.lookupIdempotencyClaim = ((sid: string, key: string) => {
      if (sid === streamId && key === idemKey && suppressionsRemaining > 0) {
        suppressionsRemaining -= 1;
        return undefined;
      }
      return originalLookup(sid, key);
    }) as typeof backend.lookupIdempotencyClaim;
    void backendB;

    let loserResult: Awaited<ReturnType<typeof appenderB.append>>;
    try {
      loserResult = await appenderB.append(streamId, loserEvents, idemKey);
    } finally {
      backend.lookupIdempotencyClaim = originalLookup;
    }

    expect(loserResult.ok).toBe(true);
    if (!loserResult.ok) return;
    expect(loserResult.kind).toBe('cache-hit');
    expect(loserResult.sequences).toEqual(winnerSequences);
    expect(loserResult.eventIds).toEqual(winnerEventIds);
    expect(loserResult.timestamps).toEqual(winnerTimestamps);
    if (loserResult.kind !== 'cache-hit') return;
    expect(loserResult.persistedEvents).toHaveLength(1);
    expect(loserResult.persistedEvents[0].type).toBe('task.assigned');
    expect(
      (loserResult.persistedEvents[0].data as { winner?: boolean }).winner,
    ).toBe(true);
  });

  /**
   * Twenty concurrent first writes must initialize one backend, and `getSqliteBackend()` must
   * return that instance.
   */
  it('SqliteAtomicAppender_ConcurrentFirstWriteCallers_ShareTheSameBackendHandle', async () => {
    const initialized: SqliteBackend[] = [];
    const originalInitialize = SqliteBackend.prototype.initialize;
    SqliteBackend.prototype.initialize = function (this: SqliteBackend) {
      initialized.push(this);
      return originalInitialize.call(this);
    };

    try {
      const appender = new AtomicAppender({ stateDir });
      const N = 20;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          appender.append(
            `share-stream-${i}`,
            [{ type: 'task.assigned', data: { i } }],
            `share-key-${i}`,
          ),
        ),
      );
      for (const r of results) {
        expect(r.ok).toBe(true);
      }

      expect(initialized).toHaveLength(1);
      const exposed = appender.getSqliteBackend();
      expect(exposed).toBe(initialized[0]);
    } finally {
      SqliteBackend.prototype.initialize = originalInitialize;
    }
  });

  /**
   * Concurrent calls to the private `ensureSqliteBackend` must return one instance and
   * initialize one backend. The test adds no yield to the init. The init is synchronous, so a
   * plain field guard also passes here.
   */
  it('SqliteAtomicAppender_LazyInitWithAsyncYield_PromiseCacheStillReturnsOneBackend', async () => {
    const originalInitialize = SqliteBackend.prototype.initialize;
    let constructionCount = 0;
    SqliteBackend.prototype.initialize = function (this: SqliteBackend) {
      constructionCount += 1;
      return originalInitialize.call(this);
    };

    try {
      const appender = new AtomicAppender({ stateDir });
      type WithEnsure = AtomicAppender & {
        ensureSqliteBackend?: () => Promise<SqliteBackend>;
      };
      const internals = appender as WithEnsure;
      expect(typeof internals.ensureSqliteBackend).toBe('function');

      const N = 32;
      const handles = await Promise.all(
        Array.from({ length: N }, () =>
          (internals.ensureSqliteBackend as () => Promise<SqliteBackend>).call(
            appender,
          ),
        ),
      );

      const first = handles[0];
      for (const h of handles) {
        expect(h).toBe(first);
      }
      expect(constructionCount).toBe(1);
    } finally {
      SqliteBackend.prototype.initialize = originalInitialize;
    }
  });

  /**
   * The sync read path and the async write path can interleave on one appender, and both must
   * return one handle. The async init assigns `this.sqliteBackend` before its first await, so a
   * sync call that comes next finds the handle. An `await` before that assignment makes the sync
   * call open a second handle, and this test then fails.
   *
   * In the reverse order, the sync path fills `sqliteBackendPromise`, so the async call resolves
   * to the same handle. The second appender opens its own backend, so the total is 2.
   */
  it('SqliteAtomicAppender_SyncAndAsyncInterleaved_ReturnSameSingletonHandle', async () => {
    const originalInitialize = SqliteBackend.prototype.initialize;
    let constructionCount = 0;
    SqliteBackend.prototype.initialize = function (this: SqliteBackend) {
      constructionCount += 1;
      return originalInitialize.call(this);
    };

    try {
      const appender = new AtomicAppender({ stateDir });
      type WithEnsure = AtomicAppender & {
        ensureSqliteBackend?: () => Promise<SqliteBackend>;
        ensureSqliteBackendSync?: () => SqliteBackend;
      };
      const internals = appender as WithEnsure;
      expect(typeof internals.ensureSqliteBackend).toBe('function');
      expect(typeof internals.ensureSqliteBackendSync).toBe('function');

      const asyncPromise = (
        internals.ensureSqliteBackend as () => Promise<SqliteBackend>
      ).call(appender);
      const syncHandle = (
        internals.ensureSqliteBackendSync as () => SqliteBackend
      ).call(appender);
      const asyncHandle = await asyncPromise;

      expect(syncHandle).toBe(asyncHandle);
      expect(constructionCount).toBe(1);

      const appender2 = new AtomicAppender({ stateDir });
      const internals2 = appender2 as WithEnsure;
      const syncFirst = (
        internals2.ensureSqliteBackendSync as () => SqliteBackend
      ).call(appender2);
      const asyncSecond = await (
        internals2.ensureSqliteBackend as () => Promise<SqliteBackend>
      ).call(appender2);

      expect(asyncSecond).toBe(syncFirst);
      expect(constructionCount).toBe(2);
    } finally {
      SqliteBackend.prototype.initialize = originalInitialize;
    }
  });
});

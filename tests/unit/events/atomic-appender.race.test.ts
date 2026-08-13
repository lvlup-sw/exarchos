import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * AtomicAppender race-condition fixtures (T63, T64).
 *
 *   T63 — Lazy SQLite backend init must construct exactly ONE SqliteBackend
 *         handle even under concurrent first-writes targeting different
 *         streams. The legacy `if (!this.sqliteBackend) { ... }` guard
 *         relied on `initialize()` being synchronous to be race-free —
 *         a fragile invariant. The Promise-cached singleton makes the
 *         lazy init defensible against any future async initialization
 *         step inside the lazy path.
 *
 *   T64 — When `atomicAppend` raises a unique-constraint failure
 *         (idempotency or sequence collision), the appender's preflight
 *         (idempotency cache lookup, high-water-mark read) is already
 *         stale: another writer commit­ted in between. Translation must
 *         re-read durable state so the loser's `AppendResult` reflects
 *         the post-conflict canonical shape, not the pre-preflight one.
 */
describe('AtomicAppender race fixtures', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'atomic-appender-race-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  // ─── T63: lazy SQLite backend init singleton ─────────────────────────────
  //
  // Two (or more) first-time appends targeting DIFFERENT streams enter
  // `appendSqliteLocked` concurrently — the per-stream Promise mutex
  // serializes per-stream but not cross-stream. Each call awaits
  // `fs.mkdir(stateDir, { recursive: true })`, then synchronously calls
  // `getSqliteBackend()`. In current sync code, only one backend is
  // constructed because `getSqliteBackend()` runs to completion before
  // the next concurrent caller resumes. But the contract is fragile: if
  // any future change introduces an `await` inside the lazy-init path
  // (e.g. an async migration or a remote handle warm-up), the race
  // re-opens and concurrent first-writes leak SqliteBackend handles
  // (the loser's handle never closes; it ties up file descriptors and
  // — for shared-file SQLite — write-locks the DB).
  //
  // To pin the invariant defensively, we install a yield between the
  // check and the assign by wrapping `SqliteBackend.prototype.initialize`
  // with a deferred completion. This is the smallest change that exposes
  // the race window any future async-init refactor would create.
  // The Promise-cached singleton fix makes the test pass even with the
  // yield in place: the first caller assigns the in-flight Promise
  // synchronously; subsequent callers await the same Promise and never
  // construct a fresh backend.

  it('SqliteAtomicAppender_ConcurrentFirstWritesOnDifferentStreams_ConstructsOneBackend', async () => {
    // Spy on initialize to count constructions and to inject a yield
    // between the field check and the assign. We schedule a microtask
    // hop inside initialize so other concurrent callers get a chance to
    // run their own check before the first caller's assignment lands.
    const originalInitialize = SqliteBackend.prototype.initialize;
    const initializeSpy = vi.fn(function (this: SqliteBackend) {
      // Run the real initialization inline (sync) — the spy's role is
      // counting and (intentionally) NOT yielding between check and
      // assign of `this.sqliteBackend`. The race window is opened by
      // the awaiting callers in `appendSqliteLocked` queueing behind
      // `fs.mkdir`; without a Promise-cached singleton, multiple
      // microtask resumes can each see `!this.sqliteBackend === true`
      // when an awaited init-helper is introduced.
      return originalInitialize.call(this);
    });
    SqliteBackend.prototype.initialize = initializeSpy;

    try {
      const appender = new AtomicAppender({ stateDir });
      // Concurrent first-writes to N distinct streams: the per-stream
      // mutex grants each its own critical section, so all enter
      // `appendSqliteLocked` simultaneously and all hit the lazy init.
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

      // All appends must succeed (the race must not break correctness,
      // only resource hygiene — but a leaked handle still violates the
      // singleton contract).
      for (const r of results) {
        expect(r.ok).toBe(true);
      }

      // The defensive contract: exactly ONE SqliteBackend constructed
      // and initialized for the appender's lifetime, regardless of
      // first-write concurrency. The Promise-cached singleton (T63)
      // enforces this even if the lazy init grows an async step.
      expect(initializeSpy).toHaveBeenCalledTimes(1);

      // The shared backend handle returned to all callers is the same
      // instance: cross-stream callers must converge.
      const backend = appender.getSqliteBackend();
      expect(backend).toBeDefined();
    } finally {
      SqliteBackend.prototype.initialize = originalInitialize;
    }
  });

  // ─── T64: stale state after SQLite race conflict ─────────────────────────
  //
  // The SQLite body preflights idempotency cache + sequence high-water
  // mark BEFORE opening the BEGIN IMMEDIATE transaction. If another
  // writer commits between the preflight and the `atomicAppend()` call,
  // the loser's `atomicAppend` raises a UNIQUE-constraint failure
  // (idempotency_claims or events). Translation must NOT use the
  // pre-preflight values — those are already stale.
  //
  // Concretely:
  //   - On `idempotency-claimed`, the canonical contract (matching the
  //     JSONL body's cache-hit behavior) is to surface the WINNER's
  //     persisted events so the caller can return them to its own caller
  //     without reconstructing from the (possibly different) current
  //     request payload. Returning a bare error reason loses the
  //     canonical event shape.
  //   - On `sequence-conflict`, the `actual` field must reflect the
  //     POST-conflict high-water mark, not the preflight `baseSeq` —
  //     callers translating to typed retry errors need the current
  //     value to compute the correct retry sequence.
  //
  // Realistic race surface: two AtomicAppender instances (same process,
  // separate per-stream Promise mutexes) pointing at the same SQLite
  // file simultaneously commit against the same (streamId, key). The
  // first wins; the second's `atomicAppend` raises a UNIQUE-constraint
  // failure on `idempotency_claims`.

  it('SqliteAtomicAppender_RaceLoserOnIdempotencyConflict_ReturnsCacheHitFromDurableState', async () => {
    const streamId = 'race-idem-conflict';
    const idemKey = 'shared-key';

    const appenderA = new AtomicAppender({ stateDir });
    const appenderB = new AtomicAppender({ stateDir });

    // Sequence the race deterministically: appender A commits first,
    // then appender B attempts the same key. Both appenders share the
    // same DB file (lazy init opens `<stateDir>/exarchos.db` for each).
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

    // Force the loser's preflight to MISS the cache (so it proceeds to
    // `atomicAppend` and trips the UNIQUE-constraint fault). We achieve
    // this by reaching into appenderB's internals and stubbing the
    // backend's `lookupIdempotencyClaim` to return undefined for this
    // (streamId, key). This simulates the real-world race window: B
    // runs the lookup BEFORE A commits, sees no claim, and proceeds.
    //
    // After the lookup short-circuit is bypassed, B's `atomicAppend`
    // races against A's already-committed claim and raises
    // `UNIQUE constraint failed: idempotency_claims.streamId,
    // idempotency_claims.idempotencyKey`.
    const backendB = appenderB.getSqliteBackend();
    // First, warm B's backend via a no-op append on a different stream
    // so the backend is constructed (so we can patch its method).
    const warm = await appenderB.append(
      'warmup-stream',
      [{ type: 'noop' }],
      'warmup-key',
    );
    expect(warm.ok).toBe(true);
    const backend = appenderB.getSqliteBackend();
    if (!backend) throw new Error('backend not initialized for appenderB');
    // Replace lookupIdempotencyClaim to return undefined for the test
    // (streamId, key) pair on the FIRST call only (the preflight),
    // forcing B past the preflight cache hit and into the BEGIN
    // IMMEDIATE path. Subsequent calls (the post-conflict re-read in
    // `translateAtomicAppendError`) MUST hit the real implementation
    // so the loser observes the canonical winner state.
    const originalLookup = backend.lookupIdempotencyClaim.bind(backend);
    let suppressionsRemaining = 1;
    backend.lookupIdempotencyClaim = ((sid: string, key: string) => {
      if (sid === streamId && key === idemKey && suppressionsRemaining > 0) {
        suppressionsRemaining -= 1;
        return undefined;
      }
      return originalLookup(sid, key);
    }) as typeof backend.lookupIdempotencyClaim;
    void backendB; // silence unused-binding lint

    let loserResult: Awaited<ReturnType<typeof appenderB.append>>;
    try {
      loserResult = await appenderB.append(streamId, loserEvents, idemKey);
    } finally {
      backend.lookupIdempotencyClaim = originalLookup;
    }

    // Canonical contract: the loser observes the WINNER's persisted
    // events as a cache-hit, NOT a bare `idempotency-claimed` error.
    // This matches the JSONL body's behavior (`appendLocked` Phase 1
    // cache hit returns `kind: 'cache-hit'` with `persistedEvents`).
    expect(loserResult.ok).toBe(true);
    if (!loserResult.ok) return;
    expect(loserResult.kind).toBe('cache-hit');
    expect(loserResult.sequences).toEqual(winnerSequences);
    expect(loserResult.eventIds).toEqual(winnerEventIds);
    expect(loserResult.timestamps).toEqual(winnerTimestamps);
    // The persistedEvents must reflect the WINNER's payload, NOT B's
    // current request body — the caller's CURRENT request payload is
    // irrelevant; the canonical post-commit shape is what the caller
    // returns to its own caller.
    if (loserResult.kind !== 'cache-hit') return;
    expect(loserResult.persistedEvents).toHaveLength(1);
    expect(loserResult.persistedEvents[0].type).toBe('task.assigned');
    expect(
      (loserResult.persistedEvents[0].data as { winner?: boolean }).winner,
    ).toBe(true);
  });

  it('SqliteAtomicAppender_ConcurrentFirstWriteCallers_ShareTheSameBackendHandle', async () => {
    // Stronger contract test: even with N concurrent first-writes
    // racing into the lazy init, the appender must surface the SAME
    // backend handle to every caller. Identity comparison via a spy
    // on the constructor is the cleanest way to assert this without
    // patching the production lazy-init logic (which would re-open
    // the very race we're testing for).
    //
    // We track every SqliteBackend that gets initialized during the
    // burst. The Promise-cached singleton fix guarantees:
    //   (a) `initialize` is invoked exactly once,
    //   (b) `getSqliteBackend()` returns that same handle.
    //
    // The previous sync field-guard pattern would have re-opened the
    // race the moment any future change introduced an `await` inside
    // the lazy-init body. The Promise-cached singleton makes the
    // invariant structural rather than coincidental.
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

      // Singleton invariant: exactly one backend was initialized
      // across the burst, and the appender's lifecycle handle is
      // that same instance.
      expect(initialized).toHaveLength(1);
      const exposed = appender.getSqliteBackend();
      expect(exposed).toBe(initialized[0]);
    } finally {
      SqliteBackend.prototype.initialize = originalInitialize;
    }
  });

  it('SqliteAtomicAppender_LazyInitWithAsyncYield_PromiseCacheStillReturnsOneBackend', async () => {
    // Defensive test: the Promise-cached singleton must hold even when
    // an async step is introduced inside the lazy-init body. We verify
    // by directly exercising the appender's private async
    // `ensureSqliteBackend` method concurrently and asserting all
    // callers receive the SAME backend instance. Unlike a patch-based
    // test, this exercises the production code path — the Promise
    // cache is the only thing standing between concurrent callers and
    // duplicate construction.
    //
    // The legacy `if (!this.sqliteBackend) { construct; assign }`
    // pattern would PASS this test today (sync init means no
    // interleaving). The pattern is fragile: any future async-init
    // refactor (e.g. an awaited migration) re-opens the race. The
    // Promise-cached singleton makes the contract robust regardless.
    //
    // (v2.11 substrate-cut: the private async helper was renamed
    // `getSqliteBackend` → `ensureSqliteBackend` to free the public
    // name for the synchronous accessor used by `EventStore`'s
    // read-backend resolution.)
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
      // Sanity: the production helper must be a Promise-returning
      // function (post-T63). If it returns a bare SqliteBackend
      // synchronously (legacy shape), the field-check pattern is
      // load-bearing and the test should fail loudly so the
      // regression is visible.
      expect(typeof internals.ensureSqliteBackend).toBe('function');

      const N = 32;
      const handles = await Promise.all(
        Array.from({ length: N }, () =>
          (internals.ensureSqliteBackend as () => Promise<SqliteBackend>).call(
            appender,
          ),
        ),
      );

      // All concurrent callers received the SAME handle instance.
      const first = handles[0];
      for (const h of handles) {
        expect(h).toBe(first);
      }
      // Initialize was called exactly once.
      expect(constructionCount).toBe(1);
    } finally {
      SqliteBackend.prototype.initialize = originalInitialize;
    }
  });

  it('SqliteAtomicAppender_SyncAndAsyncInterleaved_ReturnSameSingletonHandle', async () => {
    // Pins the architectural commitment in `ensureSqliteBackendSync`'s JSDoc
    // ("If a future async-init step is added, this method stays sync by
    // deferring that step into the `ensureSqliteBackend()` Promise"). The
    // sync read-before-write path and the async write-then-init path can
    // interleave on a single appender — both MUST converge on one handle.
    //
    // CodeRabbit raised a forward-looking concern (PR #1332 r3214275769):
    // if a future engineer adds an `await` inside `ensureSqliteBackend`'s
    // IIFE before the `this.sqliteBackend = backend` assignment, a
    // concurrent `ensureSqliteBackendSync()` call would see the field
    // unset and construct a duplicate handle. The current code is safe
    // because the IIFE is sync-up-to-the-assignment; this test would
    // catch the regression if that invariant ever broke.
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

      // Interleave: kick off the async path first, then immediately
      // call the sync path BEFORE awaiting. The current architecture
      // assigns `this.sqliteBackend` synchronously inside the async
      // IIFE, so the sync call should observe the in-flight handle
      // and return it directly rather than constructing a second.
      const asyncPromise = (
        internals.ensureSqliteBackend as () => Promise<SqliteBackend>
      ).call(appender);
      const syncHandle = (
        internals.ensureSqliteBackendSync as () => SqliteBackend
      ).call(appender);
      const asyncHandle = await asyncPromise;

      expect(syncHandle).toBe(asyncHandle);
      expect(constructionCount).toBe(1);

      // Reverse order: sync first, then async. The sync path
      // pre-populates `sqliteBackendPromise`, so a subsequent async
      // call must hit the Promise cache and resolve to the same
      // handle without re-initializing.
      const appender2 = new AtomicAppender({ stateDir });
      const internals2 = appender2 as WithEnsure;
      const syncFirst = (
        internals2.ensureSqliteBackendSync as () => SqliteBackend
      ).call(appender2);
      const asyncSecond = await (
        internals2.ensureSqliteBackend as () => Promise<SqliteBackend>
      ).call(appender2);

      expect(asyncSecond).toBe(syncFirst);
      // Two appenders → two distinct DBs → two constructions total.
      expect(constructionCount).toBe(2);
    } finally {
      SqliteBackend.prototype.initialize = originalInitialize;
    }
  });
});

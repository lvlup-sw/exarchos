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
 *   - Substrate integrity — JSONL parses cleanly line-by-line, or SQLite
 *     row count matches the issued writes (no truncated/interleaved
 *     records, no drops, no spurious dupes).
 *   - Total event count matches the number of writes issued — no drops,
 *     no duplicates beyond the explicit idempotency-dedup contract.
 *
 * Pre-migration (or pre-#1259 SQLite flip) these tests fail (overlapping
 * sequences and substrate corruption). Post-migration they pass because
 * both paths now share the single `AtomicAppender` instance returned by
 * `EventStore.getAppender()` and that appender is parametrized over the
 * substrate body.
 *
 * T51 parametrization (#1259):
 *
 *   The cross-path suite below runs twice — once against the JSONL
 *   substrate (legacy v2.9 body) and once against the SQLite substrate
 *   (DR-1 #1259 body). The substrate is selected via
 *   `new EventStore(stateDir, { appenderBackend })` — a small option
 *   added to `EventStoreOptions` to plumb the appender substrate through
 *   the lazy `getAppender()` site (the existing `EventStoreOptions.backend`
 *   field selects the read-delegate `StorageBackend`, which is a
 *   different concern). Substrate-agnostic invariants (sequence
 *   monotonicity, total event count, no drops/duplicates) parametrize
 *   cleanly. The JSONL line-integrity check is substrate-specific and
 *   gated behind `if (backend === 'jsonl')`; the SQLite branch asserts
 *   the equivalent invariant via `getAppender()._testOnly_getSqliteBackend()`
 *   and `queryEvents(streamId)`.
 */
describe.each([
  { backend: 'jsonl' as const },
  { backend: 'sqlite' as const },
])('EventStore cross-path race [$backend] (#1293)', ({ backend }) => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), `eventstore-race-${backend}-`));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  /**
   * Substrate-agnostic verification helper.
   *
   *   - JSONL: read the on-disk `.events.jsonl`, parse line-by-line, and
   *     return the sequences. The line-count check enforces "every line
   *     parses" (the pre-#1293 race corrupted this).
   *   - SQLite: query the events table for the stream and return the row
   *     sequences. The PRIMARY KEY on (streamId, sequence) makes
   *     duplicate detection redundant at the DB level, but the assertion
   *     that the count matches the number of issued writes catches the
   *     drop-on-conflict failure mode.
   */
  async function readPersistedSequences(
    store: EventStore,
    streamId: string,
  ): Promise<number[]> {
    if (backend === 'jsonl') {
      const jsonl = await readFile(
        path.join(stateDir, `${streamId}.events.jsonl`),
        'utf-8',
      );
      const lines = jsonl.trim().split('\n').filter(Boolean);
      // Every line must parse cleanly — no truncated or interleaved records.
      const sequences: number[] = [];
      for (const line of lines) {
        const parsed = JSON.parse(line) as { sequence: number };
        sequences.push(parsed.sequence);
      }
      return sequences;
    }
    // SQLite: query the events table directly via the appender's backend.
    const sqliteBackend = store.getAppender()._testOnly_getSqliteBackend();
    if (!sqliteBackend) {
      throw new Error('expected SQLite backend on appender; got undefined');
    }
    const events = sqliteBackend.queryEvents(streamId);
    return events.map((e) => e.sequence);
  }

  it('EventStore_concurrentLegacyAppendAndBatchAppend_strictSequenceMonotonicity', async () => {
    const store = new EventStore(stateDir, { appenderBackend: backend });
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

    // Read the persisted sequences and assert monotonicity + no duplicates.
    const sequences = await readPersistedSequences(store, streamId);
    expect(sequences).toHaveLength(3 * N);

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
    const store = new EventStore(stateDir, { appenderBackend: backend });
    const streamId = 'append-only-race';
    const N = 100;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.append(streamId, { type: 'task.assigned', data: { i } }),
      ),
    );
    const sequences = results.map(r => r.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: N }, (_, i) => i + 1));

    const persistedSeqs = await readPersistedSequences(store, streamId);
    expect(persistedSeqs).toHaveLength(N);
    // Substrate integrity: every persisted sequence is in 1..N exactly once.
    // For JSONL this also exercises "every line parses cleanly"
    // (`readPersistedSequences` JSON-parses each line); for SQLite the PK
    // on (streamId, sequence) enforces uniqueness at the storage layer
    // and the row count guards against drops.
    expect([...persistedSeqs].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
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
  //
  // This case is JSONL-irrelevant (it constructs the appender directly
  // with `backend: 'sqlite'`) so it stays gated and runs only in the
  // SQLite arm of the `describe.each` to avoid duplicate work.
  if (backend === 'sqlite') {
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
  }

  it('EventStore_concurrentLegacyAndDirectAppender_jsonlIntegrity', async () => {
    // Sentry's specific concern from the #1265 re-review:
    // "Concurrent calls to handleEventAppend and handleBatchAppend can
    //  cause a race condition" (event-store/tools.ts:424). This test
    // reproduces that interleaving by issuing N legacy + N direct writes
    // simultaneously and verifying the substrate is internally
    // consistent (every record parses; sequences are unique and dense).
    const store = new EventStore(stateDir, { appenderBackend: backend });
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

    const sequences = await readPersistedSequences(store, streamId);
    expect(sequences).toHaveLength(2 * N);
    expect(new Set(sequences).size).toBe(2 * N);
    expect([...sequences].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 2 * N }, (_, i) => i + 1),
    );
  });
});

/**
 * T51 — multi-stream linearizability under SQLite (#1259).
 *
 * The SQLite substrate stores every stream's events in a single `events`
 * table keyed on `(streamId, sequence)` (T11 unified primitive). This
 * suite stresses the cross-stream concurrency path: N distinct streams
 * x M events each, mixing the three append paths (`store.append`,
 * `store.batchAppend`, `store.getAppender().append`) so all of the
 * production write entry points run interleaved against the same SQLite
 * file under one Node.js process.
 *
 * Linearizability invariants asserted:
 *
 *   1. Per-stream monotonicity — within each stream, sequences are
 *      `1..M` exactly (no gaps, no duplicates, no overlaps). The
 *      per-stream Promise mutex is the FIRST-tier guard; the SQLite
 *      `(streamId, sequence)` PRIMARY KEY is the SECOND-tier guard.
 *   2. Cross-stream isolation — every event lands in the correct
 *      stream's row. We tag each event with `data.streamTag` matching
 *      its target stream and assert the persisted row's `streamId`
 *      matches the tag. This catches any cross-stream leak the SQLite
 *      INSERT path might introduce.
 *   3. Total event count — exactly `N * M` events committed across all
 *      streams. No drops, no spurious dupes.
 *   4. Linearizability witness — the union of every per-stream
 *      sequence set is consistent with a global linear order: the
 *      events table contains `N * M` rows, each (streamId, sequence)
 *      pair appears once, and per-stream sequences are dense `1..M`.
 *      Because `BEGIN IMMEDIATE` serializes every commit globally on
 *      one writer connection, this is the linearizability witness:
 *      no concurrent commit can interleave between sequence
 *      allocation and event INSERT for any stream.
 *
 * The plan (testingStrategy line ~1132) anticipates GREEN on first run
 * if T06–T11 are correct. If a race window does surface, the failure
 * pattern (which assertion, which path, which stream) is the
 * diagnostic — see the per-assertion comments below.
 */
describe('EventStore multi-stream linearizability [sqlite]', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'eventstore-multistream-sqlite-'));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('Multistream_NConcurrentStreamsXM_AllPerStreamSequencesDenseAndIsolated', async () => {
    const store = new EventStore(stateDir, { appenderBackend: 'sqlite' });
    const N = 20; // streams
    const M = 50; // events per stream

    // Build a flat work list of (streamIndex, eventIndex, path) triples.
    // Mix the three append paths in a deterministic round-robin so each
    // stream sees every path roughly equally — this exercises the cross-
    // path interleaving the plan calls out (single + batch + direct).
    type Job = { stream: string; i: number; path: 'single' | 'batched' | 'direct' };
    const paths: Array<Job['path']> = ['single', 'batched', 'direct'];
    const jobs: Job[] = [];
    for (let s = 0; s < N; s++) {
      const stream = `multistream-${s}`;
      for (let i = 0; i < M; i++) {
        jobs.push({ stream, i, path: paths[(s + i) % paths.length] });
      }
    }
    expect(jobs).toHaveLength(N * M);

    // Issue every append concurrently. Promise.all drives the scheduler
    // to interleave them maximally — under SQLite, the BEGIN IMMEDIATE
    // serialization should still produce a globally linear commit log.
    const promises: Promise<unknown>[] = [];
    for (const job of jobs) {
      const tag = { streamTag: job.stream, i: job.i, path: job.path };
      switch (job.path) {
        case 'single':
          promises.push(
            store.append(job.stream, {
              type: 'task.assigned',
              data: tag,
            }),
          );
          break;
        case 'batched':
          promises.push(
            store.batchAppend(job.stream, [
              { type: 'task.completed', data: tag },
            ]),
          );
          break;
        case 'direct':
          promises.push(
            store
              .getAppender()
              .append(
                job.stream,
                [{ type: 'workflow.transition', data: tag }],
                `direct-${job.stream}-${job.i}`,
              ),
          );
          break;
      }
    }

    const results = await Promise.all(promises);
    expect(results).toHaveLength(N * M);

    // ─── Invariant 1: per-stream monotonicity ───────────────────────────
    //
    // Query each stream independently from the SQLite events table; the
    // `queryEvents` order-by-sequence guarantees we see them in commit
    // order. Each stream must have `1..M` densely.
    const sqliteBackend = store.getAppender()._testOnly_getSqliteBackend();
    if (!sqliteBackend) {
      throw new Error('expected SQLite backend on appender; got undefined');
    }

    let totalCount = 0;
    const allKeys = new Set<string>();
    for (let s = 0; s < N; s++) {
      const stream = `multistream-${s}`;
      const events = sqliteBackend.queryEvents(stream);
      expect(events, `stream ${stream}`).toHaveLength(M);
      const seqs = events.map((e) => e.sequence);
      expect(seqs, `stream ${stream} sequence density`).toEqual(
        Array.from({ length: M }, (_, i) => i + 1),
      );

      // ─── Invariant 2: cross-stream isolation ──────────────────────────
      //
      // Every event row's `streamId` column matches the stream we
      // queried, and the `data.streamTag` we tagged at write-time
      // matches the same stream. A leak would surface as either a
      // streamId mismatch on the row or a streamTag pointing at a
      // different stream than the row claims.
      for (const event of events) {
        expect(event.streamId, `row streamId for ${stream}`).toBe(stream);
        const data = event.data as { streamTag?: string } | undefined;
        expect(data?.streamTag, `streamTag on ${stream} seq ${event.sequence}`).toBe(stream);
      }

      // Track global key set for the union-count invariant below.
      for (const event of events) {
        allKeys.add(`${event.streamId}#${event.sequence}`);
      }
      totalCount += events.length;
    }

    // ─── Invariant 3: total event count ─────────────────────────────────
    //
    // Sum of per-stream counts equals N*M. No drops, no spurious dupes.
    expect(totalCount).toBe(N * M);

    // ─── Invariant 4: linearizability witness ───────────────────────────
    //
    // Every (streamId, sequence) pair appears exactly once across the
    // global events table. The (streamId, sequence) PRIMARY KEY makes
    // duplicates impossible at the storage layer, so this is also a
    // signal that no commit was lost: if a sequence allocation under
    // contention had been retried with a stale counter and the
    // BEGIN IMMEDIATE had aborted the second commit, that stream's
    // dense `1..M` check above would have caught it. The union-count
    // assertion here closes the global-uniqueness witness directly.
    expect(allKeys.size).toBe(N * M);

    // ─── Invariant 5: stream enumeration consistency ────────────────────
    //
    // The backend must enumerate every stream we wrote to. `listStreams`
    // is the entry point cross-stream queries (DR-3 reducers) rely on;
    // a multi-stream commit pattern that left a stream invisible to
    // enumeration would fail every cross-stream materializer downstream.
    const enumerated = sqliteBackend.listStreams().sort();
    const expected = Array.from({ length: N }, (_, s) => `multistream-${s}`).sort();
    expect(enumerated).toEqual(expected);
  });
});

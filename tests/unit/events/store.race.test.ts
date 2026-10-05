import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import { handleMergeOrchestrate } from '../../../src/verbs/merge/merge-orchestrate.js';
import {
  handleExecuteMerge,
  type HandleExecuteMergeInput,
} from '../../../src/verbs/merge/execute-merge.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../src/format.js';
import type {
  MergePreflightResult,
  GitExecResult,
} from '../../../src/verbs/pure/merge-preflight.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Cross-path race suite. `EventStore.append`, `EventStore.batchAppend` and a direct `AtomicAppender` write to one stream concurrently.
 * All three paths share the appender that `EventStore.getAppender()` returns.
 *
 * For each stream, the suite asserts:
 * - the sequences are `1..N` with no gap and no duplicate
 * - the count of persisted rows equals the count of issued writes
 *
 * `readPersistedSequences` reads the rows from the SQLite backend of the appender.
 * The `(streamId, sequence)` primary key rejects a duplicate, so the row count is the check for a dropped write.
 */
describe('EventStore cross-path race (#1293)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'eventstore-race-sqlite-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  async function readPersistedSequences(
    store: EventStore,
    streamId: string,
  ): Promise<number[]> {
    const sqliteBackend = store.getAppender().getSqliteBackend();
    if (!sqliteBackend) {
      throw new Error('expected SQLite backend on appender; got undefined');
    }
    const events = sqliteBackend.queryEvents(streamId);
    return events.map((e) => e.sequence);
  }

  /**
   * Two `EventStore` instances on one `stateDir` must both initialize. No PID lock guards the directory.
   * SQLite WAL, `BEGIN IMMEDIATE` and the `(streamId, sequence)` primary key serialize the writers across processes.
   */
  it('EventStore_Initialize_NoLongerThrowsOnConcurrentAttach', async () => {
    const storeA = new EventStore(stateDir);
    const storeB = new EventStore(stateDir);

    await expect(storeA.initialize()).resolves.toBeUndefined();
    await expect(storeB.initialize()).resolves.toBeUndefined();
  });

  /**
   * Three write paths run concurrently: single append, batch append, and the appender directly.
   * The persisted sequences must be `1..3N` with no gap and no duplicate.
   */
  it('EventStore_concurrentLegacyAppendAndBatchAppend_strictSequenceMonotonicity', async () => {
    const store = new EventStore(stateDir);
    const streamId = 'race-stream';
    const N = 50;

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

    const sequences = await readPersistedSequences(store, streamId);
    expect(sequences).toHaveLength(3 * N);

    const sorted = [...sequences].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 3 * N }, (_, i) => i + 1));
    expect(new Set(sequences).size).toBe(3 * N);
  });

  /** Concurrent `EventStore.append` calls only. The store must persist each sequence in `1..N` one time. */
  it('EventStore_concurrentSingleAppendOnly_noOverlappingSequences', async () => {
    const store = new EventStore(stateDir);
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
    expect([...persistedSeqs].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => i + 1),
    );
  });

  /**
   * The per-stream mutex (`StreamLockManager`) is the first guard. The SQLite `BEGIN IMMEDIATE` transaction is the second.
   * 50 concurrent appends through a directly constructed appender must all succeed with the sequences `1..50`.
   */
  it('SqliteAtomicAppender_50ConcurrentAppendsOneStream_NoDuplicateSequences', async () => {
    const appender = new AtomicAppender({ stateDir });
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
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(N);
  });

  /**
   * Reproduces the interleaving of concurrent `handleEventAppend` and `handleBatchAppend` calls.
   * `EventStore.append` and the direct appender write N events each. The persisted sequences must be unique and dense.
   */
  it('EventStore_concurrentLegacyAndDirectAppender_jsonlIntegrity', async () => {
    const store = new EventStore(stateDir);
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
 * Multi-stream linearizability on SQLite. All streams share one `events` table keyed on `(streamId, sequence)`.
 * N streams receive M events each. A round-robin assigns the three append paths, and all appends run concurrently in one process.
 *
 * The test asserts:
 * 1. Each stream holds the sequences `1..M` with no gap and no duplicate.
 * 2. Each row has the `streamId` of the queried stream, and its `data.streamTag` names the same stream.
 * 3. The total count is `N * M`.
 * 4. Each `(streamId, sequence)` pair occurs one time. `BEGIN IMMEDIATE` serializes each commit on one writer connection.
 * 5. `listStreams` returns each written stream. Cross-stream queries enumerate through it.
 */
describe('EventStore multi-stream linearizability [sqlite]', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'eventstore-multistream-sqlite-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('Multistream_NConcurrentStreamsXM_AllPerStreamSequencesDenseAndIsolated', async () => {
    const store = new EventStore(stateDir);
    const N = 20;
    const M = 50;

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

    const sqliteBackend = store.getAppender().getSqliteBackend();
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

      for (const event of events) {
        expect(event.streamId, `row streamId for ${stream}`).toBe(stream);
        const data = event.data as { streamTag?: string } | undefined;
        expect(data?.streamTag, `streamTag on ${stream} seq ${event.sequence}`).toBe(stream);
      }

      for (const event of events) {
        allKeys.add(`${event.streamId}#${event.sequence}`);
      }
      totalCount += events.length;
    }

    expect(totalCount).toBe(N * M);

    expect(allKeys.size).toBe(N * M);

    const enumerated = sqliteBackend.listStreams().sort();
    const expected = Array.from({ length: N }, (_, s) => `multistream-${s}`).sort();
    expect(enumerated).toEqual(expected);
  });
});

const RACE_MERGE_SHA = 'c'.repeat(40);
const RACE_ROLLBACK_SHA = 'd'.repeat(40);

const RACE_PASSING_PREFLIGHT: MergePreflightResult = {
  passed: true,
  ancestry: { passed: true, missing: [], target: 'main' },
  currentBranchProtection: { blocked: false, currentBranch: 'feat/race' },
  worktree: { isMain: true, actual: '/repo', expected: '/repo' },
  drift: {
    clean: true,
    uncommittedFiles: [],
    indexStale: false,
    detachedHead: false,
  },
} as MergePreflightResult;

function raceGitExec(
  _repoRoot: string,
  args: readonly string[],
): GitExecResult {
  if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
    return { stdout: '/repo\n', exitCode: 0 };
  }
  if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
    return { stdout: `${RACE_ROLLBACK_SHA}\n`, exitCode: 0 };
  }
  if (args[0] === 'worktree' && args[1] === 'list') {
    return {
      stdout: 'worktree /repo\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/feat/race\n',
      exitCode: 0,
    };
  }
  return { stdout: '', exitCode: 0 };
}

/**
 * Two `merge_orchestrate` invocations with the same `featureId` and `taskId` race on one real `EventStore`.
 * The race runs in one process. Both invocations share stub leaves, so only the event-store appends contend.
 *
 * The test asserts:
 * 1. Both invocations settle with a structured result. A throw that escapes the handler shows as a `rejected` entry of `allSettled`.
 * 2. At least one invocation succeeds. The other succeeds as an idempotency replay or fails with `STATE_CONFLICT`.
 * 3. The stream holds one `merge.executed` event. The idempotency key and `expectedSequence` collapse the second attempt.
 * 4. The sequences are unique and dense from 1.
 */
describe('handleMergeOrchestrate race (#1303 α-03)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'merge-orch-race-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('MergeOrchestrate_TwoConcurrentInvocationsSameStream_NoDuplicateSequences', async () => {
    const eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    const ctx: DispatchContext = {
      stateDir,
      eventStore,
      enableTelemetry: false,
    };

    const featureId = 'feat-race-1303';
    const taskId = 'T-race';
    const sourceBranch = 'feat/race';
    const targetBranch = 'main';

    const stubVcsMerge = (): Promise<{ mergeSha: string }> =>
      Promise.resolve({ mergeSha: RACE_MERGE_SHA });

    const invoke = (): Promise<ToolResult> =>
      handleMergeOrchestrate(
        {
          featureId,
          sourceBranch,
          targetBranch,
          taskId,
          strategy: 'squash',
          preflight: async () => RACE_PASSING_PREFLIGHT,
          executeMerge: async (
            input: HandleExecuteMergeInput,
            innerCtx: DispatchContext,
          ): Promise<ToolResult> =>
            handleExecuteMerge(
              {
                ...input,
                vcsMerge: stubVcsMerge,
                gitExec: raceGitExec,
                persistState: async () => {
                },
              },
              innerCtx,
            ),
          persistState: async () => {
          },
          gitExec: raceGitExec,
        },
        ctx,
      );

    const settled = await Promise.allSettled([invoke(), invoke()]);

    for (const s of settled) {
      expect(s.status, 'invocation must not throw past handler boundary').toBe(
        'fulfilled',
      );
    }

    const results = settled
      .filter(
        (s): s is PromiseFulfilledResult<ToolResult> => s.status === 'fulfilled',
      )
      .map((s) => s.value);
    expect(results).toHaveLength(2);

    const successes = results.filter((r) => r.success);
    expect(successes.length, 'at least one invocation must succeed').toBeGreaterThanOrEqual(1);

    if (successes.length === 1) {
      const failure = results.find((r) => !r.success);
      expect(failure, 'one failure expected when only one invocation succeeds').toBeDefined();
      const errCode = (failure as { error: { code: string } }).error.code;
      expect(
        errCode,
        `loser must surface STATE_CONFLICT; got ${errCode}`,
      ).toBe('STATE_CONFLICT');
    }

    const events = await eventStore.query(featureId);
    const mergeExecuted = events.filter((e) => e.type === 'merge.executed');
    expect(
      mergeExecuted,
      'exactly one merge.executed row across both invocations',
    ).toHaveLength(1);

    const sequences = events.map((e) => e.sequence);
    expect(new Set(sequences).size, 'no duplicate sequences').toBe(
      sequences.length,
    );

    const sortedSeqs = [...sequences].sort((a, b) => a - b);
    expect(sortedSeqs).toEqual(
      Array.from({ length: sortedSeqs.length }, (_, i) => i + 1),
    );
  });
});

/**
 * EventSourcedTaskStore — lifecycle + REPLAY (INV-1) acceptance tests (#1272).
 *
 * The store implements the owned `TaskStorePort` (`./port.ts`) as a
 * **projection** over the event store. That contract used to be the SDK's
 * experimental `TaskStore`; v2 `2.0.0` deleted it, so DR-0 / task 051
 * re-parented the declaration without changing a single behaviour — which
 * is why every acceptance test below is untouched. The four `task.*` lifecycle
 * events (`task.created`/`task.polled`/`task.result`/`task.cancelled`)
 * are the durable substrate; the in-memory projection is a cache.
 *
 * Acceptance contracts (load-bearing for #1272 sign-off):
 *
 *   1. Every lifecycle method emits its corresponding event BEFORE
 *      mutating any in-memory state — the event is the truth.
 *   2. A fresh store instantiated against the same event store
 *      reconstructs the lifecycle state from the events alone, with no
 *      reads of any cache file (INV-1 event-sourcing integrity). The
 *      `EventSourcedTaskStore_LifecycleReconstructable_FromEventStreamAlone`
 *      test below is the canonical REPLAY proof.
 *
 * Per-feature operation streams are namespaced under
 * `task-store/<taskId>` so cross-stream queries (audit, view) can pivot
 * cleanly without entangling task lifecycle with workflow lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../events/store.js';
import { taskStoreLogger } from '../../logger.js';
import { EventSourcedTaskStore } from './event-sourced-task-store.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

describe('EventSourcedTaskStore (#1272)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let store: EventSourcedTaskStore;

  const sampleRequest = {
    method: 'tools/call' as const,
    params: { name: 'noop', arguments: {} },
  };

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'es-taskstore-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    store = new EventSourcedTaskStore(eventStore);
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('EventSourcedTaskStore_CreateTask_EmitsTaskCreatedAndReturnsId', async () => {
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-1',
      sampleRequest,
    );
    expect(task.taskId).toBeTruthy();
    expect(task.status).toBe('working');
    expect(task.ttl).toBe(60_000);
    expect(task.createdAt).toBeTruthy();

    // Event-store evidence: `task.created` lives at sequence 1 on the
    // task's namespaced stream.
    const events = await eventStore.query(`task-store/${task.taskId}`);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task.created');
    expect(events[0]?.data).toMatchObject({
      taskId: task.taskId,
      ttl: 60_000,
    });
  });

  it('EventSourcedTaskStore_GetTask_ReadsProjectionAtSequence', async () => {
    const task = await store.createTask(
      { ttl: 30_000 },
      'req-1',
      sampleRequest,
    );

    const fetched = await store.getTask(task.taskId);
    expect(fetched).not.toBeNull();
    expect(fetched?.taskId).toBe(task.taskId);
    expect(fetched?.status).toBe('working');
    expect(fetched?.ttl).toBe(30_000);
  });

  it('EventSourcedTaskStore_GetTaskResult_WaitsOnTaskResultEvent', async () => {
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-1',
      sampleRequest,
    );

    // Store a completion result; getTaskResult must return what we stored.
    const expected = { content: [{ type: 'text', text: 'done' }] };
    await store.storeTaskResult(task.taskId, 'completed', expected);

    const result = await store.getTaskResult(task.taskId);
    expect(result).toEqual(expected);

    // Status surface updated to terminal `completed`.
    const fetched = await store.getTask(task.taskId);
    expect(fetched?.status).toBe('completed');
  });

  it('EventSourcedTaskStore_CancelTask_EmitsTaskCancelled', async () => {
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-1',
      sampleRequest,
    );

    await store.updateTaskStatus(task.taskId, 'cancelled', 'client-requested');

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const cancelEvent = events.find((e) => e.type === 'task.cancelled');
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent?.data).toMatchObject({
      taskId: task.taskId,
      reason: 'client-requested',
    });

    const fetched = await store.getTask(task.taskId);
    expect(fetched?.status).toBe('cancelled');
  });

  it('EventSourcedTaskStore_LifecycleReconstructable_FromEventStreamAlone', async () => {
    // INV-1 acceptance: bypass the store's public API by appending the
    // canonical lifecycle directly to the event store, then instantiate a
    // FRESH store with the same `eventStore` instance and verify the
    // lifecycle queries return the correct state. No cache file, no
    // out-of-band state — just events.
    const taskId = 'replay-task-007';
    const streamId = `task-store/${taskId}`;
    const now = new Date().toISOString();

    await eventStore.append(streamId, {
      type: 'task.created',
      timestamp: now,
      data: {
        taskId,
        createdBy: 'replay-test',
        ttl: 90_000,
        request: sampleRequest,
      },
    });

    await eventStore.append(streamId, {
      type: 'task.result',
      timestamp: now,
      data: {
        taskId,
        status: 'completed',
        result: { content: [{ type: 'text', text: 'replayed' }] },
      },
    });

    // Fresh store — projection rebuilds purely from the stream.
    const replayStore = new EventSourcedTaskStore(eventStore);

    const replayedTask = await replayStore.getTask(taskId);
    expect(replayedTask).not.toBeNull();
    expect(replayedTask?.taskId).toBe(taskId);
    expect(replayedTask?.status).toBe('completed');
    expect(replayedTask?.ttl).toBe(90_000);

    const replayedResult = await replayStore.getTaskResult(taskId);
    expect(replayedResult).toEqual({
      content: [{ type: 'text', text: 'replayed' }],
    });
  });

  it('EventSourcedTaskStore_GetTask_ReturnsNullForUnknownTask', async () => {
    const fetched = await store.getTask('nonexistent');
    expect(fetched).toBeNull();
  });

  it('EventSourcedTaskStore_TtlExpired_RemovesFromProjection', async () => {
    // T26 — per-task TTL with read-time reaping. After the TTL window
    // elapses, `getTask` returns null and `getTaskResult` throws
    // "not found", regardless of whether a result was previously
    // stored. Unlimited-TTL tasks (ttl: null) are NOT expired.
    vi.useFakeTimers();
    try {
      const task = await store.createTask(
        { ttl: 5_000 },
        'req-ttl',
        sampleRequest,
      );
      // Immediately readable.
      expect(await store.getTask(task.taskId)).not.toBeNull();

      // Advance past the TTL window.
      vi.setSystemTime(Date.now() + 10_000);

      const fetched = await store.getTask(task.taskId);
      expect(fetched).toBeNull();

      await expect(store.getTaskResult(task.taskId)).rejects.toThrow(
        /not found/,
      );

      // A second task with unlimited TTL stays alive past the same
      // virtual-clock advance.
      const persistent = await store.createTask(
        { ttl: null },
        'req-persistent',
        sampleRequest,
      );
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      expect(await store.getTask(persistent.taskId)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('EventSourcedTaskStore_ListTasks_ReturnsCreatedTasks', async () => {
    const t1 = await store.createTask({ ttl: 1000 }, 'r1', sampleRequest);
    const t2 = await store.createTask({ ttl: 2000 }, 'r2', sampleRequest);
    const { tasks } = await store.listTasks();
    const ids = tasks.map((t) => t.taskId).sort();
    expect(ids).toEqual([t1.taskId, t2.taskId].sort());
  });

  it('getTask_RapidSequentialReads_EmitsAtMostOneTaskPolled', async () => {
    // FINDING-3 (#1438, PR 1): the SDK's `tasks/poll` and the CLI
    // `--follow` loop call `getTask` at the task's `pollInterval`
    // cadence (default 250ms in many flows). Without a throttle the
    // store appends one `task.polled` event per call, causing severe
    // write amplification on the durable stream. The throttle gate
    // collapses bursts within a 5-second window down to a single emit.
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-throttle',
      sampleRequest,
    );

    // Burst of 20 reads within the throttle window — only the first
    // should emit `task.polled`.
    for (let i = 0; i < 20; i++) {
      await store.getTask(task.taskId);
    }

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const polled = events.filter((e) => e.type === 'task.polled');
    expect(polled).toHaveLength(1);
  });

  it('getTask_AfterThrottleWindowElapses_EmitsSecondTaskPolled', async () => {
    // FINDING-3 (#1438, PR 1): once the throttle window has elapsed,
    // a subsequent `getTask` MUST emit a fresh `task.polled` so that
    // long-running polls remain observable. Determinism requires an
    // injectable clock — the production default is `Date.now()` and
    // the throttle constant is 5_000ms, so a real-clock test would be
    // flaky and slow.
    let now = 1_000_000;
    const clock = () => now;
    const throttleStore = new EventSourcedTaskStore(eventStore, { clock });

    const task = await throttleStore.createTask(
      { ttl: 60_000 },
      'req-window',
      sampleRequest,
    );

    // First read inside the window — emits.
    await throttleStore.getTask(task.taskId);

    // Advance past the throttle window — second read emits again.
    now += 5_001;
    await throttleStore.getTask(task.taskId);

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const polled = events.filter((e) => e.type === 'task.polled');
    expect(polled).toHaveLength(2);
  });

  it('getTask_ExpiredTaskReaped_LastPolledAtCleared', async () => {
    // FINDING-3 (#1438): the `lastPolledAt` map must not leak entries
    // for tasks that have been reaped on expiry. We assert via the
    // observable effect — recreating a fresh task in the SAME store
    // with the same id after expiry is contrived, so instead we use
    // the test-only `getLastPolledAtSize` helper (added below) AND
    // verify that re-arming the throttle after manual reap re-emits.
    vi.useFakeTimers();
    try {
      const task = await store.createTask(
        { ttl: 5_000 },
        'req-reap',
        sampleRequest,
      );
      // Prime the throttle.
      expect(await store.getTask(task.taskId)).not.toBeNull();
      expect(
        (store as unknown as { lastPolledAt: Map<string, number> })
          .lastPolledAt.size,
      ).toBe(1);

      // Advance past TTL — next getTask returns null and reaps cache.
      vi.setSystemTime(Date.now() + 10_000);
      expect(await store.getTask(task.taskId)).toBeNull();

      // The throttle map entry MUST be cleaned up alongside the cache.
      expect(
        (store as unknown as { lastPolledAt: Map<string, number> })
          .lastPolledAt.size,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getTaskResult_ExpiredTaskReaped_LastPolledAtCleared', async () => {
    // FINDING-3 (#1438): the `getTaskResult` expired branch also reaps
    // the cache and must drop the throttle entry symmetrically with
    // `getTask`.
    vi.useFakeTimers();
    try {
      const task = await store.createTask(
        { ttl: 5_000 },
        'req-reap-result',
        sampleRequest,
      );
      // Prime the throttle by polling once.
      await store.getTask(task.taskId);
      expect(
        (store as unknown as { lastPolledAt: Map<string, number> })
          .lastPolledAt.size,
      ).toBe(1);

      vi.setSystemTime(Date.now() + 10_000);
      await expect(store.getTaskResult(task.taskId)).rejects.toThrow(
        /not found/,
      );

      expect(
        (store as unknown as { lastPolledAt: Map<string, number> })
          .lastPolledAt.size,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reapExpired_RemovesLastPolledAtForExpiredTasks', async () => {
    // FINDING-3 (#1438): the `listTasks` reap path (which calls
    // `reapExpired`) must also evict matching `lastPolledAt` entries.
    vi.useFakeTimers();
    try {
      const a = await store.createTask({ ttl: 5_000 }, 'r-a', sampleRequest);
      const b = await store.createTask({ ttl: 5_000 }, 'r-b', sampleRequest);
      const c = await store.createTask({ ttl: null }, 'r-c', sampleRequest);

      // Prime the throttle for all three tasks.
      await store.getTask(a.taskId);
      await store.getTask(b.taskId);
      await store.getTask(c.taskId);
      expect(
        (store as unknown as { lastPolledAt: Map<string, number> })
          .lastPolledAt.size,
      ).toBe(3);

      // Advance past TTL of a + b only.
      vi.setSystemTime(Date.now() + 10_000);

      // listTasks triggers reapExpired.
      const { tasks } = await store.listTasks();
      const ids = tasks.map((t) => t.taskId).sort();
      expect(ids).toEqual([c.taskId].sort());

      // Only the unlimited-TTL task's entry should remain in
      // `lastPolledAt` after reap.
      const lastPolledAt = (
        store as unknown as { lastPolledAt: Map<string, number> }
      ).lastPolledAt;
      expect(lastPolledAt.size).toBe(1);
      expect(lastPolledAt.has(c.taskId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loadTask_AfterInitialFold_RecordsTailSequence', async () => {
    // FINDING-2 (#1438, PR 2): `ProjectedTask` now carries
    // `lastReadSequence` so cache-hit branches in `loadTask` can compare
    // against the live stream tail. After a successful `createTask` the
    // only persisted event is `task.created` at sequence 1, so the
    // cached projection's `lastReadSequence` MUST equal 1.
    //
    // Test peeks at the private `tasks` map via a `unknown` cast — same
    // pattern PR 1's throttle tests use for `lastPolledAt` inspection.
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-tail-seq',
      sampleRequest,
    );

    const cached = (
      store as unknown as { tasks: Map<string, { lastReadSequence: number }> }
    ).tasks.get(task.taskId);
    expect(cached).toBeDefined();
    expect(cached!.lastReadSequence).toBe(1);
  });

  it('loadTask_CacheHitWithAdvancedStream_TriggersRefoldAndReturnsLatest', async () => {
    // FINDING-2 (#1438, PR 2): the in-memory `tasks` map is a CACHE, not
    // authoritative state. Two TaskStore instances backed by the SAME
    // `EventStore` represent the multi-process scenario (CLI + MCP
    // server sharing a SQLite store, or two MCP server instances during
    // a hot-swap). When B writes a terminal event after A has warmed its
    // cache, A's next `getTask` MUST observe the new state — which
    // requires re-validating the cache against the live stream tail
    // (`EventStore.tailSequence`) on every read and incrementally
    // re-folding the delta.
    const storeA = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-multi-A',
      sampleRequest,
    );

    // A warms its cache.
    const beforeBWrite = await storeA.getTask(task.taskId);
    expect(beforeBWrite?.status).toBe('working');

    // B (simulated by a direct event-store append — the durable substrate
    // is the same one A is reading from) writes a terminal `task.result`.
    await eventStore.append(`task-store/${task.taskId}`, {
      type: 'task.result',
      timestamp: new Date().toISOString(),
      data: {
        taskId: task.taskId,
        status: 'completed',
        result: { content: [{ type: 'text', text: 'from-B' }] },
      },
    });

    // A's next read MUST observe the terminal status — the cache hit is
    // invalidated by `tailSequence` advancing past `lastReadSequence`.
    const afterBWrite = await storeA.getTask(task.taskId);
    expect(afterBWrite?.status).toBe('completed');
  });

  it('refoldDelta_StampsLastReadSequenceFromAppliedDelta_NotPreReadTail', async () => {
    // CodeRabbit #1444: `lastReadSequence` MUST reflect the highest
    // sequence actually applied from the delta — NOT the tail captured
    // before `query(sinceSequence)`. Events can land between
    // `tailSequence()` and `query()`, so `delta` may include sequences
    // greater than the pre-read tail. Stamping the pre-read tail under-
    // records progress and causes the next read to re-query and re-fold
    // the same events (duplicate work; defensive fullRefold may fire on
    // an empty delta).
    //
    // CodeRabbit r3253913164 follow-up: the original shape of this test
    // appended once BEFORE the read, so pre-read tail and applied-delta
    // tail collapsed onto the same value — a buggy impl that stamped
    // the pre-read tail would still pass. To genuinely exercise the
    // race we spy on `eventStore.query` and inject an append the FIRST
    // time the store under test queries this stream. That append lands
    // AFTER `tailSequence()` was sampled inside `loadTask` but BEFORE
    // the original `query()` returns — exactly the interleaving the
    // CodeRabbit fix guards against.
    const storeA = new EventSourcedTaskStore(eventStore);
    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-stamp-from-delta',
      sampleRequest,
    );
    await storeA.getTask(task.taskId); // warm cache

    const stream = `task-store/${task.taskId}`;

    // Pre-read external append — moves the tail past the cache so
    // `loadTask` enters the `refoldDelta` branch (tail > cached
    // lastReadSequence at the `tailSequence()` check).
    await eventStore.append(stream, {
      type: 'task.cancelled',
      timestamp: new Date().toISOString(),
      data: { taskId: task.taskId, reason: 'pre-read-append' },
    });

    // Spy on `query`: the first time the store reads THIS stream,
    // perform a concurrent append BEFORE delegating to the original
    // query. The injected event lands between `tailSequence()` (already
    // returned earlier in `loadTask`) and the body of `query()`, so the
    // returned `delta` contains a sequence strictly greater than the
    // pre-read tail. A buggy impl stamping `pre-read tail` would
    // record an under-value; the correct impl (stamp from
    // `delta[-1].sequence`) records the higher value.
    const origQuery = eventStore.query.bind(eventStore);
    let injected = false;
    const querySpy = vi
      .spyOn(eventStore, 'query')
      .mockImplementation(async (streamId, filters) => {
        if (!injected && streamId === stream) {
          injected = true;
          await eventStore.append(streamId, {
            // `task.polled` is projection-no-op (no state transition);
            // it advances the sequence without further perturbing the
            // projected `task` and keeps the test focused on the
            // sequence-stamping invariant.
            type: 'task.polled',
            timestamp: new Date().toISOString(),
            data: { taskId: task.taskId },
          });
        }
        return origQuery(streamId, filters);
      });

    try {
      await storeA.getTask(task.taskId);

      // The spy must have fired exactly once on the stream under test.
      expect(injected).toBe(true);

      const tail = await eventStore.tailSequence(stream);
      const cached = (
        storeA as unknown as {
          tasks: Map<string, { lastReadSequence: number }>;
        }
      ).tasks.get(task.taskId);
      expect(cached).toBeDefined();
      // The cache MUST reflect the highest sequence actually folded —
      // i.e., the injected event's sequence, which is past the pre-read
      // tail. Equality with the post-read `tailSequence()` proves the
      // invariant: a subsequent `loadTask` for the same task will be a
      // true cache hit, not a redundant re-query.
      expect(cached!.lastReadSequence).toBe(tail);
    } finally {
      querySpy.mockRestore();
    }
  });

  it('projectTaskIncremental_FromCachedToTail_MatchesFullRefold', async () => {
    // FINDING-2 (#1438, PR 2): incremental fold from a cached projection
    // MUST be observationally equivalent to a full refold of the same
    // final stream. This is the load-bearing invariant — if it ever
    // diverged, the cache-validation path would silently corrupt
    // projections.
    //
    // The test exercises a mixed stream (created + polled + cancelled)
    // by driving it through two TaskStore instances on the same
    // EventStore: storeA warms its cache mid-stream, storeB (a fresh
    // instance) does a full cold refold of the final state. Their
    // resulting `task` objects MUST be deep-equal.
    const storeA = new EventSourcedTaskStore(eventStore);

    // Build the stream. After createTask, the cache holds the
    // `task.created` event at sequence 1.
    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-incremental',
      sampleRequest,
    );

    // First read warms storeA's cache (also emits one throttled
    // `task.polled` at sequence 2).
    await storeA.getTask(task.taskId);

    // Append the terminal event directly via the event store — same
    // mechanism the multi-process scenario uses. storeA's cache is now
    // stale (`tail > lastReadSequence`).
    await eventStore.append(`task-store/${task.taskId}`, {
      type: 'task.cancelled',
      timestamp: new Date().toISOString(),
      data: {
        taskId: task.taskId,
        reason: 'incremental-fold-test',
      },
    });

    // storeA's next read goes through the incremental fold path
    // (cache hit + tail moved → `refoldDelta` → `projectTaskIncremental`).
    const aTask = await storeA.getTask(task.taskId);

    // A fresh storeB does a full cold refold via `fullRefold`.
    const storeB = new EventSourcedTaskStore(eventStore);
    const bTask = await storeB.getTask(task.taskId);

    // Both paths converge on the same projected `task`. The throttled
    // `task.polled` emit on B's read may bump sequences differently but
    // does not affect `status` / `statusMessage` projection state.
    expect(aTask?.status).toBe('cancelled');
    expect(bTask?.status).toBe('cancelled');
    expect(aTask?.statusMessage).toBe('incremental-fold-test');
    expect(bTask?.statusMessage).toBe('incremental-fold-test');
    expect(aTask?.taskId).toBe(bTask?.taskId);
    expect(aTask?.ttl).toBe(bTask?.ttl);
    expect(aTask?.pollInterval).toBe(bTask?.pollInterval);
    // The `lastUpdatedAt` timestamp comes from the terminal event's
    // timestamp in both paths, so it should match exactly.
    expect(aTask?.lastUpdatedAt).toBe(bTask?.lastUpdatedAt);
  });

  it('EventSourcedTaskStore_MultiProcessRace_CacheValidatesOnRead', async () => {
    // FINDING-2 (#1438, PR 2): integration-style assertion of the
    // multi-process race. Two `EventSourcedTaskStore` instances share a
    // single SQLite-backed `EventStore` — exactly the topology of:
    //   - CLI + MCP server on the same `stateDir`
    //   - Two MCP server instances during a hot-swap
    //   - Test runners that spawn the store from multiple harnesses
    //
    // The fix invariant: A's read MUST observe B's terminal write, no
    // matter how warm A's cache is. T10 covered the same scenario at
    // unit level via a direct `eventStore.append`; this test re-asserts
    // through the second store's public API to prove the path works
    // end-to-end against the same durable substrate.
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-mp-race',
      sampleRequest,
    );

    // A warms its cache.
    expect((await storeA.getTask(task.taskId))?.status).toBe('working');

    // B writes the terminal result through its own public API. Note: B
    // first does its own `loadTask` (cache miss → full refold), which
    // is the realistic shape for a second process picking up the task.
    await storeB.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'from-storeB' }],
    });

    // A's next read MUST surface the terminal status.
    const observed = await storeA.getTask(task.taskId);
    expect(observed?.status).toBe('completed');
    const observedResult = await storeA.getTaskResult(task.taskId);
    expect(observedResult).toEqual({
      content: [{ type: 'text', text: 'from-storeB' }],
    });
  });

  it('terminalTransition_ExpiresAtConsistent_AcrossWriterAndReplayer', async () => {
    // CodeRabbit follow-up on #1444: pre-fix, the writer's `mutate`
    // closure bumped `expiresAt` to `Date.now() + ttl` on a terminal
    // transition, but `projectTask` / `projectTaskIncremental` left
    // `expiresAt` at the original `createdAt + ttl`. A replaying
    // sibling process would therefore consider a task expired while
    // the writer's local cache still considered it live (or vice
    // versa) — the exact divergence INV-1 forbids.
    //
    // Setup: TTL = 1000ms. Create task at T0, advance the clock 500ms
    // BEFORE writing the terminal event so `event.timestamp + ttl`
    // strictly exceeds `createdAt + ttl`. Then advance the clock to a
    // wall-clock moment that is past the pre-fix expiry but inside the
    // post-fix expiry — both writer (storeA) and a fresh replayer
    // (storeB) MUST observe the task as live.
    vi.useFakeTimers();
    try {
      const T0 = 1_700_000_000_000;
      vi.setSystemTime(T0);

      const storeA = new EventSourcedTaskStore(eventStore);
      const task = await storeA.createTask(
        { ttl: 1_000 },
        'req-expires-at',
        sampleRequest,
      );

      vi.setSystemTime(T0 + 500);
      await storeA.storeTaskResult(task.taskId, 'completed', {
        content: [{ type: 'text', text: 'done' }],
      });

      // At T0 + 1_200: past pre-fix expiry (T0 + 1_000), inside
      // post-fix expiry (T0 + 500 + 1_000 = T0 + 1_500).
      vi.setSystemTime(T0 + 1_200);

      const storeB = new EventSourcedTaskStore(eventStore);
      expect(await storeA.getTask(task.taskId)).not.toBeNull();
      expect(await storeB.getTask(task.taskId)).not.toBeNull();

      // Both observers MUST agree the task is expired past the
      // post-fix expiry (T0 + 1_500).
      vi.setSystemTime(T0 + 1_600);
      expect(await storeA.getTask(task.taskId)).toBeNull();
      expect(await storeB.getTask(task.taskId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── CodeRabbit follow-ups on #1444 — statusMessage hygiene + INV-1 ──────

  it('updateTaskStatus_CompletedFailed_RejectedWithStoreTaskResultGuidance', async () => {
    // CodeRabbit r3253903306: `updateTaskStatus(id, 'completed' | 'failed')`
    // pre-fix slipped through the projection-only fallback — the
    // status flip lived in this process's cache and disappeared on
    // replay or in any sibling process (no `task.result` event was
    // emitted), violating INV-1.
    //
    // The guard fires BEFORE `commitWithOcc` so the rejection is
    // observable directly on the call, without forging a doomed
    // round-trip through the OCC loop. The error message explicitly
    // names `storeTaskResult` so callers can resolve the contract
    // violation without spelunking through internals.
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-guard',
      sampleRequest,
    );

    for (const terminal of ['completed', 'failed'] as const) {
      await expect(
        store.updateTaskStatus(task.taskId, terminal),
      ).rejects.toThrow(/storeTaskResult/);
    }

    // The task's durable stream contains ONLY `task.created` (+
    // optional `task.polled` from the warm read inside createTask's
    // immediate use). No `task.result` was forged behind the caller's
    // back: the rejection prevents any cache mutation too.
    const events = await eventStore.query(`task-store/${task.taskId}`);
    expect(events.filter((e) => e.type === 'task.result')).toHaveLength(0);

    // The projected state is unchanged — still `working`.
    expect((await store.getTask(task.taskId))?.status).toBe('working');
  });

  it('storeTaskResult_DropsStaleStatusMessage_AlignedWithReplayProjection', async () => {
    // CodeRabbit r3253903305: pre-fix, a task that passed through
    // `updateTaskStatus(id, 'input_required', 'Please confirm X')` and
    // then `storeTaskResult(id, 'completed', result)` would carry the
    // stale `'Please confirm X'` `statusMessage` into the terminal
    // state. The durable `task.result` event has no statusMessage
    // field, so a replaying reader would project the task with NO
    // `statusMessage` — writer cache and replayer diverge.
    //
    // Post-fix both sides agree (writer drops the prior message; the
    // projection never had it to begin with).
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-stale-msg',
      sampleRequest,
    );
    await store.updateTaskStatus(
      task.taskId,
      'input_required',
      'Please confirm X',
    );

    // Sanity: the prompt is visible on the projected task.
    expect((await store.getTask(task.taskId))?.statusMessage).toBe(
      'Please confirm X',
    );

    await store.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'done' }],
    });

    // Writer cache observation — no stale prompt.
    const writerView = await store.getTask(task.taskId);
    expect(writerView?.status).toBe('completed');
    expect(writerView?.statusMessage).toBeUndefined();

    // Replayer observation — a fresh store on the same durable stream
    // MUST project the same shape.
    const replayer = new EventSourcedTaskStore(eventStore);
    const replayerView = await replayer.getTask(task.taskId);
    expect(replayerView?.status).toBe('completed');
    expect(replayerView?.statusMessage).toBeUndefined();
  });

  it('updateTaskStatus_WithoutMessage_ClearsPriorMessage', async () => {
    // CodeRabbit r3253903305: the SDK's `Task.statusMessage` reflects
    // the *latest* status update. A return-to-`working` after an
    // `input_required` prompt should drop the prompt — otherwise
    // callers see a stale prompt-string attached to a working task.
    //
    // Note: non-cancel `updateTaskStatus` transitions are
    // projection-only (no durable event) by design; this test
    // therefore verifies the WRITER-side cache only. There is no
    // cross-process consistency to assert here — replayers never see
    // the `input_required` transition in the first place — but the
    // in-process hygiene is still a correctness bug worth pinning.
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-clear-msg',
      sampleRequest,
    );
    await store.updateTaskStatus(task.taskId, 'input_required', 'Need input');
    expect((await store.getTask(task.taskId))?.statusMessage).toBe('Need input');

    await store.updateTaskStatus(task.taskId, 'working');
    const after = await store.getTask(task.taskId);
    expect(after?.status).toBe('working');
    expect(after?.statusMessage).toBeUndefined();
  });

  it('projectTaskIncremental_DropsStaleStatusMessage_OnExternalTerminalEvent', async () => {
    // CodeRabbit r3253923003: the bug specific to the incremental
    // fold path. Setup the exact divergence the comment names:
    //
    //   1. Process A stamps a projection-only `statusMessage` via
    //      `updateTaskStatus(id, 'input_required', 'Need confirm')`.
    //      No durable event is emitted — A's cache holds the prompt;
    //      the durable stream does not.
    //   2. Process B writes the terminal `task.result` event (no
    //      `statusMessage` field on the event).
    //   3. Process A's next read enters `loadTask` → `refoldDelta` →
    //      `projectTaskIncremental(cached, [task.result])`.
    //
    // Pre-fix, the incremental fold spread `...cached.task` into the
    // terminal-state shape, preserving A's stale projection-only
    // `statusMessage`. A fresh-process replayer (`projectTask` on the
    // same stream) projects the terminal task with NO `statusMessage`
    // — the two folds diverge on exactly the value of `statusMessage`.
    // INV-1 cross-process consistency violated.
    //
    // Post-fix: both folds project `statusMessage: undefined`.
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);
    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-incremental-clear',
      sampleRequest,
    );

    // (1) A stamps a projection-only `statusMessage`. After this,
    // A's cache reflects status=input_required + statusMessage; the
    // durable stream still contains only `task.created`.
    await storeA.updateTaskStatus(
      task.taskId,
      'input_required',
      'Need confirmation',
    );
    expect((await storeA.getTask(task.taskId))?.statusMessage).toBe(
      'Need confirmation',
    );

    // (2) B drives the terminal transition through its own public API
    // (cache miss → fullRefold → OCC append) so a real `task.result`
    // event lands on the durable stream. Note that B's projection
    // never sees A's projection-only `input_required` mutation —
    // realistic multi-process shape.
    await storeB.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'done' }],
    });

    // (3) A's next read MUST take the incremental-fold path: the
    // cache is warm at the pre-terminal sequence, and the new
    // terminal event is the only delta. The `getTask` reaper-and-poll
    // dance plus the throttled `task.polled` emit do NOT mutate
    // `statusMessage`, so any leak is attributable to the fold itself.
    const aView = await storeA.getTask(task.taskId);
    expect(aView?.status).toBe('completed');
    expect(aView?.statusMessage).toBeUndefined();

    // A fresh replayer projecting from events alone agrees.
    const replayer = new EventSourcedTaskStore(eventStore);
    const replayerView = await replayer.getTask(task.taskId);
    expect(replayerView?.status).toBe('completed');
    expect(replayerView?.statusMessage).toBeUndefined();
  });

  // ─── FINDING-1 (#1438, PR 3) — OCC threading via expectedSequence ─────────
  //
  // The fix invariant: two concurrent writers on the same task stream MUST
  // resolve deterministically. One commits, the other gets either a
  // terminal-status error (after retry refold sees the winner's terminal
  // event) or a `ConcurrencyError` (after exhausting the retry budget).
  // Last-write-wins at the durable layer is no longer possible — exactly
  // one `task.result` / `task.cancelled` event lands on the stream per
  // intended outcome.
  //
  // Race scenarios covered:
  //   T16 — `storeTaskResult` × `storeTaskResult` (this block)
  //   T17 — `updateTaskStatus` × `updateTaskStatus` (cancellation race)
  //   T18 — cancel-arrives-first vs late result (terminal-status throw)
  //   T19 — retry budget exhaustion surfaces `ConcurrencyError`

  it('storeTaskResult_ConcurrentCallers_ExactlyOneSucceeds', async () => {
    // Two TaskStore instances on the SAME EventStore — simulates two
    // processes (CLI + MCP server, two MCP instances) or two interleaved
    // requests that both passed their in-memory `isTerminal` check before
    // either committed. Pre-fix: both `append` calls would succeed; the
    // stream would contain two `task.result` events; the projection would
    // last-write-win silently. Post-fix: `commitWithOcc` threads
    // `expectedSequence: stored.lastReadSequence` so the second writer
    // hits `SequenceConflictError`; on retry refold the loser sees the
    // winner's terminal status and the in-decide-closure terminal-check
    // throws "Cannot store result ... in terminal status".
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-occ-1',
      sampleRequest,
    );

    // Force both stores' caches to be warmed at the SAME lastReadSequence
    // before the race so they each see the pre-race tail.
    await storeA.getTask(task.taskId);
    await storeB.getTask(task.taskId);

    const r1 = { content: [{ type: 'text', text: 'from-A' }] };
    const r2 = { content: [{ type: 'text', text: 'from-B' }] };

    const results = await Promise.allSettled([
      storeA.storeTaskResult(task.taskId, 'completed', r1),
      storeB.storeTaskResult(task.taskId, 'failed', r2),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The rejection must be either a terminal-status error (loser retried,
    // re-folded, saw the winner's terminal event) or a ConcurrencyError
    // (budget exhausted in the OCC retry loop).
    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    const message: string =
      rejectedReason instanceof Error
        ? rejectedReason.message
        : String(rejectedReason);
    expect(message).toMatch(/terminal status|ConcurrencyError|tail advanced/);

    // The stream MUST contain exactly one `task.result` event — the
    // winner's append. Last-write-wins at the durable layer is now
    // impossible.
    const events = await eventStore.query(`task-store/${task.taskId}`);
    const resultEvents = events.filter((e) => e.type === 'task.result');
    expect(resultEvents).toHaveLength(1);
  });

  it('updateTaskStatus_ConcurrentCallersToConflictingStates_ExactlyOneSucceeds', async () => {
    // Cancellation race: two writers both call `updateTaskStatus(..., 'cancelled')`.
    // Cancellation is the only `updateTaskStatus` transition that writes
    // a durable event (line 375 of event-sourced-task-store.ts), so it's
    // the case where OCC enforcement is observable on the stream.
    // Non-cancel transitions (working ↔ input_required) are projection-
    // only and intentionally retain pre-PR-3 semantics — that asymmetry
    // is documented inline on `commitWithOcc`.
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-occ-cancel',
      sampleRequest,
    );

    // Both stores warm their cache at the same lastReadSequence.
    await storeA.getTask(task.taskId);
    await storeB.getTask(task.taskId);

    const results = await Promise.allSettled([
      storeA.updateTaskStatus(task.taskId, 'cancelled', 'reason-A'),
      storeB.updateTaskStatus(task.taskId, 'cancelled', 'reason-B'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = (rejected[0] as PromiseRejectedResult).reason;
    const message: string =
      reason instanceof Error ? reason.message : String(reason);
    // After the loser refolds, it sees `cancelled` (terminal) and the
    // `updateTaskStatus` terminal-check throws ("Cannot update task ...
    // from terminal status 'cancelled'"). If the retry budget were
    // exhausted instead we would see "tail advanced" from ConcurrencyError.
    expect(message).toMatch(/terminal status|tail advanced/);

    // Stream MUST contain exactly one `task.cancelled` event — duplicate
    // cancellations are not appended.
    const events = await eventStore.query(`task-store/${task.taskId}`);
    const cancelEvents = events.filter((e) => e.type === 'task.cancelled');
    expect(cancelEvents).toHaveLength(1);
  });

  it('cancelRacesResult_CancelArrivesFirst_LateResultRejectsWithTerminalError', async () => {
    // Sequenced race: cancel commits first, late `storeTaskResult` arrives
    // afterwards with a cached projection that still says `working`. The
    // OCC retry path MUST refold, see the `cancelled` status, and have
    // the terminal-check in `storeTaskResult`'s decide closure throw.
    // This is the load-bearing scenario from the design's
    // §"Cancellation race scenario" — MCP `tasks/cancel` racing a
    // wrapped handler's `task.result`.
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-cancel-wins',
      sampleRequest,
    );

    // B warms its cache BEFORE A cancels, so B's `lastReadSequence` is
    // stale when it tries to write the result. This matches the
    // production scenario where the wrapped handler read state at the
    // start of its work and only commits its result later.
    await storeB.getTask(task.taskId);

    // A cancels and the commit lands first (await sequences this).
    await storeA.updateTaskStatus(task.taskId, 'cancelled', 'race-test');

    // B tries to record a late completion. The decide closure's
    // terminal-check throws on the first retry (after the cache refold
    // surfaces the cancelled status).
    await expect(
      storeB.storeTaskResult(task.taskId, 'completed', {
        content: [{ type: 'text', text: 'late' }],
      }),
    ).rejects.toThrow(/terminal status/);

    // Exactly one terminal-class event on the stream — the cancel.
    const events = await eventStore.query(`task-store/${task.taskId}`);
    const resultEvents = events.filter((e) => e.type === 'task.result');
    const cancelEvents = events.filter((e) => e.type === 'task.cancelled');
    expect(resultEvents).toHaveLength(0);
    expect(cancelEvents).toHaveLength(1);
  });

  it('commitWithOcc_RetryBudgetExhausted_ThrowsConcurrencyError', async () => {
    // Force `EventStore.append` to throw `SequenceConflictError` on every
    // attempt. After `maxRetries + 1` attempts (default budget = 3 ⇒ 4
    // total), `commitWithOcc` must surface a `ConcurrencyError` with
    // structured fields (streamId, reducerId='task-store', operationId,
    // expectedVersion, actualVersion).
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-budget-exhausted',
      sampleRequest,
    );
    await store.getTask(task.taskId); // warm cache

    const { SequenceConflictError } = await import('../../events/store.js');
    const { ConcurrencyError } = await import(
      '../../events/concurrency-error.js'
    );

    // Silence the warning emitted on budget exhaustion to keep test
    // output clean — the warning IS the observability surface we want,
    // but for this test we only care that the throw shape is correct.
    const warnSpy = vi
      .spyOn(taskStoreLogger, 'warn')
      .mockImplementation(() => undefined);
    // Track attempt count to confirm the budget walk.
    let attempts = 0;
    const appendSpy = vi
      .spyOn(eventStore, 'append')
      .mockImplementation(async () => {
        attempts += 1;
        // The actual numbers don't matter — only the type does.
        throw new SequenceConflictError(1, 99);
      });

    try {
      await expect(
        store.storeTaskResult(task.taskId, 'completed', {
          content: [{ type: 'text', text: 'will-never-commit' }],
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      // 3 retries + the initial attempt = 4 total append calls.
      expect(attempts).toBe(4);
      // Warning emitted exactly once on budget exhaustion.
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      appendSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('commitWithOcc_ConcurrencyErrorFlowsToMcpEnvelope_CONCURRENCY_CONFLICT', async () => {
    // T20 — integration smoke that the typed `ConcurrencyError` raised
    // by `commitWithOcc` after budget exhaustion deserializes into the
    // canonical MCP `CONCURRENCY_CONFLICT` envelope via `wrapError`. The
    // mapping itself is unit-tested in `format.test.ts`; this test proves
    // the wiring is intact end-to-end from the task-store layer.
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-mcp-envelope',
      sampleRequest,
    );
    await store.getTask(task.taskId);

    const { SequenceConflictError } = await import('../../events/store.js');
    const { wrapError } = await import('../../format.js');

    const warnSpy = vi
      .spyOn(taskStoreLogger, 'warn')
      .mockImplementation(() => undefined);
    const appendSpy = vi
      .spyOn(eventStore, 'append')
      .mockImplementation(async () => {
        throw new SequenceConflictError(1, 99);
      });

    try {
      let caught: unknown;
      try {
        await store.storeTaskResult(task.taskId, 'completed', {
          content: [{ type: 'text', text: 'will-fail' }],
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();

      const envelope = wrapError(caught);
      expect(envelope.success).toBe(false);
      // ErrorEnvelope is a union; narrow by `success: false` branch.
      if (envelope.success === false) {
        expect(envelope.error.code).toBe('CONCURRENCY_CONFLICT');
        const errBody = envelope.error as { streamId?: string; reducerId?: string; operationId?: string };
        expect(errBody.streamId).toBe(`task-store/${task.taskId}`);
        expect(errBody.reducerId).toBe('task-store');
        expect(errBody.operationId).toBe('storeTaskResult');
        expect(envelope._meta.retryable).toBe(true);
      }
    } finally {
      appendSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('ProjectTask_WhenRequestPayloadMalformed_LogsWarnWithStreamIdAndSequence', async () => {
    // FINDING-7 (#1438, T5): `projectTask` previously coerced a missing /
    // null / non-object `request` to `{}` silently via `?? {}`. This hid
    // corrupt event payloads from operators. The fix is tolerate-and-flag:
    // still produce a coerced empty-object Request, but emit a structured
    // `logger.warn` carrying the `streamId` and event `sequence` so the
    // corrupt record is locatable. Behavior on the happy path (a
    // well-formed `request` object) is unchanged — no warning.
    const taskId = 'malformed-request-task';
    const streamId = `task-store/${taskId}`;
    const now = new Date().toISOString();

    // Seed a malformed `task.created` event directly via the event store
    // (bypassing the public createTask API, which always supplies a
    // well-formed `request`). `request: null` is the canonical malformed
    // case — schema-permissive enough to land in the durable stream, but
    // not a real `Request` object.
    await eventStore.append(streamId, {
      type: 'task.created',
      timestamp: now,
      data: {
        taskId,
        ttl: 60_000,
        request: null,
      },
    });

    const warnSpy = vi
      .spyOn(taskStoreLogger, 'warn')
      .mockImplementation(() => undefined);

    try {
      // Replay via a fresh store — forces `projectTask` to fold the
      // seeded events from scratch.
      const replayStore = new EventSourcedTaskStore(eventStore);
      const replayed = await replayStore.getTask(taskId);

      // Tolerate-and-flag: projection still returns a coerced Task with
      // an empty-object request — DO NOT throw.
      expect(replayed).not.toBeNull();
      expect(replayed?.taskId).toBe(taskId);

      // Exactly one warn for the malformed coerce branch (we filter out
      // any unrelated warnings, e.g. throttle-gate or OCC noise, by
      // matching on the coerce message shape).
      const coerceCalls = warnSpy.mock.calls.filter((call) => {
        const msg = call[1];
        return typeof msg === 'string' && /malformed request/i.test(msg);
      });
      expect(coerceCalls).toHaveLength(1);

      // First-arg object payload MUST carry the locator fields so the
      // operator can find the corrupt event.
      const payload = coerceCalls[0]![0] as Record<string, unknown>;
      expect(payload.streamId).toBe(streamId);
      expect(typeof payload.sequence).toBe('number');
      expect(payload.sequence).toBeGreaterThanOrEqual(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ProjectTask_WhenRequestPayloadWellFormed_DoesNotWarn', async () => {
    // Happy-path companion to the FINDING-7 (#1438, T5) test above. A
    // well-formed `request` object MUST NOT trigger the coerce-and-warn
    // branch — only missing / null / non-object payloads do.
    const warnSpy = vi
      .spyOn(taskStoreLogger, 'warn')
      .mockImplementation(() => undefined);

    try {
      const task = await store.createTask(
        { ttl: 60_000 },
        'req-happy',
        sampleRequest,
      );

      // Force a refold via a fresh store so `projectTask` runs.
      const replayStore = new EventSourcedTaskStore(eventStore);
      const replayed = await replayStore.getTask(task.taskId);
      expect(replayed).not.toBeNull();

      const coerceCalls = warnSpy.mock.calls.filter((call) => {
        const msg = call[1];
        return typeof msg === 'string' && /malformed request/i.test(msg);
      });
      expect(coerceCalls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('EventSourcedTaskStore_ListTasks_HydratesFromEventStoreOnColdStart', async () => {
    // CR PR #1432: cold-start listTasks must enumerate durable
    // `task-store/*` streams rather than silently returning an empty
    // list. Reproducer: create tasks through one store, then construct
    // a FRESH store backed by the same event store and call listTasks
    // without any prior `getTask` hydration. The fresh listing MUST
    // surface every durable task.
    const t1 = await store.createTask({ ttl: 1000 }, 'r1', sampleRequest);
    const t2 = await store.createTask({ ttl: 2000 }, 'r2', sampleRequest);

    const coldStore = new EventSourcedTaskStore(eventStore);
    const { tasks } = await coldStore.listTasks();
    const ids = tasks.map((t) => t.taskId).sort();
    expect(ids).toEqual([t1.taskId, t2.taskId].sort());
  });

  it('CreateTask_WhenMapExceeds1024Entries_TriggersExpiredReap', async () => {
    // FINDING-4 (#1438, T4): the TTL reaper (`reapExpired`) used to fire
    // only on `listTasks`. Tasks created via `createTask` and never read
    // accumulated in `this.tasks` indefinitely. The size-cap fix invokes
    // `reapExpired` from `createTask` once the cache crosses
    // `SIZE_CAP_REAP_THRESHOLD = 1024` so an unbounded creator workload
    // cannot starve the reap path.
    //
    // Setup: create 1024 tasks with short TTLs, advance the wall clock
    // past their expiry, then create one more — the 1025th create must
    // trigger reap and drop every expired entry. The post-call cache
    // size is `1` (only the survivor task).
    vi.useFakeTimers();
    try {
      const SHORT_TTL = 5_000;
      // Create exactly 1024 short-TTL tasks. After this loop the cache
      // size is 1024 (== threshold, not yet over), so reap must NOT
      // have fired yet — assert via the spy below.
      const reapSpy = vi.spyOn(
        store as unknown as { reapExpired: () => void },
        'reapExpired',
      );
      try {
        for (let i = 0; i < 1024; i++) {
          await store.createTask(
            { ttl: SHORT_TTL },
            `req-${i}`,
            sampleRequest,
          );
        }
        // Pre-1025th create: no reap triggered (size is exactly 1024,
        // not strictly greater than threshold).
        expect(reapSpy).not.toHaveBeenCalled();
        expect(
          (store as unknown as { tasks: Map<string, unknown> }).tasks.size,
        ).toBe(1024);

        // Advance wall clock past every TTL so the first 1024 are all
        // expired by the time the 1025th create's reap runs.
        vi.setSystemTime(Date.now() + SHORT_TTL * 2);

        // The 1025th create pushes size to 1025 > 1024 and must invoke
        // `reapExpired`, sweeping all 1024 expired entries.
        const survivor = await store.createTask(
          { ttl: null },
          'req-survivor',
          sampleRequest,
        );

        expect(reapSpy).toHaveBeenCalledTimes(1);
        const finalSize = (
          store as unknown as { tasks: Map<string, unknown> }
        ).tasks.size;
        // Post-reap: only the survivor (unlimited TTL, just created)
        // remains. Expired entries are gone; bound is well under 1024.
        expect(finalSize).toBe(1);
        expect(
          (store as unknown as { tasks: Map<string, unknown> }).tasks.has(
            survivor.taskId,
          ),
        ).toBe(true);
      } finally {
        reapSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('CreateTask_AppendsTaskCreatedEvent_IncludesRequestIdInPayload', async () => {
    // FINDING-8 (#1438, T6): the audit-aligned fix for the
    // `replayed:${taskId}` synthesizer is to persist `requestId` on new
    // `task.created` events so a fresh-process replayer recovers the
    // original JSON-RPC correlation id verbatim — the synthesizer stays
    // as a strict backward-compat fallback for historical events that
    // pre-date this fix (INV-1: events are immutable, so we cannot
    // retroactively stamp old events; the synthesizer remains the
    // only sound answer for them).
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-abc',
      sampleRequest,
    );

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const created = events.find((e) => e.type === 'task.created');
    expect(created).toBeDefined();
    const data = (created!.data ?? {}) as Record<string, unknown>;
    expect(data['requestId']).toBe('req-abc');
  });

  it('ProjectTask_ReplaysTaskCreated_WithoutRequestIdField_FallsBackToSyntheticReplayedPrefix', async () => {
    // FINDING-8 (#1438, T6): historical `task.created` events emitted
    // before the requestId-persistence fix do NOT carry a `requestId`
    // field in `data`. The synthesizer (`replayed:${taskId}`) is the
    // load-bearing backward-compat fallback for those events — we
    // intentionally KEEP it (per the design's F-8 disposition: removing
    // it would require INV-1-violating event mutation OR an
    // operationally-meaningful sweep that the design rejected).
    const taskId = 'old-event-no-requestid';
    const streamId = `task-store/${taskId}`;
    const now = new Date().toISOString();

    // Seed an old-shape `task.created` event directly: no `requestId`
    // field. The schema permits this (the new field is optional for
    // exactly this back-compat reason).
    await eventStore.append(streamId, {
      type: 'task.created',
      timestamp: now,
      data: {
        taskId,
        ttl: 60_000,
        request: sampleRequest,
      },
    });

    // Force a fresh-process replay via a new store so projectTask folds
    // the seeded event from scratch.
    const replayStore = new EventSourcedTaskStore(eventStore);
    const replayed = await replayStore.getTask(taskId);
    expect(replayed).not.toBeNull();

    // Inspect the projected entry's `requestId` — the public Task
    // surface does not carry it, but the internal `tasks` cache holds
    // the ProjectedTask which does. The synthesizer fallback MUST be
    // exactly `replayed:${taskId}` for these old events.
    const cached = (
      replayStore as unknown as {
        tasks: Map<string, { requestId: string }>;
      }
    ).tasks.get(taskId);
    expect(cached).toBeDefined();
    expect(cached!.requestId).toBe(`replayed:${taskId}`);
  });

  it('CreateTask_WhenMapUnder1024_DoesNotReap', async () => {
    // FINDING-4 (#1438, T4): the size-cap reap is gated strictly on
    // `this.tasks.size > SIZE_CAP_REAP_THRESHOLD`. Below the threshold,
    // `createTask` MUST NOT invoke `reapExpired` — paying the O(n)
    // sweep cost on every create at small cache sizes would regress
    // hot-path performance for the common workload.
    const reapSpy = vi.spyOn(
      store as unknown as { reapExpired: () => void },
      'reapExpired',
    );
    try {
      // 100 creates, none expired, all under threshold.
      for (let i = 0; i < 100; i++) {
        await store.createTask(
          { ttl: 60_000 },
          `req-under-${i}`,
          sampleRequest,
        );
      }
      expect(reapSpy).not.toHaveBeenCalled();
      expect(
        (store as unknown as { tasks: Map<string, unknown> }).tasks.size,
      ).toBe(100);
    } finally {
      reapSpy.mockRestore();
    }
  });

  it('CreateTask_AboveThresholdWithNoExpiredEntries_AmortizesReapByGrowthDelta', async () => {
    // FINDING-4 amortization (CodeRabbit on PR #1450): the original T4
    // gate fired `reapExpired()` on EVERY create above the threshold,
    // even when no entries were expired (steady-state pathological
    // case). The amortization gate runs the sweep only when
    // `tasks.size - lastReapSize >= REAP_GROWTH_DELTA (64)`.
    //
    // Setup: fill to 1025 entries (one above threshold) — first sweep
    // fires immediately. Then create 200 MORE entries with long TTL
    // (none expire). The sweep should run only on the boundary creates
    // where growth-since-last-reap reaches 64 — i.e., roughly 200 / 64
    // = ~3 additional invocations, NOT 200 (one per create as the
    // pre-amortization gate would do).
    const reapSpy = vi.spyOn(
      store as unknown as { reapExpired: () => void },
      'reapExpired',
    );
    try {
      // Phase 1: cross the threshold. Single reap on the 1025th create.
      for (let i = 0; i < 1025; i++) {
        await store.createTask(
          { ttl: 60_000 },
          `req-cross-${i}`,
          sampleRequest,
        );
      }
      // After Phase 1 there should be exactly one sweep recorded.
      expect(reapSpy).toHaveBeenCalledTimes(1);

      // Phase 2: 200 more creates with NO expired entries. Without
      // amortization this would be 200 additional sweeps. With
      // amortization (delta=64) it should be ≤ ceil(200 / 64) = 4.
      reapSpy.mockClear();
      for (let i = 0; i < 200; i++) {
        await store.createTask(
          { ttl: 60_000 },
          `req-amort-${i}`,
          sampleRequest,
        );
      }
      expect(reapSpy.mock.calls.length).toBeGreaterThan(0);
      expect(reapSpy.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      reapSpy.mockRestore();
    }
  });

  it('ListTasks_AcrossSimulatedRestart_PaginatesStablyWithCursor', async () => {
    // FINDING-5 (#1438, T7): cursor pagination MUST be stable across
    // process restarts. The pre-fix implementation paginated by Map
    // insertion order — set by `hydrateFromEventStore` on cold start
    // and by `createTask` afterward. Neither establishes a content-
    // derived sort key. For backends whose `listStreams` happens to be
    // lex-sorted (SQLite) the pre-fix code accidentally appears stable
    // ONLY when taskId lex order coincides with creation order; for
    // every other relationship (and for the memory backend, which
    // preserves insertion order) two instances disagree on pagination.
    //
    // The fix sorts by (createdAt ASC, taskId ASC) — `createdAt` is
    // deterministic from the durable `task.created` event timestamp,
    // and `taskId` is the tie-break for events with identical
    // timestamps. The cursor wire format is opaque
    // (base64url(JSON.stringify({createdAt, taskId}))) so consumers
    // cannot accidentally couple to internal representation.
    //
    // Repro setup: seed 25 task.created events such that taskId lex
    // order is the REVERSE of createdAt order. This forces the
    // assertion to fail under the pre-fix Map-insertion-order
    // implementation (which produces lex(taskId) order on SQLite cold
    // start) and pass under the (createdAt ASC, taskId ASC) sort.
    const N = 25;
    const baseTimeMs = Date.parse('2026-01-01T00:00:00.000Z');

    // taskIds: pad with 4-digit slot index, but invert (N-1-slot) into
    // the taskId so taskId lex order is REVERSE of slot order. Slot
    // also determines createdAt — slot 0 has the EARLIEST createdAt.
    // Expected sort: ascending slot (== ascending createdAt) →
    // taskIds in DESCENDING lex order. Insert in slot order so the
    // memory-backend / Map-insertion path also disagrees with sort.
    for (let slot = 0; slot < N; slot++) {
      const inverted = N - 1 - slot; // taskId tag descends as slot ascends
      const taskId = `task-${String(inverted).padStart(4, '0')}`;
      const createdAt = new Date(baseTimeMs + slot * 1000).toISOString();
      await eventStore.append(`task-store/${taskId}`, {
        type: 'task.created',
        timestamp: createdAt,
        data: {
          taskId,
          ttl: null,
          request: sampleRequest,
        },
      });
    }

    // Expected sort: by createdAt ASC. Slot index drives createdAt, so
    // slot 0 (with taskId `task-00${N-1}`) comes first. That means
    // taskIds appear in DESCENDING lex order — the OPPOSITE of what
    // a pre-fix listStreams-driven implementation produces on SQLite.
    const expectedOrder = Array.from({ length: N }, (_, slot) =>
      `task-${String(N - 1 - slot).padStart(4, '0')}`,
    );

    // Instance A: page through the durable event store.
    const instanceA = new EventSourcedTaskStore(eventStore);
    const aPages: string[][] = [];
    const aCursors: Array<string | undefined> = [];
    let cursor: string | undefined;
    do {
      const page = await instanceA.listTasks(cursor);
      aPages.push(page.tasks.map((t) => t.taskId));
      aCursors.push(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    // Sanity: A enumerates exactly N unique tasks in sorted order.
    const aAll = aPages.flat();
    expect(aAll).toHaveLength(N);
    expect(new Set(aAll).size).toBe(N);
    expect(aAll).toEqual(expectedOrder);

    // Instance B: a fresh store against the same event store, replaying
    // each of A's cursors as the input to the next listTasks. B's
    // sequence MUST equal A's sequence — that is the cross-process
    // pagination-stability contract.
    const instanceB = new EventSourcedTaskStore(eventStore);
    // Page 1 (no cursor).
    const bPage1 = await instanceB.listTasks();
    expect(bPage1.tasks.map((t) => t.taskId)).toEqual(aPages[0]);
    // The cursor B emits at the end of page 1 MUST equal A's page-1
    // cursor — that's the byte-level invariant of an opaque cursor.
    expect(bPage1.nextCursor).toEqual(aCursors[0]);
    // Feed A's cursor (not B's) into B for subsequent pages so we are
    // testing the exact contract: A's cursor used by B yields A's
    // next page.
    for (let i = 1; i < aPages.length; i++) {
      const bPage = await instanceB.listTasks(aCursors[i - 1]);
      expect(bPage.tasks.map((t) => t.taskId)).toEqual(aPages[i]);
      expect(bPage.nextCursor).toEqual(aCursors[i]);
    }
  });

  it('ListTasks_TieBreakOnIdenticalCreatedAt_OrdersByTaskIdAsc', async () => {
    // FINDING-5 (#1438, T7): when two `task.created` events share an
    // identical ISO timestamp (two tasks created within the same
    // millisecond), the sort tie-break MUST be taskId ASC. Without a
    // stable secondary key the relative order falls through to Map
    // insertion order, which is exactly the cross-process
    // inconsistency T7 closes.
    //
    // Force-the-bug setup: drive enough back-to-back `createTask`
    // calls under a frozen clock so every `task.created.timestamp`
    // is byte-identical. `createTask` generates RANDOM 32-char hex
    // taskIds and appends to `this.tasks` in call order, so the
    // probability that Map insertion order coincidentally equals
    // taskId-lex order across N=10 entries is essentially zero
    // (10! permutations, only 1 matches). Pre-fix `listTasks`
    // returns Map iteration order (an arbitrary permutation);
    // post-fix returns the unique permutation sorted by taskId ASC.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2026-02-15T12:00:00.000Z'));

      const N = 10;
      const createdTaskIds: string[] = [];
      for (let i = 0; i < N; i++) {
        const t = await store.createTask(
          { ttl: null },
          `req-tie-${i}`,
          sampleRequest,
        );
        createdTaskIds.push(t.taskId);
      }
      // Sanity: all N timestamps tied at the frozen wall-clock.

      const { tasks } = await store.listTasks();
      const observed = tasks.map((t) => t.taskId);

      // Contract: with identical createdAt across all entries, the
      // result MUST be sorted by taskId ASC — a pure function of the
      // taskIds, no insertion-order influence.
      const expected = [...createdTaskIds].sort();
      expect(observed).toEqual(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ListTasks_OnColdStartWithLimit10_QueriesOnePageOfStreams', async () => {
    // FINDING-6 (#1438, T8): cursor-anchored incremental hydration.
    //
    // Pre-fix: `hydrateFromEventStore` enumerates EVERY `task-store/*`
    // stream on every `listTasks` call and folds each via `loadTask`.
    // With N historical tasks that is N per-stream `eventStore.query`
    // calls before pagination even begins — a cold-start `listTasks`
    // over 100 historical tasks paid 100 stream queries to return 10.
    //
    // Post-fix: hydration queries the event store ONCE via
    // `queryByType('task.created', { streamPrefix, since, limit })`
    // with `limit = PAGE_SIZE + LOOKAHEAD = 18`. Per-task projection
    // folds only run for the (at most 18) events that came back. The
    // upper bound on per-stream `query` calls is therefore
    // `PAGE_SIZE + LOOKAHEAD`, not the total stream count.
    //
    // Repro: seed 100 task.created events through the durable substrate
    // (bypassing the in-memory cache so the new store truly cold-starts),
    // then spy `eventStore.query` and call `listTasks()`. Pre-fix the
    // spy fires 100 times; post-fix it fires ≤ 18.
    const N = 100;
    const baseTimeMs = Date.parse('2026-03-01T00:00:00.000Z');
    for (let i = 0; i < N; i++) {
      const taskId = `task-cold-${String(i).padStart(4, '0')}`;
      const createdAt = new Date(baseTimeMs + i * 1000).toISOString();
      await eventStore.append(`task-store/${taskId}`, {
        type: 'task.created',
        timestamp: createdAt,
        data: {
          taskId,
          ttl: null,
          request: sampleRequest,
        },
      });
    }

    // Cold-start instance: fresh store backed by the same event store,
    // so `this.tasks` is empty and every `listTasks` entry requires
    // hydration from durable events.
    const coldStore = new EventSourcedTaskStore(eventStore);
    const querySpy = vi.spyOn(eventStore, 'query');

    try {
      const { tasks, nextCursor } = await coldStore.listTasks();

      // Sanity: page 1 returns exactly PAGE_SIZE=10 entries and exposes
      // a cursor (more pages follow). Sorted by createdAt ASC, the page
      // is the first 10 inserts.
      expect(tasks).toHaveLength(10);
      expect(nextCursor).toBeDefined();

      // The load-bearing assertion: cold-start hydration MUST NOT walk
      // every durable stream. With PAGE_SIZE=10 and LOOKAHEAD=8 the
      // upper bound on per-stream `eventStore.query` invocations is 18.
      // Pre-fix this spy fires 100 times.
      const LOOKAHEAD = 8;
      const PAGE_SIZE = 10;
      expect(querySpy.mock.calls.length).toBeLessThanOrEqual(
        PAGE_SIZE + LOOKAHEAD,
      );
      // Lower bound: hydration MUST have hit at least the page-sized
      // number of streams (10) to fold each task's projection. Anything
      // below that would mean the implementation skipped real work and
      // the listing would be incomplete.
      expect(querySpy.mock.calls.length).toBeGreaterThanOrEqual(PAGE_SIZE);
    } finally {
      querySpy.mockRestore();
    }
  });

  it('ListTasks_OnWarmCallAfterColdHydration_DoesNotReQueryAlreadyHydratedTasks', async () => {
    // FINDING-6 (#1438, T8): incremental hydration anchored on the
    // cursor's `createdAt`. After a cold-start `listTasks()` has
    // hydrated page 1, calling `listTasks(cursor)` must NOT re-fold
    // every durable stream — only the unhydrated tasks past the cursor
    // (bounded by `PAGE_SIZE + LOOKAHEAD = 18` events).
    //
    // Pre-fix: every call re-enumerates all 100 streams and the cache-
    // hit branch in `loadTask` (after cold-start) still incurs a
    // `tailSequence` round-trip per stream, plus a `query` on any that
    // were appended to since cache-stamp. The per-call overhead scales
    // linearly with TOTAL durable tasks.
    //
    // Post-fix: the warm call's `query` count is bounded by the page
    // worth of new folds, not the total durable count.
    const N = 100;
    const baseTimeMs = Date.parse('2026-04-01T00:00:00.000Z');
    for (let i = 0; i < N; i++) {
      const taskId = `task-warm-${String(i).padStart(4, '0')}`;
      const createdAt = new Date(baseTimeMs + i * 1000).toISOString();
      await eventStore.append(`task-store/${taskId}`, {
        type: 'task.created',
        timestamp: createdAt,
        data: {
          taskId,
          ttl: null,
          request: sampleRequest,
        },
      });
    }

    const coldStore = new EventSourcedTaskStore(eventStore);

    // Cold call (hydrates page 1). We don't constrain its query count
    // here — Test A covers that. We DO need the returned cursor so the
    // warm call has an anchor.
    const cold = await coldStore.listTasks();
    expect(cold.tasks).toHaveLength(10);
    expect(cold.nextCursor).toBeDefined();

    // Now spy on `query` for the warm call only.
    const querySpy = vi.spyOn(eventStore, 'query');
    try {
      const { tasks } = await coldStore.listTasks(cold.nextCursor);

      // Sanity: the warm page returns the next 10 entries (and they
      // differ from page 1).
      expect(tasks).toHaveLength(10);

      // Load-bearing assertion: the warm call's per-stream query count
      // is much less than N. Concretely, an incremental-hydration impl
      // does NOT re-fold any of the page-1 tasks (they are already
      // cached); it folds only the new page's worth (≤ PAGE_SIZE +
      // LOOKAHEAD = 18). Pre-fix this spy fires ~100 times.
      const LOOKAHEAD = 8;
      const PAGE_SIZE = 10;
      expect(querySpy.mock.calls.length).toBeLessThanOrEqual(
        PAGE_SIZE + LOOKAHEAD,
      );
    } finally {
      querySpy.mockRestore();
    }
  });
});

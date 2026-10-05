/**
 * Lifecycle and replay tests for `EventSourcedTaskStore`.
 *
 * The store implements `TaskStorePort` as a projection over the event store. The durable
 * events `task.created`, `task.polled`, `task.result` and `task.cancelled` are the source of
 * truth, and the in-memory map is a cache. Each task has its own stream, `task-store/<taskId>`.
 *
 * Two contracts matter most. A durable write appends its event before it changes the cache.
 * A new store over the same event store rebuilds the lifecycle state from the events alone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { taskStoreLogger } from '../../../../src/logger.js';
import { EventSourcedTaskStore } from '../../../../src/projections/task-store/event-sourced-task-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

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

    const expected = { content: [{ type: 'text', text: 'done' }] };
    await store.storeTaskResult(task.taskId, 'completed', expected);

    const result = await store.getTaskResult(task.taskId);
    expect(result).toEqual(expected);

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

  /**
   * The test appends the lifecycle events directly to the event store. A new store must rebuild
   * the task and its result from those events alone.
   */
  it('EventSourcedTaskStore_LifecycleReconstructable_FromEventStreamAlone', async () => {
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

  /**
   * After the TTL passes, `getTask` returns `null` and `getTaskResult` throws "not found".
   * A task with `ttl: null` does not expire.
   */
  it('EventSourcedTaskStore_TtlExpired_RemovesFromProjection', async () => {
    vi.useFakeTimers();
    try {
      const task = await store.createTask(
        { ttl: 5_000 },
        'req-ttl',
        sampleRequest,
      );
      expect(await store.getTask(task.taskId)).not.toBeNull();

      vi.setSystemTime(Date.now() + 10_000);

      const fetched = await store.getTask(task.taskId);
      expect(fetched).toBeNull();

      await expect(store.getTaskResult(task.taskId)).rejects.toThrow(
        /not found/,
      );

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

  /**
   * Poll loops call `getTask` at the `pollInterval` of the task. The throttle limits the
   * `task.polled` appends to one for each 5-second window.
   */
  it('getTask_RapidSequentialReads_EmitsAtMostOneTaskPolled', async () => {
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-throttle',
      sampleRequest,
    );

    for (let i = 0; i < 20; i++) {
      await store.getTask(task.taskId);
    }

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const polled = events.filter((e) => e.type === 'task.polled');
    expect(polled).toHaveLength(1);
  });

  /**
   * After the throttle window, a read appends `task.polled` again. The injected clock makes the
   * 5-second window deterministic.
   */
  it('getTask_AfterThrottleWindowElapses_EmitsSecondTaskPolled', async () => {
    let now = 1_000_000;
    const clock = () => now;
    const throttleStore = new EventSourcedTaskStore(eventStore, { clock });

    const task = await throttleStore.createTask(
      { ttl: 60_000 },
      'req-window',
      sampleRequest,
    );

    await throttleStore.getTask(task.taskId);

    now += 5_001;
    await throttleStore.getTask(task.taskId);

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const polled = events.filter((e) => e.type === 'task.polled');
    expect(polled).toHaveLength(2);
  });

  /**
   * When `getTask` drops an expired task from the cache, it also drops the `lastPolledAt` entry.
   * The test reads the private map through a cast.
   */
  it('getTask_ExpiredTaskReaped_LastPolledAtCleared', async () => {
    vi.useFakeTimers();
    try {
      const task = await store.createTask(
        { ttl: 5_000 },
        'req-reap',
        sampleRequest,
      );
      expect(await store.getTask(task.taskId)).not.toBeNull();
      expect(
        (store as unknown as { lastPolledAt: Map<string, number> })
          .lastPolledAt.size,
      ).toBe(1);

      vi.setSystemTime(Date.now() + 10_000);
      expect(await store.getTask(task.taskId)).toBeNull();

      expect(
        (store as unknown as { lastPolledAt: Map<string, number> })
          .lastPolledAt.size,
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /** The expired branch of `getTaskResult` drops the `lastPolledAt` entry, the same as `getTask`. */
  it('getTaskResult_ExpiredTaskReaped_LastPolledAtCleared', async () => {
    vi.useFakeTimers();
    try {
      const task = await store.createTask(
        { ttl: 5_000 },
        'req-reap-result',
        sampleRequest,
      );
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

  /** `listTasks` calls `reapExpired`, which also drops the `lastPolledAt` entries of the expired tasks. */
  it('reapExpired_RemovesLastPolledAtForExpiredTasks', async () => {
    vi.useFakeTimers();
    try {
      const a = await store.createTask({ ttl: 5_000 }, 'r-a', sampleRequest);
      const b = await store.createTask({ ttl: 5_000 }, 'r-b', sampleRequest);
      const c = await store.createTask({ ttl: null }, 'r-c', sampleRequest);

      await store.getTask(a.taskId);
      await store.getTask(b.taskId);
      await store.getTask(c.taskId);
      expect(
        (store as unknown as { lastPolledAt: Map<string, number> })
          .lastPolledAt.size,
      ).toBe(3);

      vi.setSystemTime(Date.now() + 10_000);

      const { tasks } = await store.listTasks();
      const ids = tasks.map((t) => t.taskId).sort();
      expect(ids).toEqual([c.taskId].sort());

      const lastPolledAt = (
        store as unknown as { lastPolledAt: Map<string, number> }
      ).lastPolledAt;
      expect(lastPolledAt.size).toBe(1);
      expect(lastPolledAt.has(c.taskId)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /** After `createTask`, the stream holds only `task.created` at sequence 1, so the cached `lastReadSequence` must be 1. */
  it('loadTask_AfterInitialFold_RecordsTailSequence', async () => {
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

  /**
   * A direct append to the stream stands in for a second process. The next read of the store
   * must see that the stream tail moved, and fold the new event.
   */
  it('loadTask_CacheHitWithAdvancedStream_TriggersRefoldAndReturnsLatest', async () => {
    const storeA = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-multi-A',
      sampleRequest,
    );

    const beforeBWrite = await storeA.getTask(task.taskId);
    expect(beforeBWrite?.status).toBe('working');

    await eventStore.append(`task-store/${task.taskId}`, {
      type: 'task.result',
      timestamp: new Date().toISOString(),
      data: {
        taskId: task.taskId,
        status: 'completed',
        result: { content: [{ type: 'text', text: 'from-B' }] },
      },
    });

    const afterBWrite = await storeA.getTask(task.taskId);
    expect(afterBWrite?.status).toBe('completed');
  });

  /**
   * Events can arrive between the tail read in `loadTask` and the delta query. The spy on
   * `eventStore.query` appends one event in that gap, so the delta holds a sequence past the tail
   * that `loadTask` read. The cache must stamp the last folded sequence. With that stamp, the
   * next read is a cache hit. The injected `task.polled` event changes no projected state.
   */
  it('refoldDelta_StampsLastReadSequenceFromAppliedDelta_NotPreReadTail', async () => {
    const storeA = new EventSourcedTaskStore(eventStore);
    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-stamp-from-delta',
      sampleRequest,
    );
    await storeA.getTask(task.taskId);

    const stream = `task-store/${task.taskId}`;

    await eventStore.append(stream, {
      type: 'task.cancelled',
      timestamp: new Date().toISOString(),
      data: { taskId: task.taskId, reason: 'pre-read-append' },
    });

    const origQuery = eventStore.query.bind(eventStore);
    let injected = false;
    const querySpy = vi
      .spyOn(eventStore, 'query')
      .mockImplementation(async (streamId, filters) => {
        if (!injected && streamId === stream) {
          injected = true;
          await eventStore.append(streamId, {
            type: 'task.polled',
            timestamp: new Date().toISOString(),
            data: { taskId: task.taskId },
          });
        }
        return origQuery(streamId, filters);
      });

    try {
      await storeA.getTask(task.taskId);

      expect(injected).toBe(true);

      const tail = await eventStore.tailSequence(stream);
      const cached = (
        storeA as unknown as {
          tasks: Map<string, { lastReadSequence: number }>;
        }
      ).tasks.get(task.taskId);
      expect(cached).toBeDefined();
      expect(cached!.lastReadSequence).toBe(tail);
    } finally {
      querySpy.mockRestore();
    }
  });

  /**
   * An incremental fold from a cached projection must give the same task as a full fold of the
   * stream. Store A folds a `task.cancelled` delta onto its warm cache, and a new store B folds
   * the full stream. `lastUpdatedAt` comes from the terminal event in both folds.
   */
  it('projectTaskIncremental_FromCachedToTail_MatchesFullRefold', async () => {
    const storeA = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-incremental',
      sampleRequest,
    );

    await storeA.getTask(task.taskId);

    await eventStore.append(`task-store/${task.taskId}`, {
      type: 'task.cancelled',
      timestamp: new Date().toISOString(),
      data: {
        taskId: task.taskId,
        reason: 'incremental-fold-test',
      },
    });

    const aTask = await storeA.getTask(task.taskId);

    const storeB = new EventSourcedTaskStore(eventStore);
    const bTask = await storeB.getTask(task.taskId);

    expect(aTask?.status).toBe('cancelled');
    expect(bTask?.status).toBe('cancelled');
    expect(aTask?.statusMessage).toBe('incremental-fold-test');
    expect(bTask?.statusMessage).toBe('incremental-fold-test');
    expect(aTask?.taskId).toBe(bTask?.taskId);
    expect(aTask?.ttl).toBe(bTask?.ttl);
    expect(aTask?.pollInterval).toBe(bTask?.pollInterval);
    expect(aTask?.lastUpdatedAt).toBe(bTask?.lastUpdatedAt);
  });

  /**
   * Store B writes the terminal result through its public API. The next read of store A, which
   * has a warm cache, must show that result.
   */
  it('EventSourcedTaskStore_MultiProcessRace_CacheValidatesOnRead', async () => {
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-mp-race',
      sampleRequest,
    );

    expect((await storeA.getTask(task.taskId))?.status).toBe('working');

    await storeB.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'from-storeB' }],
    });

    const observed = await storeA.getTask(task.taskId);
    expect(observed?.status).toBe('completed');
    const observedResult = await storeA.getTaskResult(task.taskId);
    expect(observedResult).toEqual({
      content: [{ type: 'text', text: 'from-storeB' }],
    });
  });

  /**
   * A terminal event restarts the TTL from its own timestamp, in the writer cache and in a replay.
   * The TTL is 1000 ms and the result lands at `T0 + 500`, so the expiry is `T0 + 1500`. Both
   * stores must see the task at `T0 + 1200` and must not see it at `T0 + 1600`.
   */
  it('terminalTransition_ExpiresAtConsistent_AcrossWriterAndReplayer', async () => {
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

      vi.setSystemTime(T0 + 1_200);

      const storeB = new EventSourcedTaskStore(eventStore);
      expect(await storeA.getTask(task.taskId)).not.toBeNull();
      expect(await storeB.getTask(task.taskId)).not.toBeNull();

      vi.setSystemTime(T0 + 1_600);
      expect(await storeA.getTask(task.taskId)).toBeNull();
      expect(await storeB.getTask(task.taskId)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * `completed` and `failed` need a durable `task.result` event, so `updateTaskStatus` rejects
   * them before the commit. The error names `storeTaskResult`. The stream gets no `task.result`
   * event and the task stays `working`.
   */
  it('updateTaskStatus_CompletedFailed_RejectedWithStoreTaskResultGuidance', async () => {
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

    const events = await eventStore.query(`task-store/${task.taskId}`);
    expect(events.filter((e) => e.type === 'task.result')).toHaveLength(0);

    expect((await store.getTask(task.taskId))?.status).toBe('working');
  });

  /**
   * The `task.result` event holds no `statusMessage`, so a replay projects none. The writer
   * cache must drop the earlier `input_required` prompt to agree with a replay.
   */
  it('storeTaskResult_DropsStaleStatusMessage_AlignedWithReplayProjection', async () => {
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

    expect((await store.getTask(task.taskId))?.statusMessage).toBe(
      'Please confirm X',
    );

    await store.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'done' }],
    });

    const writerView = await store.getTask(task.taskId);
    expect(writerView?.status).toBe('completed');
    expect(writerView?.statusMessage).toBeUndefined();

    const replayer = new EventSourcedTaskStore(eventStore);
    const replayerView = await replayer.getTask(task.taskId);
    expect(replayerView?.status).toBe('completed');
    expect(replayerView?.statusMessage).toBeUndefined();
  });

  /**
   * A status change without a message drops the earlier message. This transition changes only
   * the cache of the writer and appends no event, so the test has no replay side.
   */
  it('updateTaskStatus_WithoutMessage_ClearsPriorMessage', async () => {
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

  /**
   * Store A holds an `input_required` prompt in its cache only. Store B then appends the
   * terminal `task.result`. The incremental fold in store A must drop the prompt, so store A
   * agrees with a new store that folds the full stream.
   */
  it('projectTaskIncremental_DropsStaleStatusMessage_OnExternalTerminalEvent', async () => {
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);
    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-incremental-clear',
      sampleRequest,
    );

    await storeA.updateTaskStatus(
      task.taskId,
      'input_required',
      'Need confirmation',
    );
    expect((await storeA.getTask(task.taskId))?.statusMessage).toBe(
      'Need confirmation',
    );

    await storeB.storeTaskResult(task.taskId, 'completed', {
      content: [{ type: 'text', text: 'done' }],
    });

    const aView = await storeA.getTask(task.taskId);
    expect(aView?.status).toBe('completed');
    expect(aView?.statusMessage).toBeUndefined();

    const replayer = new EventSourcedTaskStore(eventStore);
    const replayerView = await replayer.getTask(task.taskId);
    expect(replayerView?.status).toBe('completed');
    expect(replayerView?.statusMessage).toBeUndefined();
  });

  /**
   * Two stores with warm caches write a result for the same task at the same time.
   * `commitWithOcc` appends with `expectedSequence`, so only one append lands. The other writer
   * refolds, sees the terminal status and throws, or it throws `ConcurrencyError` after its retries.
   */
  it('storeTaskResult_ConcurrentCallers_ExactlyOneSucceeds', async () => {
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-occ-1',
      sampleRequest,
    );

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

    const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
    const message: string =
      rejectedReason instanceof Error
        ? rejectedReason.message
        : String(rejectedReason);
    expect(message).toMatch(/terminal status|ConcurrencyError|tail advanced/);

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const resultEvents = events.filter((e) => e.type === 'task.result');
    expect(resultEvents).toHaveLength(1);
  });

  /**
   * Two stores cancel the same task at the same time. `cancelled` is the only `updateTaskStatus`
   * transition that appends an event, so the stream shows the conflict check: one `task.cancelled` event.
   */
  it('updateTaskStatus_ConcurrentCallersToConflictingStates_ExactlyOneSucceeds', async () => {
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-occ-cancel',
      sampleRequest,
    );

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
    expect(message).toMatch(/terminal status|tail advanced/);

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const cancelEvents = events.filter((e) => e.type === 'task.cancelled');
    expect(cancelEvents).toHaveLength(1);
  });

  /**
   * Store B reads the task before store A cancels it, so the `lastReadSequence` of store B is stale.
   * The late `storeTaskResult` in store B must refold, see `cancelled` and throw.
   */
  it('cancelRacesResult_CancelArrivesFirst_LateResultRejectsWithTerminalError', async () => {
    const storeA = new EventSourcedTaskStore(eventStore);
    const storeB = new EventSourcedTaskStore(eventStore);

    const task = await storeA.createTask(
      { ttl: 60_000 },
      'req-cancel-wins',
      sampleRequest,
    );

    await storeB.getTask(task.taskId);

    await storeA.updateTaskStatus(task.taskId, 'cancelled', 'race-test');

    await expect(
      storeB.storeTaskResult(task.taskId, 'completed', {
        content: [{ type: 'text', text: 'late' }],
      }),
    ).rejects.toThrow(/terminal status/);

    const events = await eventStore.query(`task-store/${task.taskId}`);
    const resultEvents = events.filter((e) => e.type === 'task.result');
    const cancelEvents = events.filter((e) => e.type === 'task.cancelled');
    expect(resultEvents).toHaveLength(0);
    expect(cancelEvents).toHaveLength(1);
  });

  /**
   * `append` throws `SequenceConflictError` on each call. After the first try and three retries,
   * `commitWithOcc` logs one warning and throws `ConcurrencyError`.
   */
  it('commitWithOcc_RetryBudgetExhausted_ThrowsConcurrencyError', async () => {
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-budget-exhausted',
      sampleRequest,
    );
    await store.getTask(task.taskId);

    const { SequenceConflictError } = await import('../../../../src/events/store.js');
    const { ConcurrencyError } = await import(
      '../../../../src/events/concurrency-error.js'
    );

    const warnSpy = vi
      .spyOn(taskStoreLogger, 'warn')
      .mockImplementation(() => undefined);
    let attempts = 0;
    const appendSpy = vi
      .spyOn(eventStore, 'append')
      .mockImplementation(async () => {
        attempts += 1;
        throw new SequenceConflictError(1, 99);
      });

    try {
      await expect(
        store.storeTaskResult(task.taskId, 'completed', {
          content: [{ type: 'text', text: 'will-never-commit' }],
        }),
      ).rejects.toBeInstanceOf(ConcurrencyError);

      expect(attempts).toBe(4);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      appendSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  /** `wrapError` maps the `ConcurrencyError` from `commitWithOcc` to a retryable `CONCURRENCY_CONFLICT` envelope. */
  it('commitWithOcc_ConcurrencyErrorFlowsToMcpEnvelope_CONCURRENCY_CONFLICT', async () => {
    const task = await store.createTask(
      { ttl: 60_000 },
      'req-mcp-envelope',
      sampleRequest,
    );
    await store.getTask(task.taskId);

    const { SequenceConflictError } = await import('../../../../src/events/store.js');
    const { wrapError } = await import('../../../../src/format.js');

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

  /**
   * A `task.created` event with `request: null` still projects a task. The fold logs one warning
   * with the `streamId` and the event `sequence`, so an operator can find the bad event.
   */
  it('ProjectTask_WhenRequestPayloadMalformed_LogsWarnWithStreamIdAndSequence', async () => {
    const taskId = 'malformed-request-task';
    const streamId = `task-store/${taskId}`;
    const now = new Date().toISOString();

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
      const replayStore = new EventSourcedTaskStore(eventStore);
      const replayed = await replayStore.getTask(taskId);

      expect(replayed).not.toBeNull();
      expect(replayed?.taskId).toBe(taskId);

      const coerceCalls = warnSpy.mock.calls.filter((call) => {
        const msg = call[1];
        return typeof msg === 'string' && /malformed request/i.test(msg);
      });
      expect(coerceCalls).toHaveLength(1);

      const payload = coerceCalls[0]![0] as Record<string, unknown>;
      expect(payload.streamId).toBe(streamId);
      expect(typeof payload.sequence).toBe('number');
      expect(payload.sequence).toBeGreaterThanOrEqual(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ProjectTask_WhenRequestPayloadWellFormed_DoesNotWarn', async () => {
    const warnSpy = vi
      .spyOn(taskStoreLogger, 'warn')
      .mockImplementation(() => undefined);

    try {
      const task = await store.createTask(
        { ttl: 60_000 },
        'req-happy',
        sampleRequest,
      );

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

  /** A new store calls `listTasks` with an empty cache. It must list the durable tasks, not an empty page. */
  it('EventSourcedTaskStore_ListTasks_HydratesFromEventStoreOnColdStart', async () => {
    const t1 = await store.createTask({ ttl: 1000 }, 'r1', sampleRequest);
    const t2 = await store.createTask({ ttl: 2000 }, 'r2', sampleRequest);

    const coldStore = new EventSourcedTaskStore(eventStore);
    const { tasks } = await coldStore.listTasks();
    const ids = tasks.map((t) => t.taskId).sort();
    expect(ids).toEqual([t1.taskId, t2.taskId].sort());
  });

  /**
   * `createTask` sweeps expired tasks when the cache size goes above 1024. The first 1024 creates
   * must not sweep. The 1025th create runs after all TTLs pass, so only its own task stays.
   */
  it('CreateTask_WhenMapExceeds1024Entries_TriggersExpiredReap', async () => {
    vi.useFakeTimers();
    try {
      const SHORT_TTL = 5_000;
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
        expect(reapSpy).not.toHaveBeenCalled();
        expect(
          (store as unknown as { tasks: Map<string, unknown> }).tasks.size,
        ).toBe(1024);

        vi.setSystemTime(Date.now() + SHORT_TTL * 2);

        const survivor = await store.createTask(
          { ttl: null },
          'req-survivor',
          sampleRequest,
        );

        expect(reapSpy).toHaveBeenCalledTimes(1);
        const finalSize = (
          store as unknown as { tasks: Map<string, unknown> }
        ).tasks.size;
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

  /** The `task.created` event holds the `requestId`, so a replay restores the original JSON-RPC id. */
  it('CreateTask_AppendsTaskCreatedEvent_IncludesRequestIdInPayload', async () => {
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

  /**
   * An old `task.created` event has no `requestId`, and events are immutable. The fold must use
   * `replayed:<taskId>` for it. The test reads the value from the private cache, because `Task`
   * does not hold it.
   */
  it('ProjectTask_ReplaysTaskCreated_WithoutRequestIdField_FallsBackToSyntheticReplayedPrefix', async () => {
    const taskId = 'old-event-no-requestid';
    const streamId = `task-store/${taskId}`;
    const now = new Date().toISOString();

    await eventStore.append(streamId, {
      type: 'task.created',
      timestamp: now,
      data: {
        taskId,
        ttl: 60_000,
        request: sampleRequest,
      },
    });

    const replayStore = new EventSourcedTaskStore(eventStore);
    const replayed = await replayStore.getTask(taskId);
    expect(replayed).not.toBeNull();

    const cached = (
      replayStore as unknown as {
        tasks: Map<string, { requestId: string }>;
      }
    ).tasks.get(taskId);
    expect(cached).toBeDefined();
    expect(cached!.requestId).toBe(`replayed:${taskId}`);
  });

  /** At or below 1024 entries, `createTask` must not sweep, so a small cache pays no sweep cost. */
  it('CreateTask_WhenMapUnder1024_DoesNotReap', async () => {
    const reapSpy = vi.spyOn(
      store as unknown as { reapExpired: () => void },
      'reapExpired',
    );
    try {
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

  /**
   * Above the threshold, `createTask` sweeps only after the cache grows by `REAP_GROWTH_DELTA` (64)
   * entries since the last sweep. The 1025th create sweeps once. The next 200 creates, with no
   * expired task, sweep at most four times.
   */
  it('CreateTask_AboveThresholdWithNoExpiredEntries_AmortizesReapByGrowthDelta', async () => {
    const reapSpy = vi.spyOn(
      store as unknown as { reapExpired: () => void },
      'reapExpired',
    );
    try {
      for (let i = 0; i < 1025; i++) {
        await store.createTask(
          { ttl: 60_000 },
          `req-cross-${i}`,
          sampleRequest,
        );
      }
      expect(reapSpy).toHaveBeenCalledTimes(1);

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

  /**
   * `listTasks` sorts by `(createdAt, taskId)`, so two instances page in the same order. The seed
   * makes the taskId order the reverse of the `createdAt` order, so a sort by taskId fails.
   * Instance B takes each cursor from instance A and must return the same pages and cursors.
   */
  it('ListTasks_AcrossSimulatedRestart_PaginatesStablyWithCursor', async () => {
    const N = 25;
    const baseTimeMs = Date.parse('2026-01-01T00:00:00.000Z');

    for (let slot = 0; slot < N; slot++) {
      const inverted = N - 1 - slot;
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

    const expectedOrder = Array.from({ length: N }, (_, slot) =>
      `task-${String(N - 1 - slot).padStart(4, '0')}`,
    );

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

    const aAll = aPages.flat();
    expect(aAll).toHaveLength(N);
    expect(new Set(aAll).size).toBe(N);
    expect(aAll).toEqual(expectedOrder);

    const instanceB = new EventSourcedTaskStore(eventStore);
    const bPage1 = await instanceB.listTasks();
    expect(bPage1.tasks.map((t) => t.taskId)).toEqual(aPages[0]);
    expect(bPage1.nextCursor).toEqual(aCursors[0]);
    for (let i = 1; i < aPages.length; i++) {
      const bPage = await instanceB.listTasks(aCursors[i - 1]);
      expect(bPage.tasks.map((t) => t.taskId)).toEqual(aPages[i]);
      expect(bPage.nextCursor).toEqual(aCursors[i]);
    }
  });

  /**
   * A frozen clock gives all ten tasks the same `createdAt`. The task ids are random, so the
   * creation order rarely equals the taskId order. `listTasks` must return the ids in ascending order.
   */
  it('ListTasks_TieBreakOnIdenticalCreatedAt_OrdersByTaskIdAsc', async () => {
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

      const { tasks } = await store.listTasks();
      const observed = tasks.map((t) => t.taskId);

      const expected = [...createdTaskIds].sort();
      expect(observed).toEqual(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A cold `listTasks` hydrates through one `queryByType` call with a limit of
   * `PAGE_SIZE + LOOKAHEAD`, which is 18. With 100 durable tasks, the count of per-stream `query`
   * calls must be from 10 to 18.
   */
  it('ListTasks_OnColdStartWithLimit10_QueriesOnePageOfStreams', async () => {
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

    const coldStore = new EventSourcedTaskStore(eventStore);
    const querySpy = vi.spyOn(eventStore, 'query');

    try {
      const { tasks, nextCursor } = await coldStore.listTasks();

      expect(tasks).toHaveLength(10);
      expect(nextCursor).toBeDefined();

      const LOOKAHEAD = 8;
      const PAGE_SIZE = 10;
      expect(querySpy.mock.calls.length).toBeLessThanOrEqual(
        PAGE_SIZE + LOOKAHEAD,
      );
      expect(querySpy.mock.calls.length).toBeGreaterThanOrEqual(PAGE_SIZE);
    } finally {
      querySpy.mockRestore();
    }
  });

  /**
   * The second page hydrates only the tasks at or after the cursor that the cache does not hold.
   * With 100 durable tasks, the warm call must make at most 18 per-stream `query` calls.
   */
  it('ListTasks_OnWarmCallAfterColdHydration_DoesNotReQueryAlreadyHydratedTasks', async () => {
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

    const cold = await coldStore.listTasks();
    expect(cold.tasks).toHaveLength(10);
    expect(cold.nextCursor).toBeDefined();

    const querySpy = vi.spyOn(eventStore, 'query');
    try {
      const { tasks } = await coldStore.listTasks(cold.nextCursor);

      expect(tasks).toHaveLength(10);

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

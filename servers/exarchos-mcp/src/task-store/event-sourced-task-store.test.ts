/**
 * EventSourcedTaskStore — lifecycle + REPLAY (INV-1) acceptance tests (#1272).
 *
 * The store implements the SDK `TaskStore` interface
 * (`@modelcontextprotocol/sdk/experimental/tasks/interfaces`) as a
 * **projection** over the event store. The four `task.*` lifecycle
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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { EventSourcedTaskStore } from './event-sourced-task-store.js';

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
    await rm(stateDir, { recursive: true, force: true });
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

  it('EventSourcedTaskStore_PollInterval_PersistsToEventAndReplays', async () => {
    // CodeRabbit MAJOR #1431: pre-fix, `pollInterval` was stored only in
    // the in-memory projection — never on the `task.created` event — so a
    // fresh store instantiated against the same event store silently
    // reverted to the 1000ms default. This test pins both the durable
    // payload AND the REPLAY contract.
    const task = await store.createTask(
      { ttl: 60_000, pollInterval: 250 },
      'req-poll',
      sampleRequest,
    );
    expect(task.pollInterval).toBe(250);

    // Event-store evidence: the durable `task.created` payload carries
    // the caller-supplied cadence (not the SDK default).
    const events = await eventStore.query(`task-store/${task.taskId}`);
    const createdEvent = events.find((e) => e.type === 'task.created');
    expect(createdEvent?.data).toMatchObject({ pollInterval: 250 });

    // REPLAY: a fresh store reconstructs the cadence from the stream
    // alone.
    const replayStore = new EventSourcedTaskStore(eventStore);
    const replayed = await replayStore.getTask(task.taskId);
    expect(replayed?.pollInterval).toBe(250);
  });

  it('EventSourcedTaskStore_LegacyTaskCreated_NoPollInterval_DefaultsTo1000ms', async () => {
    // Back-compat: historical `task.created` events written before the
    // #1431 fix did not include `pollInterval`. The projection must
    // continue to fall back to the SDK default (1000ms) for those.
    const taskId = 'legacy-no-poll-interval';
    const streamId = `task-store/${taskId}`;
    await eventStore.append(streamId, {
      type: 'task.created',
      timestamp: new Date().toISOString(),
      data: { taskId, ttl: 60_000, request: sampleRequest },
    });
    const replayStore = new EventSourcedTaskStore(eventStore);
    const replayed = await replayStore.getTask(taskId);
    expect(replayed?.pollInterval).toBe(1000);
  });

  it('EventSourcedTaskStore_ListTasks_ReturnsCreatedTasks', async () => {
    const t1 = await store.createTask({ ttl: 1000 }, 'r1', sampleRequest);
    const t2 = await store.createTask({ ttl: 2000 }, 'r2', sampleRequest);
    const { tasks } = await store.listTasks();
    const ids = tasks.map((t) => t.taskId).sort();
    expect(ids).toEqual([t1.taskId, t2.taskId].sort());
  });
});

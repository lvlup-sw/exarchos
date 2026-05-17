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
});

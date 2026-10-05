/**
 * Contract of the `tasksGet`, `tasksResult` and `tasksCancel` primitives over the
 * event-sourced task store. They follow the contract of the MCP `tasks/get`,
 * `tasks/result` and `tasks/cancel` methods for callers outside the SDK.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { EventSourcedTaskStore } from '../../../src/projections/task-store/event-sourced-task-store.js';
import { tasksGet, tasksResult, tasksCancel } from '../../../src/mcp/tasks-methods.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('MCP tasks/* methods (#1273 / T31)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let taskStore: EventSourcedTaskStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'tasks-methods-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    taskStore = new EventSourcedTaskStore(eventStore);
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /** Pins the minimum fields of the SDK `GetTaskResult` shape for a task that the store created. */
  it('McpTasksGet_ValidTaskId_ReturnsCurrentTaskState', async () => {
    const created = await taskStore.createTask(
      { ttl: 60_000 },
      'rq-get-1',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );

    const got = await tasksGet(taskStore, created.taskId);

    expect(got.taskId).toBe(created.taskId);
    expect(got.status).toBe('working');
    expect(got.ttl).toBe(60_000);
    expect(typeof got.createdAt).toBe('string');
    expect(typeof got.lastUpdatedAt).toBe('string');
  });

  /**
   * `storeTaskResult` stands in for the background execution. `runTasksAugmented`
   * stores the `ToolResult` under `_toolResult`, so a caller can read the original
   * envelope.
   */
  it('McpTasksResult_TaskComplete_ReturnsFinalOutcome', async () => {
    const created = await taskStore.createTask(
      { ttl: 60_000 },
      'rq-result-1',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );

    await taskStore.storeTaskResult(created.taskId, 'completed', {
      _toolResult: { success: true, data: { value: 42 } },
    } as unknown as Parameters<typeof taskStore.storeTaskResult>[2]);

    const final = await tasksResult(taskStore, created.taskId);

    expect(final).toBeDefined();
    const payload = final as { _toolResult?: { success?: boolean; data?: unknown } };
    expect(payload._toolResult?.success).toBe(true);
    expect(payload._toolResult?.data).toEqual({ value: 42 });
  });

  /** The cancel must leave a durable `task.cancelled` event on the `task-store/<taskId>` stream. */
  it('McpTasksCancel_EmitsTaskCancelled', async () => {
    const created = await taskStore.createTask(
      { ttl: 60_000 },
      'rq-cancel-1',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );

    const cancelled = await tasksCancel(taskStore, created.taskId);

    expect(cancelled.taskId).toBe(created.taskId);
    expect(cancelled.status).toBe('cancelled');

    const events = await eventStore.query(`task-store/${created.taskId}`);
    const cancelEvent = events.find((e) => e.type === 'task.cancelled');
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent!.data).toMatchObject({ taskId: created.taskId });
  });

  /**
   * A task in a terminal status cannot change status. The primitive rejects with an
   * `Error`, and the caller maps it to the error shape of its facade.
   */
  it('McpTasksCancel_AlreadyCompleted_ReturnsValidationError', async () => {
    const created = await taskStore.createTask(
      { ttl: 60_000 },
      'rq-cancel-2',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    await taskStore.storeTaskResult(created.taskId, 'completed', {
      _toolResult: { success: true, data: {} },
    } as unknown as Parameters<typeof taskStore.storeTaskResult>[2]);

    await expect(tasksCancel(taskStore, created.taskId)).rejects.toThrow(/terminal/i);
  });
});

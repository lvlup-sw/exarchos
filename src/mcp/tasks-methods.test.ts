/**
 * MCP `tasks/get` / `tasks/result` / `tasks/cancel` handler acceptance
 * (#1273 / C2 T31).
 *
 * Pins the contract for the three MCP `tasks/*` methods that the
 * adapter must expose alongside `tools/call`:
 *
 *   - McpTasksGet_ValidTaskId_ReturnsCurrentTaskState — the SDK
 *     `GetTaskResult` shape (`{ taskId, status, ttl, createdAt,
 *     lastUpdatedAt, ... }`) is returned for a known task.
 *   - McpTasksResult_TaskComplete_ReturnsFinalOutcome — once the
 *     background execution has stored a result, `tasks/result` returns
 *     the SDK `Result` payload (carrying the original ToolResult under
 *     `_toolResult` as the C1 synthesis surface stamps it).
 *   - McpTasksCancel_EmitsTaskCancelled — `tasks/cancel` on a working
 *     task transitions it to `cancelled` AND emits a durable
 *     `task.cancelled` event on the namespaced stream. (Source of truth
 *     for audit: project memory §"event-sourced task store" — every
 *     terminal transition lands as an event before the projection is
 *     updated.)
 *   - McpTasksCancel_AlreadyCompleted_ReturnsValidationError — cancelling
 *     a task that has already reached a terminal state is a structured
 *     error per the SDK contract (terminal states cannot transition).
 *
 * Both the CLI `--follow` loop (C3) and the MCP adapter dispatch through
 * the same `tasksGet` / `tasksResult` / `tasksCancel` primitives so the
 * two facades stay in lockstep (INV-2 facade equivalence).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import { EventSourcedTaskStore } from '../projections/task-store/event-sourced-task-store.js';
import { tasksGet, tasksResult, tasksCancel } from './tasks-methods.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

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

  it('McpTasksGet_ValidTaskId_ReturnsCurrentTaskState', async () => {
    // Create a task via the canonical store entrypoint so the projection
    // is exactly what the dispatch-core path would produce.
    const created = await taskStore.createTask(
      { ttl: 60_000 },
      'rq-get-1',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );

    const got = await tasksGet(taskStore, created.taskId);

    // SDK GetTaskResult shape: taskId, status, ttl, createdAt,
    // lastUpdatedAt at minimum.
    expect(got.taskId).toBe(created.taskId);
    expect(got.status).toBe('working');
    expect(got.ttl).toBe(60_000);
    expect(typeof got.createdAt).toBe('string');
    expect(typeof got.lastUpdatedAt).toBe('string');
  });

  it('McpTasksResult_TaskComplete_ReturnsFinalOutcome', async () => {
    const created = await taskStore.createTask(
      { ttl: 60_000 },
      'rq-result-1',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );

    // Simulate background execution completion (the C1 synthesis path
    // would normally do this via `storeTaskResult`).
    await taskStore.storeTaskResult(created.taskId, 'completed', {
      _toolResult: { success: true, data: { value: 42 } },
    } as unknown as Parameters<typeof taskStore.storeTaskResult>[2]);

    const final = await tasksResult(taskStore, created.taskId);

    // The SDK GetTaskPayloadResult is the underlying handler's Result.
    // Our synthesis (`runTasksAugmented`) stamps the ToolResult under
    // `_toolResult` — so callers can recover the original envelope.
    expect(final).toBeDefined();
    const payload = final as { _toolResult?: { success?: boolean; data?: unknown } };
    expect(payload._toolResult?.success).toBe(true);
    expect(payload._toolResult?.data).toEqual({ value: 42 });
  });

  it('McpTasksCancel_EmitsTaskCancelled', async () => {
    const created = await taskStore.createTask(
      { ttl: 60_000 },
      'rq-cancel-1',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );

    const cancelled = await tasksCancel(taskStore, created.taskId);

    // Returned task now reflects the cancelled status.
    expect(cancelled.taskId).toBe(created.taskId);
    expect(cancelled.status).toBe('cancelled');

    // Durable audit trail: `task.cancelled` event landed on the namespaced
    // stream. The EventSourcedTaskStore.updateTaskStatus path emits this
    // when transitioning to `cancelled`.
    const events = await eventStore.query(`task-store/${created.taskId}`);
    const cancelEvent = events.find((e) => e.type === 'task.cancelled');
    expect(cancelEvent).toBeDefined();
    expect(cancelEvent!.data).toMatchObject({ taskId: created.taskId });
  });

  it('McpTasksCancel_AlreadyCompleted_ReturnsValidationError', async () => {
    const created = await taskStore.createTask(
      { ttl: 60_000 },
      'rq-cancel-2',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    // Drive the task to terminal state.
    await taskStore.storeTaskResult(created.taskId, 'completed', {
      _toolResult: { success: true, data: {} },
    } as unknown as Parameters<typeof taskStore.storeTaskResult>[2]);

    // Cancelling a terminal task must surface a structured validation
    // failure (SDK contract: terminal states are immutable). The
    // primitive throws an `Error` so the MCP adapter can map to
    // `McpError(InvalidParams, ...)` in a single place; the CLI path
    // surfaces it as a structured envelope.
    await expect(tasksCancel(taskStore, created.taskId)).rejects.toThrow(/terminal/i);
  });
});

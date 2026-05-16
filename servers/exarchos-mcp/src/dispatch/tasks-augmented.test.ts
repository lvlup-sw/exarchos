/**
 * Tasks-augmented dispatch branch — unit-level acceptance (#1273, T28).
 *
 * Wave C / PR 1: dispatch-core only. The MCP adapter (C2) and the CLI
 * `--follow` loop (C3) consume the same synthesis surface this test pins.
 *
 * Three load-bearing checks:
 *
 *   1. DispatchCore_NoTaskOption_ReturnsEnvelope — when the caller did NOT
 *      thread `task: { ttl }` into the args, dispatch resolves with the
 *      legacy one-shot envelope shape (`{ success, data, ... }`). This is
 *      the regression guard: the new code path MUST NOT leak the
 *      Tasks-augmented shape into one-shot callers.
 *   2. DispatchCore_TaskOptionPresent_ReturnsCreateTaskResult — when the
 *      caller threads `task: { ttl }`, dispatch synthesizes the SDK
 *      `CreateTaskResult` shape (`{ task: { taskId, status, ttl, ... } }`).
 *   3. DispatchCore_TaskAugmented_EmitsTaskCreated — the synthesis path
 *      appends `task.created` to the `task-store/<id>` stream via the
 *      `EventSourcedTaskStore` (the same store that owns the canonical
 *      lifecycle event from B3 / #1272). Verified by reading the stream
 *      and asserting `task.created` is present.
 *
 * Status note: the SDK's `CreateTaskResult.task.status` enum is
 * `working|input_required|completed|failed|cancelled` — there is no
 * `submitted` value. The task description's `status: 'submitted'`
 * reference predates the final SDK spec; we follow the SDK (per project
 * memory: "if shape differs from your synthesis, follow the SDK") and
 * initialise the task as `working`, matching the
 * EventSourcedTaskStore.createTask contract.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { EventSourcedTaskStore } from '../task-store/event-sourced-task-store.js';
import {
  isTaskAugmented,
  runTasksAugmented,
} from './tasks-augmented.js';

describe('tasks-augmented dispatch branch (#1273 / T28)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let taskStore: EventSourcedTaskStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'tasks-aug-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    taskStore = new EventSourcedTaskStore(eventStore);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  // ─── Branch detection ────────────────────────────────────────────────────

  it('IsTaskAugmented_NoTaskOption_ReturnsFalse', () => {
    expect(isTaskAugmented({ action: 'describe' })).toBe(false);
    expect(isTaskAugmented({ action: 'describe', task: undefined })).toBe(false);
  });

  it('IsTaskAugmented_TaskOptionPresent_ReturnsTrue', () => {
    expect(isTaskAugmented({ action: 'describe', task: {} })).toBe(true);
    expect(isTaskAugmented({ action: 'describe', task: { ttl: 60_000 } })).toBe(true);
    // ttl is optional under SDK TaskAugmentedRequestParams; presence of `task`
    // is the augmentation signal, not presence of `ttl`.
    expect(isTaskAugmented({ action: 'describe', task: { ttl: null } })).toBe(true);
  });

  it('IsTaskAugmented_TaskValueNotObject_ReturnsFalse', () => {
    // Type-defensive: stray `task: 'string'` or `task: 42` MUST NOT be
    // mistaken for an augmentation request. The MCP layer's Zod parse
    // would already reject this, but dispatch-core sees raw args and
    // must remain robust to non-conforming callers.
    expect(isTaskAugmented({ action: 'describe', task: 'oops' })).toBe(false);
    expect(isTaskAugmented({ action: 'describe', task: 42 })).toBe(false);
    expect(isTaskAugmented({ action: 'describe', task: null })).toBe(false);
    // Arrays are `typeof 'object'` in JS — the guard MUST reject them
    // explicitly so an accidental `task: []` from a malformed caller does
    // not slip through as a valid augmentation payload.
    expect(isTaskAugmented({ action: 'describe', task: [] })).toBe(false);
    expect(isTaskAugmented({ action: 'describe', task: [{ ttl: 1 }] })).toBe(false);
  });

  // ─── Synthesis surface (returns SDK CreateTaskResult shape) ──────────────

  it('DispatchCore_TaskOptionPresent_ReturnsCreateTaskResult', async () => {
    // `runTasksAugmented` wraps a hypothetical underlying handler. The
    // handler runs in the background; the synthesis returns immediately
    // with a CreateTaskResult-shaped envelope.
    const result = await runTasksAugmented({
      taskStore,
      taskOptions: { ttl: 60_000 },
      requestId: 'rq-1',
      request: { method: 'tools/call', params: { name: 'noop', arguments: {} } },
      execute: async () => ({ success: true as const, data: { value: 1 } }),
    });

    // The SDK shape: `{ task: { taskId, status, ttl, createdAt, lastUpdatedAt } }`.
    // Dispatch-core wraps the result in a ToolResult-compatible envelope so the
    // outer dispatch surface keeps a single return type.
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const data = result.data as { task: { taskId: string; status: string; ttl: number | null } };
    expect(data.task).toBeDefined();
    expect(typeof data.task.taskId).toBe('string');
    expect(data.task.taskId.length).toBeGreaterThan(0);
    expect(data.task.status).toBe('working');
    expect(data.task.ttl).toBe(60_000);
  });

  it('DispatchCore_TaskAugmented_EmitsTaskCreated', async () => {
    const result = await runTasksAugmented({
      taskStore,
      taskOptions: { ttl: 30_000 },
      requestId: 'rq-2',
      request: { method: 'tools/call', params: { name: 'noop', arguments: {} } },
      execute: async () => ({ success: true as const, data: { value: 2 } }),
    });

    const taskId = (result.data as { task: { taskId: string } }).task.taskId;
    const events = await eventStore.query(`task-store/${taskId}`);
    const created = events.find((e) => e.type === 'task.created');
    expect(created).toBeDefined();
    expect(created!.data).toMatchObject({ taskId, ttl: 30_000 });
  });

  // The one-shot path is not exercised here directly — the dispatch.test.ts
  // smoke `Dispatch_KnownTool_CallsHandler` already pins the legacy shape.
  // The cross-cutting assertion (one-shot envelope unchanged when `task` is
  // absent) lives in dispatch.test.ts so the unit there can use the real
  // dispatch entrypoint instead of the synthesis primitive.
});

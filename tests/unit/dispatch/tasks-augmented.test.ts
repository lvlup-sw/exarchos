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
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { EventSourcedTaskStore } from '../../../src/projections/task-store/event-sourced-task-store.js';
import {
  isTaskAugmented,
  runTasksAugmented,
  extractTaskOptions,
} from '../../../src/dispatch/tasks-augmented.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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
    await rmrfAsync(stateDir);
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

  // ─── CodeRabbit MAJOR #1431 follow-up: pollInterval validity contract ────
  //
  // The durable `TaskCreatedData.pollInterval` schema enforces
  // `.int().positive().optional()` — `0`, negatives, NaN/Infinity, and
  // fractional floats are rejected at append. The dispatch boundary
  // (`extractTaskOptions`) MUST therefore reject those values too so a
  // malformed caller can't slip past extraction and silently fail
  // event-append validation downstream.

  describe('extractTaskOptions / pollInterval validity contract', () => {
    it('ExtractTaskOptions_PositivePollInterval_PreservesValue', () => {
      expect(extractTaskOptions({ pollInterval: 250 }).pollInterval).toBe(250);
    });

    it('ExtractTaskOptions_ZeroPollInterval_DroppedForSchemaAlignment', () => {
      // CodeRabbit MAJOR: `0` is degenerate (tight loop). Drop here so
      // createTask default (1000) applies.
      expect(extractTaskOptions({ pollInterval: 0 }).pollInterval).toBeUndefined();
    });

    it('ExtractTaskOptions_NegativePollInterval_Dropped', () => {
      expect(extractTaskOptions({ pollInterval: -100 }).pollInterval).toBeUndefined();
    });

    it('ExtractTaskOptions_NaNAndInfinityPollInterval_Dropped', () => {
      expect(extractTaskOptions({ pollInterval: Number.NaN }).pollInterval).toBeUndefined();
      expect(extractTaskOptions({ pollInterval: Number.POSITIVE_INFINITY }).pollInterval).toBeUndefined();
    });

    it('ExtractTaskOptions_NonIntegerPollInterval_Dropped', () => {
      // Schema is `.int()` — fractional milliseconds rejected.
      expect(extractTaskOptions({ pollInterval: 0.5 }).pollInterval).toBeUndefined();
      expect(extractTaskOptions({ pollInterval: 1.7 }).pollInterval).toBeUndefined();
    });

    it('ExtractTaskOptions_NonNegativeTtl_PreservedIncludingZero', () => {
      // ttl=0 is semantically distinct from pollInterval=0: a 0ms TTL
      // means "expire immediately". Schema allows nonnegative.
      expect(extractTaskOptions({ ttl: 0 }).ttl).toBe(0);
    });

    it('ExtractTaskOptions_ArrayTaskValue_ReturnsEmpty', () => {
      // Arrays are `typeof === 'object'` but are not the SDK shape.
      expect(extractTaskOptions([])).toEqual({});
      expect(extractTaskOptions([{ ttl: 5 }])).toEqual({});
    });
  });

  // ─── CodeRabbit MAJOR #1431 follow-up: createTask defensive normalization ─

  it('CreateTask_ZeroPollInterval_NormalizesToDefault', async () => {
    const task = await taskStore.createTask(
      { pollInterval: 0 },
      'rq-zero',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    expect(task.pollInterval).toBe(1000);
    const events = await eventStore.query(`task-store/${task.taskId}`);
    const created = events.find((e) => e.type === 'task.created');
    expect(created).toBeDefined();
    expect((created!.data as { pollInterval?: number }).pollInterval).toBe(1000);
  });

  it('CreateTask_NegativePollInterval_NormalizesToDefault', async () => {
    const task = await taskStore.createTask(
      { pollInterval: -50 },
      'rq-neg',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    expect(task.pollInterval).toBe(1000);
  });

  it('CreateTask_FractionalPollInterval_NormalizesToDefault', async () => {
    const task = await taskStore.createTask(
      { pollInterval: 0.5 },
      'rq-frac',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    expect(task.pollInterval).toBe(1000);
  });

  it('CreateTask_PositivePollInterval_PersistsAndProjects', async () => {
    const task = await taskStore.createTask(
      { pollInterval: 250 },
      'rq-ok',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    expect(task.pollInterval).toBe(250);
    // REPLAY: fresh store reading the same event store reconstructs cadence.
    const freshStore = new EventSourcedTaskStore(eventStore);
    const replayed = await freshStore.getTask(task.taskId);
    expect(replayed?.pollInterval).toBe(250);
  });
});

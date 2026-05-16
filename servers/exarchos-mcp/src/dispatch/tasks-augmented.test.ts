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
  extractTaskOptions,
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

  // ─── CodeRabbit MAJOR #1431: pollInterval validity contract ───────────────
  //
  // The durable `TaskCreatedData.pollInterval` schema enforces
  // `.positive().optional()` — `0` and negatives are rejected at append.
  // The dispatch boundary (`extractTaskOptions`) MUST therefore reject those
  // values too so a malformed caller can't slip past extraction and silently
  // fail event-append validation downstream.

  describe('extractTaskOptions / pollInterval validity contract', () => {
    it('ExtractTaskOptions_PositivePollInterval_PreservesValue', () => {
      const opts = extractTaskOptions({ pollInterval: 250 });
      expect(opts.pollInterval).toBe(250);
    });

    it('ExtractTaskOptions_ZeroPollInterval_DroppedForSchemaAlignment', () => {
      // CodeRabbit MAJOR: `0` would pass the prior non-negative guard but
      // fail the `TaskCreatedData.pollInterval.positive()` schema constraint
      // at event-append time. Drop here so createTask default (1000) applies.
      const opts = extractTaskOptions({ pollInterval: 0 });
      expect(opts.pollInterval).toBeUndefined();
    });

    it('ExtractTaskOptions_NegativePollInterval_Dropped', () => {
      const opts = extractTaskOptions({ pollInterval: -100 });
      expect(opts.pollInterval).toBeUndefined();
    });

    it('ExtractTaskOptions_NaNAndInfinityPollInterval_Dropped', () => {
      expect(extractTaskOptions({ pollInterval: Number.NaN }).pollInterval).toBeUndefined();
      expect(extractTaskOptions({ pollInterval: Number.POSITIVE_INFINITY }).pollInterval).toBeUndefined();
    });

    it('ExtractTaskOptions_NonIntegerPollInterval_Dropped', () => {
      // Schema is `.int().positive()` — fractional millisecond cadences
      // would pass `.positive()` but fail `.int()` and silently corrupt
      // the best-effort append. Drop at the boundary so the createTask
      // default applies instead.
      expect(extractTaskOptions({ pollInterval: 0.5 }).pollInterval).toBeUndefined();
      expect(extractTaskOptions({ pollInterval: 1.7 }).pollInterval).toBeUndefined();
    });

    it('ExtractTaskOptions_NonNegativeTtl_PreservedIncludingZero', () => {
      // ttl=0 is semantically distinct from pollInterval=0: a 0ms TTL means
      // "expire immediately", which is occasionally meaningful for cleanup
      // tests. Schema allows nonnegative, so the boundary does too.
      const opts = extractTaskOptions({ ttl: 0 });
      expect(opts.ttl).toBe(0);
    });
  });

  // ─── CodeRabbit MAJOR #1431: createTask defensive normalization ───────────
  //
  // The dispatch boundary already filters malformed pollInterval values, but
  // `createTask` is also reachable directly from non-dispatch callers (tests,
  // future in-process SDK consumers). Normalise to the 1000ms default rather
  // than let bad values reach event-append validation.

  it('CreateTask_ZeroPollInterval_NormalizesToDefault', async () => {
    const task = await taskStore.createTask(
      { pollInterval: 0 },
      'rq-zero',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    expect(task.pollInterval).toBe(1000);

    // Durable event must reflect the normalized value (or omit pollInterval
    // when the default applies — both are schema-valid).
    const events = await eventStore.query(`task-store/${task.taskId}`);
    const created = events.find((e) => e.type === 'task.created');
    expect(created).toBeDefined();
    const data = created!.data as { pollInterval?: number };
    expect(data.pollInterval).toBe(1000);
  });

  it('CreateTask_NegativePollInterval_NormalizesToDefault', async () => {
    const task = await taskStore.createTask(
      { pollInterval: -50 },
      'rq-neg',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    expect(task.pollInterval).toBe(1000);
  });
});

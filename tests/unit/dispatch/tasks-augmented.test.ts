/**
 * Tests for the Tasks-augmented dispatch branch: `isTaskAugmented`, `extractTaskOptions`,
 * `runTasksAugmented`, and the `pollInterval` default of `EventSourcedTaskStore.createTask`.
 *
 * `core/dispatch.test.ts` pins the one-shot envelope for a call with no `task` option, because it
 * runs the real dispatch entry point.
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

  it('IsTaskAugmented_NoTaskOption_ReturnsFalse', () => {
    expect(isTaskAugmented({ action: 'describe' })).toBe(false);
    expect(isTaskAugmented({ action: 'describe', task: undefined })).toBe(false);
  });

  /** The `task` object is the augmentation signal. Its `ttl` field is optional. */
  it('IsTaskAugmented_TaskOptionPresent_ReturnsTrue', () => {
    expect(isTaskAugmented({ action: 'describe', task: {} })).toBe(true);
    expect(isTaskAugmented({ action: 'describe', task: { ttl: 60_000 } })).toBe(true);
    expect(isTaskAugmented({ action: 'describe', task: { ttl: null } })).toBe(true);
  });

  /**
   * Dispatch sees raw args before a Zod parse, so a `task` that is a string, a number or `null` is
   * not an augmentation signal.
   */
  it('IsTaskAugmented_TaskValueNotObject_ReturnsFalse', () => {
    expect(isTaskAugmented({ action: 'describe', task: 'oops' })).toBe(false);
    expect(isTaskAugmented({ action: 'describe', task: 42 })).toBe(false);
    expect(isTaskAugmented({ action: 'describe', task: null })).toBe(false);
  });

  /**
   * The handler runs in the background. The call returns at once with a `working` task inside a
   * `ToolResult` envelope.
   */
  it('DispatchCore_TaskOptionPresent_ReturnsCreateTaskResult', async () => {
    const result = await runTasksAugmented({
      taskStore,
      taskOptions: { ttl: 60_000 },
      requestId: 'rq-1',
      request: { method: 'tools/call', params: { name: 'noop', arguments: {} } },
      execute: async () => ({ success: true as const, data: { value: 1 } }),
    });

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

  /**
   * The `TaskCreatedData.pollInterval` schema accepts only a positive integer. `extractTaskOptions`
   * drops any other value, so the `createTask` default applies and the stored value is valid.
   */
  describe('extractTaskOptions / pollInterval validity contract', () => {
    it('ExtractTaskOptions_PositivePollInterval_PreservesValue', () => {
      expect(extractTaskOptions({ pollInterval: 250 }).pollInterval).toBe(250);
    });

    /** A `pollInterval` of 0 gives a tight poll loop. */
    it('ExtractTaskOptions_ZeroPollInterval_DroppedForSchemaAlignment', () => {
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
      expect(extractTaskOptions({ pollInterval: 0.5 }).pollInterval).toBeUndefined();
      expect(extractTaskOptions({ pollInterval: 1.7 }).pollInterval).toBeUndefined();
    });

    /** A `ttl` of 0 means that the task expires at once, and the schema permits it. */
    it('ExtractTaskOptions_NonNegativeTtl_PreservedIncludingZero', () => {
      expect(extractTaskOptions({ ttl: 0 }).ttl).toBe(0);
    });

    /** An array has the `typeof` value `object`, but it is not a task-options object. */
    it('ExtractTaskOptions_ArrayTaskValue_ReturnsEmpty', () => {
      expect(extractTaskOptions([])).toEqual({});
      expect(extractTaskOptions([{ ttl: 5 }])).toEqual({});
    });
  });

  /**
   * `createTask` replaces a `pollInterval` that is not a positive integer with the default of 1000.
   * The `task.created` event holds the default too.
   */
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

  /** A second store over the same event store replays the `pollInterval` from the event. */
  it('CreateTask_PositivePollInterval_PersistsAndProjects', async () => {
    const task = await taskStore.createTask(
      { pollInterval: 250 },
      'rq-ok',
      { method: 'tools/call', params: { name: 'noop', arguments: {} } },
    );
    expect(task.pollInterval).toBe(250);
    const freshStore = new EventSourcedTaskStore(eventStore);
    const replayed = await freshStore.getTask(task.taskId);
    expect(replayed?.pollInterval).toBe(250);
  });
});

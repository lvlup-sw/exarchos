/**
 * Schemas for the four `task.*` events that back `EventSourcedTaskStore`
 * (`src/projections/task-store/`). These events (`task.created`, `task.polled`,
 * `task.result`, `task.cancelled`) record the MCP task lifecycle of the SDK
 * `TaskStore` contract. The workflow events `task.assigned`, `task.claimed`,
 * `task.progressed`, `task.completed` and `task.failed` record agent work and
 * are a different set.
 */
import { describe, it, expect } from 'vitest';
import {
  EventTypes,
  EVENT_DATA_SCHEMAS,
  TaskCreatedData,
  TaskPolledData,
  TaskResultData,
  TaskCancelledData,
} from '../../../src/events/schemas.js';

describe('task.* event schemas (#1272)', () => {
  describe('TaskCreatedData', () => {
    it('EventSchema_TaskCreated_ValidatesShape', () => {
      const parsed = TaskCreatedData.parse({
        taskId: 'task-abc-123',
        createdBy: 'agent-impl-7',
        ttl: 60_000,
        request: {
          method: 'tools/call',
          params: { name: 'exarchos_orchestrate', arguments: { action: 'noop' } },
        },
      });
      expect(parsed.taskId).toBe('task-abc-123');
      expect(parsed.createdBy).toBe('agent-impl-7');
      expect(parsed.ttl).toBe(60_000);
      expect(parsed.request).toBeDefined();
    });

    /** A null `ttl` means an unlimited lifetime. */
    it('EventSchema_TaskCreated_AcceptsNullTtl', () => {
      const parsed = TaskCreatedData.parse({
        taskId: 'task-no-ttl',
        createdBy: 'agent-1',
        ttl: null,
        request: { method: 'tools/call', params: {} },
      });
      expect(parsed.ttl).toBeNull();
    });

    it('EventSchema_TaskCreated_RegisteredInEventTypes', () => {
      expect(EventTypes).toContain('task.created');
      expect(EVENT_DATA_SCHEMAS['task.created']).toBeDefined();
    });

    /** The event stores `pollInterval` so that replay restores the caller cadence. */
    it('EventSchema_TaskCreated_AcceptsPositiveIntegerPollInterval', () => {
      const parsed = TaskCreatedData.parse({
        taskId: 'task-poll',
        ttl: null,
        request: { method: 'tools/call', params: {} },
        pollInterval: 500,
      });
      expect(parsed.pollInterval).toBe(500);
    });

    /** A `pollInterval` of 0 gives a tight poll loop, so the schema rejects it. */
    it('EventSchema_TaskCreated_RejectsZeroPollInterval', () => {
      const result = TaskCreatedData.safeParse({
        taskId: 'task-zero',
        ttl: null,
        request: { method: 'tools/call', params: {} },
        pollInterval: 0,
      });
      expect(result.success).toBe(false);
    });

    it('EventSchema_TaskCreated_RejectsNonIntegerPollInterval', () => {
      const result = TaskCreatedData.safeParse({
        taskId: 'task-frac',
        ttl: null,
        request: { method: 'tools/call', params: {} },
        pollInterval: 0.5,
      });
      expect(result.success).toBe(false);
    });

    /** Older events do not have `pollInterval`, and they must still parse. */
    it('EventSchema_TaskCreated_AcceptsAbsentPollInterval', () => {
      const parsed = TaskCreatedData.parse({
        taskId: 'task-legacy',
        ttl: null,
        request: { method: 'tools/call', params: {} },
      });
      expect(parsed.pollInterval).toBeUndefined();
    });
  });

  describe('TaskPolledData', () => {
    /** New events omit the deprecated `data.sequence`. The envelope `sequence` is the poll order. */
    it('EventSchema_TaskPolled_ValidatesShape_NoSequence', () => {
      const parsed = TaskPolledData.parse({ taskId: 'task-abc-123' });
      expect(parsed.taskId).toBe('task-abc-123');
      expect(parsed.sequence).toBeUndefined();
    });

    /** Older events carry `data.sequence`, and they must still parse. */
    it('EventSchema_TaskPolled_BackCompat_AcceptsHistoricalSequenceField', () => {
      const parsed = TaskPolledData.parse({
        taskId: 'task-abc-123',
        sequence: 5,
      });
      expect(parsed.sequence).toBe(5);
    });

    /** When `data.sequence` is present, it must be a nonnegative integer. */
    it('EventSchema_TaskPolled_RejectsNegativeSequence_WhenPresent', () => {
      const result = TaskPolledData.safeParse({
        taskId: 'task-x',
        sequence: -1,
      });
      expect(result.success).toBe(false);
    });

    it('EventSchema_TaskPolled_RegisteredInEventTypes', () => {
      expect(EventTypes).toContain('task.polled');
      expect(EVENT_DATA_SCHEMAS['task.polled']).toBeDefined();
    });
  });

  describe('TaskResultData', () => {
    it('EventSchema_TaskResult_CompletedShape', () => {
      const parsed = TaskResultData.parse({
        taskId: 'task-1',
        status: 'completed',
        result: { content: [{ type: 'text', text: 'ok' }] },
      });
      expect(parsed.status).toBe('completed');
      expect(parsed.result).toBeDefined();
    });

    it('EventSchema_TaskResult_FailedShape', () => {
      const parsed = TaskResultData.parse({
        taskId: 'task-2',
        status: 'failed',
        error: 'something went wrong',
      });
      expect(parsed.status).toBe('failed');
      expect(parsed.error).toBe('something went wrong');
    });

    it('EventSchema_TaskResult_CancelledShape', () => {
      const parsed = TaskResultData.parse({
        taskId: 'task-3',
        status: 'cancelled',
      });
      expect(parsed.status).toBe('cancelled');
    });

    it('EventSchema_TaskResult_RejectsUnknownStatus', () => {
      const result = TaskResultData.safeParse({
        taskId: 'task-x',
        status: 'mystery',
      });
      expect(result.success).toBe(false);
    });

    it('EventSchema_TaskResult_RegisteredInEventTypes', () => {
      expect(EventTypes).toContain('task.result');
      expect(EVENT_DATA_SCHEMAS['task.result']).toBeDefined();
    });
  });

  describe('TaskCancelledData', () => {
    it('EventSchema_TaskCancelled_ValidatesShape', () => {
      const parsed = TaskCancelledData.parse({
        taskId: 'task-abc-123',
        reason: 'client-requested',
      });
      expect(parsed.taskId).toBe('task-abc-123');
      expect(parsed.reason).toBe('client-requested');
    });

    it('EventSchema_TaskCancelled_RequiresReason', () => {
      const result = TaskCancelledData.safeParse({
        taskId: 'task-x',
      });
      expect(result.success).toBe(false);
    });

    it('EventSchema_TaskCancelled_RegisteredInEventTypes', () => {
      expect(EventTypes).toContain('task.cancelled');
      expect(EVENT_DATA_SCHEMAS['task.cancelled']).toBeDefined();
    });
  });
});

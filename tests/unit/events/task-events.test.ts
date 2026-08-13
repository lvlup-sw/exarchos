/**
 * Task event schemas for #1272 (EventSourcedTaskStore).
 *
 * These four `task.*` event types are the durable substrate for the
 * `EventSourcedTaskStore` (src/projections/task-store/) which
 * implements the SDK `TaskStore` interface as a projection over the
 * event store. Each event is emitted by the EventSourcedTaskStore's
 * lifecycle methods (`createTask`, `getTask`, `getTaskResult`,
 * `cancelTask`).
 *
 * Distinct from the pre-existing workflow `task.*` events
 * (`task.assigned`/`task.claimed`/`task.progressed`/`task.completed`/
 * `task.failed`) which describe orchestrated agent work; these four
 * (`task.created`/`task.polled`/`task.result`/`task.cancelled`) describe
 * MCP-protocol task lifecycle for the SDK's TaskStore contract
 * (see `@modelcontextprotocol/sdk/experimental/tasks/interfaces.ts`).
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

    it('EventSchema_TaskCreated_AcceptsNullTtl', () => {
      // SDK spec: null ttl = unlimited lifetime (no automatic cleanup).
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

    it('EventSchema_TaskCreated_AcceptsPositiveIntegerPollInterval', () => {
      // CodeRabbit MAJOR #1431 follow-up: pollInterval is persisted so
      // REPLAY can reconstruct caller cadence.
      const parsed = TaskCreatedData.parse({
        taskId: 'task-poll',
        ttl: null,
        request: { method: 'tools/call', params: {} },
        pollInterval: 500,
      });
      expect(parsed.pollInterval).toBe(500);
    });

    it('EventSchema_TaskCreated_RejectsZeroPollInterval', () => {
      // Schema enforces `.positive()` — `0` is a degenerate cadence that
      // would degrade to a tight loop; reject at the boundary.
      const result = TaskCreatedData.safeParse({
        taskId: 'task-zero',
        ttl: null,
        request: { method: 'tools/call', params: {} },
        pollInterval: 0,
      });
      expect(result.success).toBe(false);
    });

    it('EventSchema_TaskCreated_RejectsNonIntegerPollInterval', () => {
      // Schema enforces `.int()` — fractional milliseconds are rejected.
      const result = TaskCreatedData.safeParse({
        taskId: 'task-frac',
        ttl: null,
        request: { method: 'tools/call', params: {} },
        pollInterval: 0.5,
      });
      expect(result.success).toBe(false);
    });

    it('EventSchema_TaskCreated_AcceptsAbsentPollInterval', () => {
      // Field is optional — historical events without it still project.
      const parsed = TaskCreatedData.parse({
        taskId: 'task-legacy',
        ttl: null,
        request: { method: 'tools/call', params: {} },
      });
      expect(parsed.pollInterval).toBeUndefined();
    });
  });

  describe('TaskPolledData', () => {
    it('EventSchema_TaskPolled_ValidatesShape_NoSequence', () => {
      // CodeRabbit MAJOR #1431 follow-up: `data.sequence` is now optional
      // + deprecated. New emits omit the payload field entirely and rely
      // on the event envelope's atomically-assigned `.sequence`.
      const parsed = TaskPolledData.parse({ taskId: 'task-abc-123' });
      expect(parsed.taskId).toBe('task-abc-123');
      expect(parsed.sequence).toBeUndefined();
    });

    it('EventSchema_TaskPolled_BackCompat_AcceptsHistoricalSequenceField', () => {
      // Historical events written before the deprecation still validate.
      const parsed = TaskPolledData.parse({
        taskId: 'task-abc-123',
        sequence: 5,
      });
      expect(parsed.sequence).toBe(5);
    });

    it('EventSchema_TaskPolled_RejectsNegativeSequence_WhenPresent', () => {
      // Field is optional, but when present it must satisfy the
      // nonnegative-int constraint — guards against any future regression
      // that resurrects the placeholder pattern with bad values.
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from './store.js';
import { handleEventAppend, handleEventQuery, handleBatchAppend } from './tools.js';

let tempDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-tools-test-'));
  eventStore = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── T4: VALIDATION_ERROR for malformed model-emitted event data ────────────

describe('handleEventAppend data validation', () => {
  it('HandleEventAppend_ModelEventInvalidData_ReturnsValidationError', async () => {
    const result = await handleEventAppend(
      {
        stream: 'validate-test',
        event: {
          type: 'team.task.completed',
          data: { foo: 'bar' },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VALIDATION_ERROR');
    expect(result.error!.message).toContain('team.task.completed');
  });

  it('HandleEventAppend_ModelEventValidData_Succeeds', async () => {
    const result = await handleEventAppend(
      {
        stream: 'validate-test',
        event: {
          type: 'team.task.completed',
          data: {
            taskId: 'task-001',
            teammateName: 'worker-1',
            durationMs: 5000,
            filesChanged: ['a.ts'],
            testsPassed: true,
            qualityGateResults: {},
          },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});

// ─── Prototype Pollution Prevention ─────────────────────────────────────────

describe('handleEventQuery field projection', () => {
  it('should filter out __proto__ from fields', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started', data: { foo: 'bar' } });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', '__proto__', 'sequence'] },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type', 'workflow.started');
    expect(projected[0]).toHaveProperty('sequence', 1);
    expect(projected[0]).not.toHaveProperty('__proto__');
  });

  it('should filter out constructor from fields', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'constructor'] },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type', 'workflow.started');
    expect(projected[0]).not.toHaveProperty('constructor');
  });

  it('should filter out prototype from fields', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'prototype'] },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type', 'workflow.started');
    expect(projected[0]).not.toHaveProperty('prototype');
  });

  it('should return empty projection when all fields are unsafe', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['__proto__', 'constructor', 'prototype'] },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(Object.keys(projected[0])).toHaveLength(0);
  });

  it('should allow safe fields through', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'sequence', 'streamId', 'timestamp'] },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type');
    expect(projected[0]).toHaveProperty('sequence');
    expect(projected[0]).toHaveProperty('streamId');
    expect(projected[0]).toHaveProperty('timestamp');
  });
});

// ─── Task 003: batch_append action ───────────────────────────────────────────

describe('handleBatchAppend', () => {
  it('batchAppend_MultipleEvents_AppendsAllWithSequentialSequenceNumbers', async () => {
    // Arrange: seed the stream with one event so we start from sequence 1
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    // Act: batch append 3 events
    const result = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 't1' } },
          { type: 'task.assigned', data: { taskId: 't2' } },
          { type: 'task.assigned', data: { taskId: 't3' } },
        ],
      },
      tempDir,
      store,
    );

    // Assert
    expect(result.success).toBe(true);
    const sequences = result.data as Array<{ streamId: string; sequence: number; type: string }>;
    expect(sequences).toHaveLength(3);
    expect(sequences[0].sequence).toBe(2);
    expect(sequences[1].sequence).toBe(3);
    expect(sequences[2].sequence).toBe(4);

    // Verify all events exist in the stream
    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, store);
    expect(queryResult.success).toBe(true);
    expect(queryResult.data).toHaveLength(4);
  });

  it('batchAppend_EmptyArray_ReturnsError', async () => {
    const result = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [],
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INVALID_INPUT');
  });

  it('batchAppend_IdempotencyKey_DeduplicatesAcrossBatch', async () => {
    const result = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 't1' }, idempotencyKey: 'key-dup' },
          { type: 'task.assigned', data: { taskId: 't2' }, idempotencyKey: 'key-dup' },
        ],
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const sequences = result.data as Array<{ streamId: string; sequence: number; type: string }>;
    // Only 1 event should be appended — the second is a duplicate
    expect(sequences).toHaveLength(1);

    // Verify only 1 event in stream
    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    expect(queryResult.data).toHaveLength(1);
  });

  it('batchAppend_ValidationFailure_AtomicRollback', async () => {
    // Arrange: seed the stream
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    // Act: batch with 1 invalid event (missing type)
    const result = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 't1' } },
          { type: 'INVALID_TYPE_DOES_NOT_EXIST' as string, data: {} },
          { type: 'task.assigned', data: { taskId: 't3' } },
        ],
      },
      tempDir,
      store,
    );

    // Assert: entire batch fails
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    // Verify no new events were appended (only the seed event)
    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, store);
    expect(queryResult.success).toBe(true);
    expect(queryResult.data).toHaveLength(1);
  });

  it('batchAppend_ConcurrentWrite_RespectsStreamLock', async () => {
    // Arrange: two concurrent batch appends on the same stream
    const batch1 = handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 'a1' } },
          { type: 'task.assigned', data: { taskId: 'a2' } },
          { type: 'task.assigned', data: { taskId: 'a3' } },
        ],
      },
      tempDir,
      eventStore,
    );

    const batch2 = handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.completed', data: { taskId: 'b1' } },
          { type: 'task.completed', data: { taskId: 'b2' } },
          { type: 'task.completed', data: { taskId: 'b3' } },
        ],
      },
      tempDir,
      eventStore,
    );

    // Act: run both concurrently
    const [result1, result2] = await Promise.all([batch1, batch2]);

    // Assert: both succeed
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    // Total 6 events, with sequential sequence numbers (no gaps, no interleaving)
    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    const events = queryResult.data as Array<{ sequence: number; type: string }>;
    expect(events).toHaveLength(6);

    // Verify sequential numbering
    for (let i = 0; i < events.length; i++) {
      expect(events[i].sequence).toBe(i + 1);
    }

    // Verify no interleaving: events from each batch should be contiguous
    const batch1Seqs = (result1.data as Array<{ sequence: number }>).map(e => e.sequence);
    const batch2Seqs = (result2.data as Array<{ sequence: number }>).map(e => e.sequence);

    // One batch should have sequences 1,2,3 and the other 4,5,6
    const allSeqs = [...batch1Seqs, ...batch2Seqs].sort((a, b) => a - b);
    expect(allSeqs).toEqual([1, 2, 3, 4, 5, 6]);

    // Each batch's sequences should be contiguous (no interleaving)
    expect(batch1Seqs[1] - batch1Seqs[0]).toBe(1);
    expect(batch1Seqs[2] - batch1Seqs[1]).toBe(1);
    expect(batch2Seqs[1] - batch2Seqs[0]).toBe(1);
    expect(batch2Seqs[2] - batch2Seqs[1]).toBe(1);
  });
});

// ─── Dot-path field projection in event queries ─────────────────────────────

describe('handleEventQuery dot-path field projection', () => {
  it('handleEventQuery_WithoutFieldsParam_ReturnsCompleteEvents', async () => {
    const store = new EventStore(tempDir);
    await store.append('dot-path-test', {
      type: 'task.completed',
      data: { taskId: 't1', title: 'My Task', assignee: 'agent-1' },
    });

    const result = await handleEventQuery({ stream: 'dot-path-test' }, tempDir, store);

    expect(result.success).toBe(true);
    const events = result.data as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    const eventData = events[0].data as Record<string, unknown>;
    expect(eventData).toBeDefined();
    expect(eventData.taskId).toBe('t1');
    expect(eventData.title).toBe('My Task');
    expect(eventData.assignee).toBe('agent-1');
  });

  it('handleEventQuery_WithDotPathFields_ReturnsNestedProjection', async () => {
    const store = new EventStore(tempDir);
    await store.append('dot-path-test', {
      type: 'task.completed',
      data: { taskId: 't1', title: 'My Task', assignee: 'agent-1' },
    });

    const result = await handleEventQuery(
      { stream: 'dot-path-test', fields: ['type', 'data.taskId'] },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = result.data as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task.completed');
    const eventData = events[0].data as Record<string, unknown>;
    expect(eventData).toEqual({ taskId: 't1' });
  });
});

// ─── Multi-tenant field passthrough ──────────────────────────────────────────

describe('tenant field passthrough', () => {
  it('handleEventAppend_WithTenantFields_PassesThroughToStore', async () => {
    const result = await handleEventAppend(
      {
        stream: 'tenant-test',
        event: {
          type: 'workflow.started',
          tenantId: 'tenant-abc',
          organizationId: 'org-xyz',
          data: { featureId: 'test', workflowType: 'feature' },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const query = await handleEventQuery({ stream: 'tenant-test' }, tempDir, eventStore);
    const events = query.data as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe('tenant-abc');
    expect(events[0].organizationId).toBe('org-xyz');
  });

  it('handleBatchAppend_WithTenantFields_PassesThroughToStore', async () => {
    const result = await handleBatchAppend(
      {
        stream: 'tenant-batch',
        events: [
          { type: 'task.assigned', tenantId: 'tenant-1', organizationId: 'org-1', data: { taskId: 't1' } },
          { type: 'task.assigned', tenantId: 'tenant-1', data: { taskId: 't2' } },
        ],
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const query = await handleEventQuery({ stream: 'tenant-batch' }, tempDir, eventStore);
    const events = query.data as Array<Record<string, unknown>>;
    expect(events).toHaveLength(2);
    expect(events[0].tenantId).toBe('tenant-1');
    expect(events[0].organizationId).toBe('org-1');
    expect(events[1].tenantId).toBe('tenant-1');
    expect(events[1].organizationId).toBeUndefined();
  });
});

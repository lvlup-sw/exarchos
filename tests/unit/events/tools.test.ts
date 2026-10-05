import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../../src/events/store.js';
import { AtomicAppender } from '../../../src/events/atomic-appender.js';
import {
  handleEventAppend,
  handleEventQuery,
  handleBatchAppend,
  EVENT_QUERY_DEFAULT_LIMIT,
  type EventQueryPage,
} from '../../../src/events/tools.js';
import type { EventAck, ToolResult } from '../../../src/format.js';
import { runWithDispatchContext } from '../../../src/dispatch/dispatch-context.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { estimateOutputTokens } from '../../../src/dispatch/core/economy.js';

/** Reads `events` from the `{ events, page }` result of `event query`. */
function queryEvents(result: ToolResult): Array<Record<string, unknown>> {
  const data = result.data as { events?: unknown } | undefined;
  return (data?.events ?? []) as Array<Record<string, unknown>>;
}
function queryPage(result: ToolResult): EventQueryPage {
  return (result.data as { page: EventQueryPage }).page;
}

let tempDir: string;
let eventStore: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-tools-test-'));
  eventStore = new EventStore(tempDir);
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

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

describe('handleEventAppend misplaced fields', () => {
  it('rejects event with type-specific fields at top level', async () => {
    const result = await handleEventAppend(
      {
        stream: 'misplaced-test',
        event: {
          type: 'gate.executed',
          gateName: 'static-analysis',
          layer: 'D2',
          passed: true,
          details: { reason: 'builds clean' },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('VALIDATION_ERROR');
    expect(result.error!.message).toContain('should be inside "data"');
    expect(result.error!.message).toContain('gateName');
  });

  it('accepts event with fields correctly inside data envelope', async () => {
    const result = await handleEventAppend(
      {
        stream: 'correct-test',
        event: {
          type: 'gate.executed',
          data: {
            gateName: 'static-analysis',
            layer: 'D2',
            passed: true,
            details: { reason: 'builds clean' },
          },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
  });

  it('allows unknown top-level fields for events without data schema', async () => {
    const result = await handleEventAppend(
      {
        stream: 'unknown-test',
        event: {
          type: 'workflow.started',
          data: { featureId: 'test', workflowType: 'feature' },
          correlationId: 'corr-123',
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
  });
});

describe('handleBatchAppend misplaced fields', () => {
  it('rejects batch with misplaced fields in any event', async () => {
    const result = await handleBatchAppend(
      {
        stream: 'batch-misplaced',
        events: [
          { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' } },
          { type: 'gate.executed', gateName: 'lint', layer: 'D2', passed: true },
        ],
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('VALIDATION_ERROR');
    expect(result.error!.message).toContain('events[1]');
    expect(result.error!.message).toContain('gateName');
  });
});

/** The projection drops `__proto__`, `constructor` and `prototype` to prevent prototype pollution. */
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
    const projected = queryEvents(result);
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
    const projected = queryEvents(result);
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
    const projected = queryEvents(result);
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
    const projected = queryEvents(result);
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
    const projected = queryEvents(result);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type');
    expect(projected[0]).toHaveProperty('sequence');
    expect(projected[0]).toHaveProperty('streamId');
    expect(projected[0]).toHaveProperty('timestamp');
  });
});

describe('handleBatchAppend', () => {
  it('batchAppend_MultipleEvents_AppendsAllWithSequentialSequenceNumbers', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    const result = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' } },
          { type: 'task.assigned', data: { taskId: 't2', title: 'Task t2' } },
          { type: 'task.assigned', data: { taskId: 't3', title: 'Task t3' } },
        ],
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const sequences = result.data as Array<{ streamId: string; sequence: number; type: string }>;
    expect(sequences).toHaveLength(3);
    expect(sequences[0].sequence).toBe(2);
    expect(sequences[1].sequence).toBe(3);
    expect(sequences[2].sequence).toBe(4);

    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, store);
    expect(queryResult.success).toBe(true);
    expect(queryEvents(queryResult)).toHaveLength(4);
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

  /** Two events in one batch share a key, so the handler appends only the first one. */
  it('batchAppend_IdempotencyKey_DeduplicatesAcrossBatch', async () => {
    const result = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' }, idempotencyKey: 'key-dup' },
          { type: 'task.assigned', data: { taskId: 't2', title: 'Task t2' }, idempotencyKey: 'key-dup' },
        ],
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);
    const sequences = result.data as Array<{ streamId: string; sequence: number; type: string }>;
    expect(sequences).toHaveLength(1);

    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    expect(queryEvents(queryResult)).toHaveLength(1);
  });

  it('batchAppend_ValidationFailure_AtomicRollback', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    const result = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' } },
          { type: 'INVALID_TYPE_DOES_NOT_EXIST' as string, data: {} },
          { type: 'task.assigned', data: { taskId: 't3', title: 'Task t3' } },
        ],
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, store);
    expect(queryResult.success).toBe(true);
    expect(queryEvents(queryResult)).toHaveLength(1);
  });

  /**
   * The three events of the first batch share one `idempotencyKey`. The handler
   * keeps only the first one, and that key becomes the batch key. A retry with
   * that key hits the cache and must return the committed batch. On a cache hit,
   * each ack takes its type from the persisted event.
   */
  it('batchAppend_cacheHitWithFewerCurrentEvents_returnsOriginalBatchWithoutCrash', async () => {
    const store = new EventStore(tempDir);

    const first = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' }, idempotencyKey: 'shared-batch' },
          { type: 'task.assigned', data: { taskId: 't2', title: 'Task t2' }, idempotencyKey: 'shared-batch' },
          { type: 'task.assigned', data: { taskId: 't3', title: 'Task t3' }, idempotencyKey: 'shared-batch' },
        ],
      },
      tempDir,
      store,
    );
    expect(first.success).toBe(true);

    const retry = await handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' }, idempotencyKey: 'shared-batch' },
        ],
      },
      tempDir,
      store,
    );
    expect(retry.success).toBe(true);
    const acks = retry.data as Array<{ streamId: string; sequence: number; type: string }>;
    expect(acks.length).toBeGreaterThanOrEqual(1);
    expect(acks[0].sequence).toBe(1);
  });

  /**
   * Two concurrent batches must each get a contiguous run of sequences, and the
   * stream must hold sequences 1 to 6 with no gap. The query returns newest-first,
   * so the test sorts the sequences before it compares them.
   */
  it('batchAppend_ConcurrentWrite_RespectsStreamLock', async () => {
    const batch1 = handleBatchAppend(
      {
        stream: 'my-workflow',
        events: [
          { type: 'task.assigned', data: { taskId: 'a1', title: 'Task a1' } },
          { type: 'task.assigned', data: { taskId: 'a2', title: 'Task a2' } },
          { type: 'task.assigned', data: { taskId: 'a3', title: 'Task a3' } },
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

    const [result1, result2] = await Promise.all([batch1, batch2]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    const events = queryEvents(queryResult) as Array<{ sequence: number; type: string }>;
    expect(events).toHaveLength(6);

    const seqs = events.map((e) => e.sequence).sort((a, b) => a - b);
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]).toBe(i + 1);
    }

    const batch1Seqs = (result1.data as Array<{ sequence: number }>).map(e => e.sequence);
    const batch2Seqs = (result2.data as Array<{ sequence: number }>).map(e => e.sequence);

    const allSeqs = [...batch1Seqs, ...batch2Seqs].sort((a, b) => a - b);
    expect(allSeqs).toEqual([1, 2, 3, 4, 5, 6]);

    expect(batch1Seqs[1] - batch1Seqs[0]).toBe(1);
    expect(batch1Seqs[2] - batch1Seqs[1]).toBe(1);
    expect(batch2Seqs[1] - batch2Seqs[0]).toBe(1);
    expect(batch2Seqs[2] - batch2Seqs[1]).toBe(1);
  });

  /**
   * A failed append must reach the caller as an error that carries the message
   * of the cause, and no event must land. The handler gets its appender from the
   * `EventStore`, so a spy on `AtomicAppender.prototype.append` intercepts the call.
   */
  it('handleEventBatchAppend_appenderFails_returnsStructuredErrorNotSilentSuccess', async () => {
    const appendSpy = vi
      .spyOn(AtomicAppender.prototype, 'append')
      .mockResolvedValueOnce({
        ok: false,
        reason: 'io-error',
        cause: new Error('simulated jsonl write failure'),
      });

    try {
      const result = await handleBatchAppend(
        {
          stream: 'failure-test',
          events: [
            { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' } },
            { type: 'task.assigned', data: { taskId: 't2', title: 'Task t2' } },
          ],
        },
        tempDir,
        eventStore,
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('BATCH_APPEND_FAILED');
      expect(result.error!.message).toContain('simulated jsonl write failure');

      const queryResult = await handleEventQuery({ stream: 'failure-test' }, tempDir, eventStore);
      expect(queryResult.success).toBe(true);
      expect(queryEvents(queryResult)).toHaveLength(0);
    } finally {
      appendSpy.mockRestore();
    }
  });

  /** Concurrent batches must not share a sequence, and the stream must hold exactly sequences 1 to `2 * N`. */
  it('handleEventBatchAppend_concurrentCalls_noDuplicateSequences', async () => {
    const N = 8;
    const batches = Array.from({ length: N }, (_, i) =>
      handleBatchAppend(
        {
          stream: 'concurrent-test',
          events: [
            { type: 'task.assigned', data: { taskId: `b${i}-1`, title: `Task b${i}-1` } },
            { type: 'task.assigned', data: { taskId: `b${i}-2`, title: `Task b${i}-2` } },
          ],
        },
        tempDir,
        eventStore,
      ),
    );

    const results = await Promise.all(batches);

    for (const r of results) {
      expect(r.success).toBe(true);
    }

    const allSeqs: number[] = [];
    for (const r of results) {
      const acks = r.data as EventAck[];
      for (const ack of acks) {
        allSeqs.push(ack.sequence);
      }
    }
    const uniqueSeqs = new Set(allSeqs);
    expect(uniqueSeqs.size).toBe(allSeqs.length);

    const queryResult = await handleEventQuery({ stream: 'concurrent-test' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    const events = queryEvents(queryResult) as Array<{ sequence: number }>;
    expect(events).toHaveLength(2 * N);
    const persistedSeqs = events.map(e => e.sequence).sort((a, b) => a - b);
    for (let i = 0; i < persistedSeqs.length; i++) {
      expect(persistedSeqs[i]).toBe(i + 1);
    }
  });

  /**
   * Distinct per-event keys give each batch a fresh `batch:<uuid>` key. A second
   * submit of the same batch therefore gets a different key, and both batches land.
   */
  it('batchAppend_MixedKeysAcrossBatches_NoCrossBatchDedup', async () => {
    const batchEvents = [
      { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' }, idempotencyKey: 'mixed-k1' },
      { type: 'task.assigned', data: { taskId: 't2', title: 'Task t2' }, idempotencyKey: 'mixed-k2' },
    ];

    const first = await handleBatchAppend(
      { stream: 'mixed-keys-test', events: batchEvents },
      tempDir,
      eventStore,
    );
    expect(first.success).toBe(true);
    expect((first.data as EventAck[]).length).toBe(2);

    const second = await handleBatchAppend(
      { stream: 'mixed-keys-test', events: batchEvents },
      tempDir,
      eventStore,
    );
    expect(second.success).toBe(true);
    expect((second.data as EventAck[]).length).toBe(2);

    const firstSeqs = (first.data as EventAck[]).map(a => a.sequence);
    const secondSeqs = (second.data as EventAck[]).map(a => a.sequence);
    expect(Math.min(...secondSeqs)).toBeGreaterThan(Math.max(...firstSeqs));

    const queryResult = await handleEventQuery(
      { stream: 'mixed-keys-test' },
      tempDir,
      eventStore,
    );
    expect(queryResult.success).toBe(true);
    expect(queryEvents(queryResult)).toHaveLength(4);
  });

  /**
   * A retry that hits the idempotency cache must return the `operationId` of the
   * first write. The retry here runs with no dispatch context, so the persisted
   * event is the only source of `op-xyz`.
   */
  it('BatchAppend_CacheHit_ReturnsOperationId', async () => {
    const store = new EventStore(tempDir);

    const first = await runWithDispatchContext(
      { operationId: 'op-xyz', correlationId: 'cor-xyz' },
      () =>
        store.batchAppend('s1', [
          { type: 'task.assigned', idempotencyKey: 'k1', data: { taskId: 't1', title: 'Task t1' } },
        ]),
    );
    expect(first[0].operationId).toBe('op-xyz');

    const replay = await store.batchAppend('s1', [
      { type: 'task.assigned', idempotencyKey: 'k1', data: { taskId: 't1', title: 'Task t1' } },
    ]);
    expect(replay[0].operationId).toBe('op-xyz');
  });
});

describe('handleEventQuery dot-path field projection', () => {
  it('handleEventQuery_WithoutFieldsParam_ReturnsCompleteEvents', async () => {
    const store = new EventStore(tempDir);
    await store.append('dot-path-test', {
      type: 'task.completed',
      data: { taskId: 't1', title: 'My Task', assignee: 'agent-1' },
    });

    const result = await handleEventQuery({ stream: 'dot-path-test' }, tempDir, store);

    expect(result.success).toBe(true);
    const events = queryEvents(result);
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
    const events = queryEvents(result);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task.completed');
    const eventData = events[0].data as Record<string, unknown>;
    expect(eventData).toEqual({ taskId: 't1' });
  });
});

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
    const events = queryEvents(query);
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe('tenant-abc');
    expect(events[0].organizationId).toBe('org-xyz');
  });

  /** The query returns newest-first, so the test finds each event by `taskId`. */
  it('handleBatchAppend_WithTenantFields_PassesThroughToStore', async () => {
    const result = await handleBatchAppend(
      {
        stream: 'tenant-batch',
        events: [
          { type: 'task.assigned', tenantId: 'tenant-1', organizationId: 'org-1', data: { taskId: 't1', title: 'Task t1' } },
          { type: 'task.assigned', tenantId: 'tenant-1', data: { taskId: 't2', title: 'Task t2' } },
        ],
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const query = await handleEventQuery({ stream: 'tenant-batch' }, tempDir, eventStore);
    const events = queryEvents(query);
    expect(events).toHaveLength(2);
    const byTask = (id: string) =>
      events.find((e) => (e.data as Record<string, unknown> | undefined)?.taskId === id)!;
    expect(byTask('t1').tenantId).toBe('tenant-1');
    expect(byTask('t1').organizationId).toBe('org-1');
    expect(byTask('t2').tenantId).toBe('tenant-1');
    expect(byTask('t2').organizationId).toBeUndefined();
  });
});

/** `handleEventQuery` must pass `filter.operationId` to `EventStore.query`. */
describe('handleEventQuery operationId filter passthrough', () => {
  it('handleEventQuery_WithOperationIdFilter_ReturnsOnlyMatchingEvents', async () => {
    const store = new EventStore(tempDir);
    await store.append('op-filter-test', {
      type: 'workflow.started',
      operationId: 'op-a',
      data: { featureId: 'test', workflowType: 'feature' },
    });
    await store.append('op-filter-test', {
      type: 'task.assigned',
      operationId: 'op-b',
      data: { taskId: 't1', title: 'Task t1' },
    });
    await store.append('op-filter-test', {
      type: 'task.assigned',
      operationId: 'op-a',
      data: { taskId: 't2', title: 'Task t2' },
    });

    const result = await handleEventQuery(
      { stream: 'op-filter-test', filter: { operationId: 'op-a' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = queryEvents(result);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.operationId === 'op-a')).toBe(true);
  });

  /** An empty `operationId` matches nothing as a filter, so the handler must ignore it. */
  it('handleEventQuery_WithEmptyOperationIdFilter_IsIgnoredNotTreatedAsAFilter', async () => {
    const store = new EventStore(tempDir);
    await store.append('op-filter-empty-test', {
      type: 'workflow.started',
      operationId: 'op-a',
      data: { featureId: 'test', workflowType: 'feature' },
    });

    const result = await handleEventQuery(
      { stream: 'op-filter-empty-test', filter: { operationId: '' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    expect(queryEvents(result)).toHaveLength(1);
  });
});

/**
 * A default query returns the 20 newest events and `page` metadata, which keeps
 * a stream read small in the session token budget. An explicit `limit` and
 * `offset` reach the full history, newest-first, with no gap and no duplicate.
 */
describe('handleEventQuery DR-5 default limit + page metadata', () => {
  let propStreamCounter = 0;

  async function seed(stream: string, count: number): Promise<void> {
    const events = Array.from({ length: count }, (_, i) => ({
      type: 'task.assigned' as const,
      data: { taskId: `t${i + 1}`, title: `Task t${i + 1}` },
    }));
    const result = await handleBatchAppend({ stream, events }, tempDir, eventStore);
    expect(result.success).toBe(true);
  }

  /**
   * The default query on a 112-event stream must stay within 1,600 estimated
   * tokens, and `page.hasMore` must show that older events exist. An audit of a
   * 112-event stream measured 5,755 tokens with no limit and 1,490 at limit 20.
   */
  it('eventQuery_DefaultLimitOn112EventStream_StaysUnderTokenBudget', async () => {
    await seed('dr5-budget', 112);
    const result = await handleEventQuery({ stream: 'dr5-budget' }, tempDir, eventStore);
    expect(result.success).toBe(true);
    expect(estimateOutputTokens(result.data)).toBeLessThanOrEqual(1600);
    expect(queryPage(result)).toMatchObject({ hasMore: true, total: 112 });
  });

  /**
   * `TOTAL` is more than the default limit, so the query hides the 5 oldest
   * events. It must return sequences 6 to 25 in descending order.
   */
  it('eventQuery_NoLimit_Returns20NewestWithPageMetadata', async () => {
    const TOTAL = 25;
    await seed('dr5-default', TOTAL);

    const result = await handleEventQuery({ stream: 'dr5-default' }, tempDir, eventStore);
    expect(result.success).toBe(true);

    const events = queryEvents(result) as Array<{ sequence: number }>;
    const page = queryPage(result);

    expect(events).toHaveLength(EVENT_QUERY_DEFAULT_LIMIT);
    const seqs = events.map((e) => e.sequence);
    expect(seqs[0]).toBe(TOTAL);
    expect(seqs[EVENT_QUERY_DEFAULT_LIMIT - 1]).toBe(TOTAL - EVENT_QUERY_DEFAULT_LIMIT + 1);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    expect(new Set(seqs)).toEqual(
      new Set(Array.from({ length: EVENT_QUERY_DEFAULT_LIMIT }, (_, i) => TOTAL - i)),
    );

    expect(page).toEqual({
      total: TOTAL,
      offset: 0,
      limit: EVENT_QUERY_DEFAULT_LIMIT,
      hasMore: true,
    });
  });

  it('eventQuery_UnderDefault_ReturnsAllWithHasMoreFalse', async () => {
    await seed('dr5-small', 3);
    const result = await handleEventQuery({ stream: 'dr5-small' }, tempDir, eventStore);
    expect(result.success).toBe(true);
    expect(queryEvents(result)).toHaveLength(3);
    expect(queryPage(result)).toEqual({
      total: 3,
      offset: 0,
      limit: EVENT_QUERY_DEFAULT_LIMIT,
      hasMore: false,
    });
  });

  it('eventQuery_ExplicitLimit_RetainsFullHistoryAccess', async () => {
    await seed('dr5-full', 50);
    const result = await handleEventQuery(
      { stream: 'dr5-full', limit: 1000 },
      tempDir,
      eventStore,
    );
    expect(result.success).toBe(true);
    expect(queryEvents(result)).toHaveLength(50);
    expect(queryPage(result).hasMore).toBe(false);
    expect(queryPage(result).total).toBe(50);
  });

  /**
   * Property: pages with an explicit `limit` and `offset` cover sequences 1 to
   * `total` exactly once, for each generated stream size and page size. Each page
   * before the last one must be full. The `guard` bound stops a pager that does
   * not terminate.
   */
  it('eventQuery_OffsetPaging_CoversFullStreamDeterministically', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 12 }),
        async (total, pageSize) => {
          const stream = `dr5-prop-${propStreamCounter++}`;
          await seed(stream, total);

          const seen: number[] = [];
          let offset = 0;
          for (let guard = 0; guard <= total + 1; guard++) {
            const result = await handleEventQuery(
              { stream, limit: pageSize, offset },
              tempDir,
              eventStore,
            );
            expect(result.success).toBe(true);
            const events = queryEvents(result) as Array<{ sequence: number }>;
            const page = queryPage(result);

            expect(page.total).toBe(total);
            expect(page.limit).toBe(pageSize);
            expect(page.offset).toBe(offset);
            expect(page.hasMore).toBe(offset + events.length < total);

            for (const e of events) seen.push(e.sequence);

            if (!page.hasMore) break;
            expect(events).toHaveLength(pageSize);
            offset += pageSize;
          }

          expect(seen).toHaveLength(total);
          expect(new Set(seen).size).toBe(total);
          expect([...seen].sort((a, b) => a - b)).toEqual(
            Array.from({ length: total }, (_, i) => i + 1),
          );
        },
      ),
      { numRuns: 40 },
    );
  });

  it('eventQuery_RepeatedPage_IsDeterministic', async () => {
    await seed('dr5-stable', 30);
    const a = await handleEventQuery({ stream: 'dr5-stable', limit: 7, offset: 10 }, tempDir, eventStore);
    const b = await handleEventQuery({ stream: 'dr5-stable', limit: 7, offset: 10 }, tempDir, eventStore);
    expect(queryEvents(a)).toEqual(queryEvents(b));
    expect(queryPage(a)).toEqual(queryPage(b));
  });
});

/**
 * For `team.disbanded`, `handleEventAppend` counts the `task.completed` events
 * of the team and stores that count as `tasksCompleted`. It discards the value
 * from the caller, because the tally of an agent is often wrong.
 * `readStreamJsonl` reads through `EventStore.query`, not from a JSONL file.
 */
describe('handleEventAppend team.disbanded routing (C11, #1224)', () => {
  async function seedTaskCompleted(
    stream: string,
    teamId: string,
    taskIds: string[],
  ): Promise<void> {
    for (const taskId of taskIds) {
      const result = await handleEventAppend(
        {
          stream,
          event: {
            type: 'task.completed',
            data: { taskId, teamId },
          },
        },
        tempDir,
        eventStore,
      );
      if (!result.success) {
        throw new Error(`seed task.completed failed: ${JSON.stringify(result.error)}`);
      }
    }
  }

  async function readStreamJsonl(stream: string): Promise<Array<Record<string, unknown>>> {
    const events = await eventStore.query(stream);
    return events.map((e) => e as unknown as Record<string, unknown>);
  }

  /** The stream holds 3 `task.completed` events for the team, so the stored count must be 3, not 999. */
  it('handleEventAppend_teamDisbanded_recomputesTasksCompleted', async () => {
    const stream = 'parent-stream-c11-1';
    const teamId = 'team-alpha';

    await seedTaskCompleted(stream, teamId, ['t-1', 't-2', 't-3']);

    const result = await handleEventAppend(
      {
        stream,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            tasksCompleted: 999,
            tasksFailed: 0,
            totalDurationMs: 1000,
          },
        },
      },
      tempDir,
      eventStore,
    );

    expect(result.success).toBe(true);

    const events = await readStreamJsonl(stream);
    const disbanded = events.find((e) => e.type === 'team.disbanded');
    expect(disbanded).toBeDefined();
    const data = disbanded!.data as Record<string, unknown>;
    expect(data.tasksCompleted).toBe(3);
    expect(data.tasksFailed).toBe(0);
    expect(data.totalDurationMs).toBe(1000);
    expect(data.teamId).toBe(teamId);
  });

  /**
   * Each stream holds 2 `task.completed` events. The caller sends 0, 999 or no
   * tally, and the stored count must be 2 each time.
   */
  it('handleEventAppend_teamDisbanded_supplyAgnosticTallyIgnored', async () => {
    const cases: Array<{ stream: string; supplied: number | undefined }> = [
      { stream: 'parent-stream-c11-2a', supplied: 0 },
      { stream: 'parent-stream-c11-2b', supplied: 999 },
      { stream: 'parent-stream-c11-2c', supplied: undefined },
    ];

    for (const { stream, supplied } of cases) {
      const teamId = `team-${stream}`;
      await seedTaskCompleted(stream, teamId, ['x-1', 'x-2']);

      const data: Record<string, unknown> = {
        teamId,
        tasksFailed: 0,
        totalDurationMs: 500,
      };
      if (supplied !== undefined) {
        data.tasksCompleted = supplied;
      }

      const result = await handleEventAppend(
        {
          stream,
          event: { type: 'team.disbanded', data },
        },
        tempDir,
        eventStore,
      );
      expect(result.success).toBe(true);

      const events = await readStreamJsonl(stream);
      const disbanded = events.find((e) => e.type === 'team.disbanded');
      expect(disbanded).toBeDefined();
      const persisted = disbanded!.data as Record<string, unknown>;
      expect(persisted.tasksCompleted).toBe(2);
    }
  });

  /** Only `team.disbanded` gets a new count. Other event types must keep the data from the caller. */
  it('handleEventAppend_nonDisbandedTypes_unchanged', async () => {
    const stream = 'parent-stream-c11-3';

    const taskRes = await handleEventAppend(
      {
        stream,
        event: {
          type: 'task.completed',
          data: { taskId: 'pinning-task', verified: true },
        },
      },
      tempDir,
      eventStore,
    );
    expect(taskRes.success).toBe(true);

    const wfRes = await handleEventAppend(
      {
        stream,
        event: {
          type: 'workflow.started',
          data: { featureId: 'pinning-feat', workflowType: 'feature' },
        },
      },
      tempDir,
      eventStore,
    );
    expect(wfRes.success).toBe(true);

    const events = await readStreamJsonl(stream);
    const taskCompleted = events.find((e) => e.type === 'task.completed');
    expect(taskCompleted).toBeDefined();
    const taskData = taskCompleted!.data as Record<string, unknown>;
    expect(taskData.verified).toBe(true);

    const workflowStarted = events.find((e) => e.type === 'workflow.started');
    expect(workflowStarted).toBeDefined();
    const wfData = workflowStarted!.data as Record<string, unknown>;
    expect(wfData.featureId).toBe('pinning-feat');
  });
});

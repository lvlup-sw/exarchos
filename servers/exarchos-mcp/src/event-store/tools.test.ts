import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fc } from '@fast-check/vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from './store.js';
import { AtomicAppender } from './atomic-appender.js';
import {
  handleEventAppend,
  handleEventQuery,
  handleBatchAppend,
  EVENT_QUERY_DEFAULT_LIMIT,
  type EventQueryPage,
} from './tools.js';
import type { EventAck, ToolResult } from '../format.js';
import { runWithDispatchContext } from '../dispatch/dispatch-context.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { estimateOutputTokens } from '../core/economy.js';

// DR-5: `event query` returns `{ events, page }`. These helpers unwrap that
// envelope so a shape change surfaces in exactly one place per accessor.
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

// ─── Misplaced Event Fields Detection ────────────────────────────────────────

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
          { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' } },
          { type: 'task.assigned', data: { taskId: 't2', title: 'Task t2' } },
          { type: 'task.assigned', data: { taskId: 't3', title: 'Task t3' } },
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
    // Only 1 event should be appended — the second is a duplicate
    expect(sequences).toHaveLength(1);

    // Verify only 1 event in stream
    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    expect(queryEvents(queryResult)).toHaveLength(1);
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
          { type: 'task.assigned', data: { taskId: 't1', title: 'Task t1' } },
          { type: 'INVALID_TYPE_DOES_NOT_EXIST' as string, data: {} },
          { type: 'task.assigned', data: { taskId: 't3', title: 'Task t3' } },
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
    expect(queryEvents(queryResult)).toHaveLength(1);
  });

  // ─── Cache-hit out-of-bounds (Sentry comment 3205861163) ─────────────────
  //
  // A batch retry that reuses the same per-event idempotencyKey but submits
  // FEWER events than the originally-cached batch must not crash on
  // out-of-bounds access of validatedEvents[i]. Cache-hit returns the
  // ORIGINAL persisted batch (longer than current request).

  it('batchAppend_cacheHitWithFewerCurrentEvents_returnsOriginalBatchWithoutCrash', async () => {
    const store = new EventStore(tempDir);

    // Original commit: 3 events, all sharing one idempotencyKey so the
    // batch derives that as the batchIdempotencyKey.
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

    // Retry with FEWER events but same shared key. Pre-fix this would
    // crash (TypeError: cannot read properties of undefined) because
    // result.sequences had 3 entries but validatedEvents (post intra-
    // batch dedup) had only 1. Post-fix: the cache-hit branch reads
    // type from persistedEvents[i].type instead.
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
    // Returns the ORIGINAL committed batch, not the truncated retry.
    expect(acks.length).toBeGreaterThanOrEqual(1);
    expect(acks[0].sequence).toBe(1);
  });

  it('batchAppend_ConcurrentWrite_RespectsStreamLock', async () => {
    // Arrange: two concurrent batch appends on the same stream
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

    // Act: run both concurrently
    const [result1, result2] = await Promise.all([batch1, batch2]);

    // Assert: both succeed
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    // Total 6 events, with sequential sequence numbers (no gaps, no interleaving)
    const queryResult = await handleEventQuery({ stream: 'my-workflow' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    const events = queryEvents(queryResult) as Array<{ sequence: number; type: string }>;
    expect(events).toHaveLength(6);

    // Verify sequential numbering (order-independent: DR-5 returns newest-first,
    // so sort before asserting the 1..6 no-gap invariant this test pins).
    const seqs = events.map((e) => e.sequence).sort((a, b) => a - b);
    for (let i = 0; i < seqs.length; i++) {
      expect(seqs[i]).toBe(i + 1);
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

  // ─── C2: AtomicAppender migration regression tests ────────────────────────

  it('handleEventBatchAppend_appenderFails_returnsStructuredErrorNotSilentSuccess', async () => {
    // #1228 regression: when the underlying appender returns a structured
    // failure, the handler MUST NOT swallow it into `{success: true}`. The
    // four-phase legacy path could silently lose the partial-write failure
    // mode that AtomicAppender now surfaces explicitly.
    //
    // Inject a failure by spying on AtomicAppender.prototype.append. The post-
    // migration handler obtains its appender via the EventStore wiring, so a
    // prototype spy intercepts it regardless of where it's instantiated.
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

      // Must surface a structured error envelope, not silent success.
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error!.code).toBe('BATCH_APPEND_FAILED');
      // The cause's message must propagate to the caller (observability).
      expect(result.error!.message).toContain('simulated jsonl write failure');

      // No events landed in the stream.
      const queryResult = await handleEventQuery({ stream: 'failure-test' }, tempDir, eventStore);
      expect(queryResult.success).toBe(true);
      expect(queryEvents(queryResult)).toHaveLength(0);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it('handleEventBatchAppend_concurrentCalls_noDuplicateSequences', async () => {
    // #1230 regression: many concurrent handler calls must produce events with
    // disjoint sequence numbers in the resulting stream — no two events share
    // a sequence, and the persisted set is exactly 1..(2*N).
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

    // Sequence numbers returned to handlers must all be unique.
    const allSeqs: number[] = [];
    for (const r of results) {
      const acks = r.data as EventAck[];
      for (const ack of acks) {
        allSeqs.push(ack.sequence);
      }
    }
    const uniqueSeqs = new Set(allSeqs);
    expect(uniqueSeqs.size).toBe(allSeqs.length);

    // Stream-level invariant: 2*N events, sequences 1..2*N exactly.
    const queryResult = await handleEventQuery({ stream: 'concurrent-test' }, tempDir, eventStore);
    expect(queryResult.success).toBe(true);
    const events = queryEvents(queryResult) as Array<{ sequence: number }>;
    expect(events).toHaveLength(2 * N);
    const persistedSeqs = events.map(e => e.sequence).sort((a, b) => a - b);
    for (let i = 0; i < persistedSeqs.length; i++) {
      expect(persistedSeqs[i]).toBe(i + 1);
    }
  });

  it('batchAppend_MixedKeysAcrossBatches_NoCrossBatchDedup', async () => {
    // C10 polish: pin the cross-batch idempotency divergence documented at
    // tools.ts:295-309. When events in a batch carry distinct per-event
    // idempotencyKeys, the handler synthesizes a fresh `batch:<uuid>`
    // idempotencyKey for the AtomicAppender. Resubmitting the SAME logical
    // batch a second time gets a DIFFERENT synthesized key, so cross-batch
    // dedup is intentionally not preserved — both batches land in the stream.
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

    // Resubmit the IDENTICAL batch payload (same per-event keys, same data).
    const second = await handleBatchAppend(
      { stream: 'mixed-keys-test', events: batchEvents },
      tempDir,
      eventStore,
    );
    expect(second.success).toBe(true);
    // Documented divergence: NOT deduped against the first batch — fresh events.
    expect((second.data as EventAck[]).length).toBe(2);

    // Sequences from the second batch must be strictly greater than first.
    const firstSeqs = (first.data as EventAck[]).map(a => a.sequence);
    const secondSeqs = (second.data as EventAck[]).map(a => a.sequence);
    expect(Math.min(...secondSeqs)).toBeGreaterThan(Math.max(...firstSeqs));

    // The stream contains 4 distinct events — no cross-batch dedup occurred.
    const queryResult = await handleEventQuery(
      { stream: 'mixed-keys-test' },
      tempDir,
      eventStore,
    );
    expect(queryResult.success).toBe(true);
    expect(queryEvents(queryResult)).toHaveLength(4);
  });

  // ─── F2 regression (#1414): batchAppend cache-hit returns operationId ─────
  //
  // Inline fix lives at store.ts:467-471 (the `#1291 — three-field
  // correlation passthrough` block). When a retried batch hits the
  // idempotency cache, the returned events MUST surface the
  // originally-stamped operationId — NOT the current caller's dispatch
  // context (or undefined, if the retry happened outside any dispatch).
  //
  // This locks in the inline fix that #1428's post-merge hardening landed.
  it('BatchAppend_CacheHit_ReturnsOperationId', async () => {
    const store = new EventStore(tempDir);

    // First write inside dispatch scope `op-xyz` — writer-path stamping
    // (covered by Wave B1 #1428) attaches operationId to the persisted event.
    const first = await runWithDispatchContext(
      { operationId: 'op-xyz', correlationId: 'cor-xyz' },
      () =>
        store.batchAppend('s1', [
          { type: 'task.assigned', idempotencyKey: 'k1', data: { taskId: 't1', title: 'Task t1' } },
        ]),
    );
    expect(first[0].operationId).toBe('op-xyz');

    // Retry the SAME batch key WITHOUT any active dispatch context. The
    // appender hits the idempotency cache; the cache-hit branch must
    // return the ORIGINAL operationId (`op-xyz`), not undefined or any
    // value derived from the second caller's (absent) context.
    const replay = await store.batchAppend('s1', [
      { type: 'task.assigned', idempotencyKey: 'k1', data: { taskId: 't1', title: 'Task t1' } },
    ]);
    expect(replay[0].operationId).toBe('op-xyz');
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
    const events = queryEvents(query);
    expect(events).toHaveLength(1);
    expect(events[0].tenantId).toBe('tenant-abc');
    expect(events[0].organizationId).toBe('org-xyz');
  });

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
    // Look up by taskId (order-independent: DR-5 returns newest-first).
    const byTask = (id: string) =>
      events.find((e) => (e.data as Record<string, unknown> | undefined)?.taskId === id)!;
    expect(byTask('t1').tenantId).toBe('tenant-1');
    expect(byTask('t1').organizationId).toBe('org-1');
    expect(byTask('t2').tenantId).toBe('tenant-1');
    expect(byTask('t2').organizationId).toBeUndefined();
  });
});

// ─── DR-5: `event query` default limit + page metadata ──────────────────────
//
// Default queries cap at the 20 NEWEST events plus `page:{total,offset,limit,
// hasMore}` so unbounded stream reads stop dominating the session token budget
// (audit: 5,755 tokens unbounded vs 1,490 at limit 20 on a 112-event stream).
// Explicit `limit`/`offset` retains full history access and pages through a
// deterministic newest-first ordering with no gaps and no duplicates.

describe('handleEventQuery DR-5 default limit + page metadata', () => {
  let propStreamCounter = 0;

  /** Seed sequences 1..count on `stream` in a single batch (fast + ordered). */
  async function seed(stream: string, count: number): Promise<void> {
    const events = Array.from({ length: count }, (_, i) => ({
      type: 'task.assigned' as const,
      data: { taskId: `t${i + 1}`, title: `Task t${i + 1}` },
    }));
    const result = await handleBatchAppend({ stream, events }, tempDir, eventStore);
    expect(result.success).toBe(true);
  }

  it('eventQuery_DefaultLimitOn112EventStream_StaysUnderTokenBudget', async () => {
    // DR-5 acceptance asserted DIRECTLY (review LOW): the default query on a
    // 112-event stream stays within the ~1,600-token budget the acceptance
    // criterion names — not merely inferred from the limit-20 mechanism — while
    // `page.hasMore` keeps the hidden older history perceivable. Pins the token
    // outcome the same way the DR-2 / DR-8 budget tests pin theirs.
    await seed('dr5-budget', 112);
    const result = await handleEventQuery({ stream: 'dr5-budget' }, tempDir, eventStore);
    expect(result.success).toBe(true);
    expect(estimateOutputTokens(result.data)).toBeLessThanOrEqual(1600);
    expect(queryPage(result)).toMatchObject({ hasMore: true, total: 112 });
  });

  it('eventQuery_NoLimit_Returns20NewestWithPageMetadata', async () => {
    const TOTAL = 25; // > EVENT_QUERY_DEFAULT_LIMIT so older history is hidden
    await seed('dr5-default', TOTAL);

    const result = await handleEventQuery({ stream: 'dr5-default' }, tempDir, eventStore);
    expect(result.success).toBe(true);

    const events = queryEvents(result) as Array<{ sequence: number }>;
    const page = queryPage(result);

    // Exactly the 20 newest, newest-first.
    expect(events).toHaveLength(EVENT_QUERY_DEFAULT_LIMIT);
    const seqs = events.map((e) => e.sequence);
    expect(seqs[0]).toBe(TOTAL); // newest at index 0
    expect(seqs[EVENT_QUERY_DEFAULT_LIMIT - 1]).toBe(TOTAL - EVENT_QUERY_DEFAULT_LIMIT + 1);
    // Strictly descending (deterministic, stable ordering).
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    // The returned set is precisely sequences 6..25 (the 20 newest).
    expect(new Set(seqs)).toEqual(
      new Set(Array.from({ length: EVENT_QUERY_DEFAULT_LIMIT }, (_, i) => TOTAL - i)),
    );

    // Page metadata makes the hidden older history perceivable.
    expect(page).toEqual({
      total: TOTAL,
      offset: 0,
      limit: EVENT_QUERY_DEFAULT_LIMIT,
      hasMore: true,
    });
  });

  it('eventQuery_UnderDefault_ReturnsAllWithHasMoreFalse', async () => {
    // A stream at/under the default returns everything, hasMore false — the
    // boundary the token-economy default must not truncate.
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
    // "Unbounded only by explicit request": a large explicit limit returns the
    // entire stream even past the default cap.
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

  it('eventQuery_OffsetPaging_CoversFullStreamDeterministically', async () => {
    // Property: paging with an explicit limit/offset partitions the full stream
    // exactly once — no gaps, no duplicates — regardless of total and page size.
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }), // total events in the stream
        fc.integer({ min: 1, max: 12 }), // explicit page size
        async (total, pageSize) => {
          const stream = `dr5-prop-${propStreamCounter++}`;
          await seed(stream, total);

          const seen: number[] = [];
          let offset = 0;
          // Correct pager terminates in ceil(total/pageSize) steps; the guard is
          // a defensive upper bound against a non-terminating (buggy) window.
          for (let guard = 0; guard <= total + 1; guard++) {
            const result = await handleEventQuery(
              { stream, limit: pageSize, offset },
              tempDir,
              eventStore,
            );
            expect(result.success).toBe(true);
            const events = queryEvents(result) as Array<{ sequence: number }>;
            const page = queryPage(result);

            // page.total is stable and echoes the paging inputs.
            expect(page.total).toBe(total);
            expect(page.limit).toBe(pageSize);
            expect(page.offset).toBe(offset);
            // hasMore is exactly "rows remain beyond this page".
            expect(page.hasMore).toBe(offset + events.length < total);

            for (const e of events) seen.push(e.sequence);

            if (!page.hasMore) break;
            // A non-final page must be full — no premature short page (would
            // create a gap and break the partition).
            expect(events).toHaveLength(pageSize);
            offset += pageSize;
          }

          // Partition invariant: sequences 1..total each appear exactly once.
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
    // Same window queried twice yields byte-identical results (stable ordering).
    await seed('dr5-stable', 30);
    const a = await handleEventQuery({ stream: 'dr5-stable', limit: 7, offset: 10 }, tempDir, eventStore);
    const b = await handleEventQuery({ stream: 'dr5-stable', limit: 7, offset: 10 }, tempDir, eventStore);
    expect(queryEvents(a)).toEqual(queryEvents(b));
    expect(queryPage(a)).toEqual(queryPage(b));
  });
});

// ─── C11: SubagentStreamRouter wiring on team.disbanded (#1224) ─────────────
//
// `handleEventAppend` MUST intercept `team.disbanded` events and route them
// through `SubagentStreamRouter.emitDisbanded`. The router queries the parent
// stream for the actual `task.completed` count scoped to the team and writes
// the corrected event — discarding any agent-supplied `tasksCompleted` value.
// This closes #1224 at the consumer level: the off-by-N bug originates in the
// agent-side in-memory tally; the server is now the single source of truth.

describe('handleEventAppend team.disbanded routing (C11, #1224)', () => {
  /**
   * Helper: seed the parent stream with N task.completed events for a given
   * team via `handleEventAppend`. The router scans the parent JSONL and
   * counts entries whose `data.teamId` matches.
   */
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

  /**
   * Read all events from a parent stream via the durable substrate.
   *
   * (Pre-v2.11 this scanned the JSONL fixture directly. Post substrate-cut
   * the SQLite backend is the source of truth, so the function name is
   * historical — kept to minimise diff churn — but the implementation
   * goes through `EventStore.query`.)
   */
  async function readStreamJsonl(stream: string): Promise<Array<Record<string, unknown>>> {
    const events = await eventStore.query(stream);
    return events.map((e) => e as unknown as Record<string, unknown>);
  }

  it('handleEventAppend_teamDisbanded_recomputesTasksCompleted', async () => {
    const stream = 'parent-stream-c11-1';
    const teamId = 'team-alpha';

    // Seed parent stream with 3 task.completed events for the team.
    await seedTaskCompleted(stream, teamId, ['t-1', 't-2', 't-3']);

    // Caller supplies a wildly wrong tasksCompleted (the #1224 regression).
    const result = await handleEventAppend(
      {
        stream,
        event: {
          type: 'team.disbanded',
          data: {
            teamId,
            tasksCompleted: 999, // caller-supplied tally — MUST be overridden
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
    // The router queried the parent stream and recomputed tasksCompleted = 3,
    // overriding the 999 the caller supplied.
    expect(data.tasksCompleted).toBe(3);
    expect(data.tasksFailed).toBe(0);
    expect(data.totalDurationMs).toBe(1000);
    expect(data.teamId).toBe(teamId);
  });

  it('handleEventAppend_teamDisbanded_supplyAgnosticTallyIgnored', async () => {
    // Three independent streams — each with the same N task.completed events —
    // but the caller passes a different (wrong) tasksCompleted in each call.
    // All three persisted events MUST report the same recomputed value (2).
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
      // Recomputed from parent-stream task.completed query — always 2 here.
      expect(persisted.tasksCompleted).toBe(2);
    }
  });

  it('handleEventAppend_nonDisbandedTypes_unchanged', async () => {
    // Pinning regression: the interception MUST only fire for type ===
    // 'team.disbanded'. Other event types follow the legacy `appendValidated`
    // path and persist whatever the caller supplied.
    const stream = 'parent-stream-c11-3';

    // task.completed should NOT be intercepted — caller's data is preserved.
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

    // workflow.started should NOT be intercepted.
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

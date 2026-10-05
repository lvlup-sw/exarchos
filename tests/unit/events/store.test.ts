import { describe, it, expect, beforeEach, afterEach, assertType } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fc } from '@fast-check/vitest';
import { EventStore, SequenceConflictError, type QueryFilters } from '../../../src/events/store.js';
import { runWithAppendObserver } from '../../../src/events/observation/append-observation.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-store-test-'));
});

afterEach(async () => {
  await rmrfAsync(tempDir);
});

describe('EventStore Append', () => {
  it('should append a single event with sequence 1', async () => {
    const store = new EventStore(tempDir);

    const event = await store.append('my-workflow', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    expect(event.streamId).toBe('my-workflow');
    expect(event.sequence).toBe(1);
    expect(event.type).toBe('workflow.started');

    const stored = await store.query('my-workflow');
    expect(stored).toHaveLength(1);
    expect(stored[0].streamId).toBe('my-workflow');
    expect(stored[0].sequence).toBe(1);
  });

  it('should auto-increment sequence numbers', async () => {
    const store = new EventStore(tempDir);

    const e1 = await store.append('my-workflow', { type: 'workflow.started' });
    const e2 = await store.append('my-workflow', { type: 'task.assigned' });
    const e3 = await store.append('my-workflow', { type: 'workflow.transition' });

    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
    expect(e3.sequence).toBe(3);

    const stored = await store.query('my-workflow');
    expect(stored).toHaveLength(3);
  });

  it('should set timestamp if missing', async () => {
    const store = new EventStore(tempDir);
    const before = new Date().toISOString();

    const event = await store.append('my-workflow', {
      type: 'workflow.started',
    });

    const after = new Date().toISOString();
    expect(event.timestamp).toBeDefined();
    expect(event.timestamp >= before).toBe(true);
    expect(event.timestamp <= after).toBe(true);
  });

  it('should persist first append to nonexistent stream', async () => {
    const store = new EventStore(tempDir);

    const before = await store.query('new-stream');
    expect(before).toEqual([]);

    await store.append('new-stream', { type: 'task.assigned' });

    const after = await store.query('new-stream');
    expect(after).toHaveLength(1);
    expect(after[0].streamId).toBe('new-stream');
  });

  /** A second store on the same directory simulates a restart. Its first append continues at sequence 3. */
  it('should initialize sequence from existing file', async () => {
    const store1 = new EventStore(tempDir);
    await store1.append('my-workflow', { type: 'workflow.started' });
    await store1.append('my-workflow', { type: 'task.assigned' });

    const store2 = new EventStore(tempDir);
    const event = await store2.append('my-workflow', { type: 'workflow.transition' });

    expect(event.sequence).toBe(3);
  });

  it('should handle multiple independent streams', async () => {
    const store = new EventStore(tempDir);

    const a1 = await store.append('stream-a', { type: 'workflow.started' });
    const b1 = await store.append('stream-b', { type: 'workflow.started' });
    const a2 = await store.append('stream-a', { type: 'task.assigned' });
    const b2 = await store.append('stream-b', { type: 'task.assigned' });

    expect(a1.sequence).toBe(1);
    expect(b1.sequence).toBe(1);
    expect(a2.sequence).toBe(2);
    expect(b2.sequence).toBe(2);
  });

  it('should preserve provided timestamp', async () => {
    const store = new EventStore(tempDir);
    const fixedTime = '2025-01-15T10:00:00.000Z';

    const event = await store.append('my-workflow', {
      type: 'workflow.started',
      timestamp: fixedTime,
    });

    expect(event.timestamp).toBe(fixedTime);
  });

  it('should set schemaVersion default', async () => {
    const store = new EventStore(tempDir);

    const event = await store.append('my-workflow', {
      type: 'workflow.started',
    });

    expect(event.schemaVersion).toBe('1.0');
  });
});

describe('EventStore Query', () => {
  it('should return all events when no filters', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.transition' });
    await store.append('my-workflow', { type: 'task.claimed' });
    await store.append('my-workflow', { type: 'task.progressed' });

    const events = await store.query('my-workflow');
    expect(events).toHaveLength(5);
    expect(events[0].sequence).toBe(1);
    expect(events[4].sequence).toBe(5);
  });

  it('should filter by event type', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.completed' });

    const events = await store.query('my-workflow', { type: 'workflow.started' });
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === 'workflow.started')).toBe(true);
  });

  it('should filter by sinceSequence', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.transition' });
    await store.append('my-workflow', { type: 'task.claimed' });
    await store.append('my-workflow', { type: 'task.progressed' });

    const events = await store.query('my-workflow', { sinceSequence: 3 });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(4);
    expect(events[1].sequence).toBe(5);
  });

  it('should filter by time range', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', {
      type: 'stack.enqueued',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    await store.append('my-workflow', {
      type: 'task.assigned',
      timestamp: '2025-06-15T00:00:00.000Z',
    });
    await store.append('my-workflow', {
      type: 'task.completed',
      timestamp: '2025-12-31T00:00:00.000Z',
    });

    const events = await store.query('my-workflow', {
      since: '2025-03-01T00:00:00.000Z',
      until: '2025-09-01T00:00:00.000Z',
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task.assigned');
  });

  it('should return empty array for nonexistent stream', async () => {
    const store = new EventStore(tempDir);
    const events = await store.query('nonexistent');
    expect(events).toEqual([]);
  });

  it('should combine multiple filters', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', {
      type: 'task.completed',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    await store.append('my-workflow', {
      type: 'task.completed',
      timestamp: '2025-06-15T00:00:00.000Z',
    });
    await store.append('my-workflow', {
      type: 'task.failed',
      timestamp: '2025-06-15T00:00:00.000Z',
    });
    await store.append('my-workflow', {
      type: 'task.completed',
      timestamp: '2025-12-31T00:00:00.000Z',
    });

    const events = await store.query('my-workflow', {
      type: 'task.completed',
      since: '2025-03-01T00:00:00.000Z',
    });
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === 'task.completed')).toBe(true);
  });
});

describe('EventStore queryByType with streamPrefix (T25)', () => {
  /**
   * The query returns the parent stream and its `<prefix>/<segment>` descendants.
   * It excludes another feature and another event type on a matching stream.
   */
  it('EventStore_QueryByTypeWithStreamPrefix_ReturnsAllMatchingDescendantStreams', async () => {
    const store = new EventStore(tempDir);
    const featureId = 'feat-cross-1';
    const subA = `${featureId}/subagent-a`;
    const subB = `${featureId}/subagent-b`;
    const otherFeature = 'feat-other';

    await store.append(subA, {
      type: 'task.completed',
      data: { taskId: 'a-1', teamId: 'team-x' },
    });
    await store.append(subB, {
      type: 'task.completed',
      data: { taskId: 'b-1', teamId: 'team-x' },
    });
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'parent-1', teamId: 'team-x' },
    });
    await store.append(otherFeature, {
      type: 'task.completed',
      data: { taskId: 'other-1', teamId: 'team-x' },
    });
    await store.append(subA, {
      type: 'task.assigned',
      data: { taskId: 'a-2', teammateName: 'worker-a' },
    });

    const events = await store.queryByType('task.completed', {
      streamPrefix: featureId,
    });

    expect(events).toHaveLength(3);
    const taskIds = events.map((e) => (e.data as { taskId?: string })?.taskId).sort();
    expect(taskIds).toEqual(['a-1', 'b-1', 'parent-1']);
    for (const event of events) {
      const isParent = event.streamId === featureId;
      const isDescendant = event.streamId.startsWith(`${featureId}/`);
      expect(isParent || isDescendant).toBe(true);
    }
  });

  /**
   * The stream `feat-cross-1-extra` holds the prefix as a substring but is not a `<prefix>/` descendant.
   * The query must exclude it.
   */
  it('EventStore_QueryByTypeWithStreamPrefix_ExcludesAccidentalSubstringMatches', async () => {
    const store = new EventStore(tempDir);
    const featureId = 'feat-cross-1';
    const lookalike = `${featureId}-extra`;

    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'parent-1', teamId: 'team-x' },
    });
    await store.append(lookalike, {
      type: 'task.completed',
      data: { taskId: 'lookalike-1', teamId: 'team-x' },
    });

    const events = await store.queryByType('task.completed', {
      streamPrefix: featureId,
    });
    expect(events).toHaveLength(1);
    expect((events[0].data as { taskId?: string })?.taskId).toBe('parent-1');
  });

  it('EventStore_QueryByTypeWithStreamPrefix_NoMatchingStreams_ReturnsEmpty', async () => {
    const store = new EventStore(tempDir);
    const events = await store.queryByType('task.completed', {
      streamPrefix: 'no-such-feature',
    });
    expect(events).toEqual([]);
  });
});

/** `expectedSequence` is the sequence that the caller expects at the stream tail before the append. */
describe('EventStore Optimistic Concurrency', () => {
  it('should accept append with correct expectedSequence', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });

    const event = await store.append(
      'my-workflow',
      { type: 'workflow.transition' },
      { expectedSequence: 2 },
    );
    expect(event.sequence).toBe(3);
  });

  it('should reject append with stale expectedSequence', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });

    await expect(
      store.append('my-workflow', { type: 'workflow.transition' }, { expectedSequence: 1 }),
    ).rejects.toThrow(SequenceConflictError);
  });

  it('should detect conflict between two store instances', async () => {
    const store1 = new EventStore(tempDir);
    const store2 = new EventStore(tempDir);

    await store1.append('my-workflow', { type: 'workflow.started' });

    await expect(
      store2.append('my-workflow', { type: 'task.progressed' }, { expectedSequence: 0 }),
    ).rejects.toThrow(SequenceConflictError);
  });

  it('should allow refreshSequence to recover from conflict', async () => {
    const store1 = new EventStore(tempDir);
    const store2 = new EventStore(tempDir);

    await store1.append('my-workflow', { type: 'workflow.started' });

    await store2.refreshSequence('my-workflow');

    const event = await store2.append(
      'my-workflow',
      { type: 'task.assigned' },
      { expectedSequence: 1 },
    );
    expect(event.sequence).toBe(2);
  });

  it('SequenceConflictError should contain expected and actual', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.transition' });

    try {
      await store.append('my-workflow', { type: 'task.claimed' }, { expectedSequence: 1 });
      expect.unreachable('Expected SequenceConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(SequenceConflictError);
      const conflict = err as SequenceConflictError;
      expect(conflict.expected).toBe(1);
      expect(conflict.actual).toBe(3);
    }
  });
});

describe('EventStore Query Pagination', () => {
  it('query_WithLimit_ReturnsLimitedResults', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 10; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { limit: 3 });
    expect(events).toHaveLength(3);
  });

  it('query_WithOffset_SkipsEvents', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 5; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { offset: 2 });
    expect(events).toHaveLength(3);
    expect(events[0].sequence).toBe(3);
  });

  it('query_WithLimitAndOffset_ReturnsPaginatedResults', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 10; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { limit: 3, offset: 2 });
    expect(events).toHaveLength(3);
    expect(events[0].sequence).toBe(3);
    expect(events[1].sequence).toBe(4);
    expect(events[2].sequence).toBe(5);
  });

  it('query_DefaultLimit_Returns50Events', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 60; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow');
    expect(events).toHaveLength(60);
  });

  it('query_WithFilters_NoDefaultLimit', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 60; i++) {
      await store.append('my-workflow', { type: 'workflow.started' });
    }

    const events = await store.query('my-workflow', { type: 'workflow.started' });
    expect(events).toHaveLength(60);
  });

  it('query_LimitExceedsTotal_ReturnsAll', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 3; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { limit: 100 });
    expect(events).toHaveLength(3);
  });
});

describe('EventStore Streaming Query', () => {
  it('query_WithSinceSequence_ReturnsOnlyLaterEvents', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 10; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { sinceSequence: 7 });
    expect(events).toHaveLength(3);
    expect(events[0].sequence).toBe(8);
    expect(events[1].sequence).toBe(9);
    expect(events[2].sequence).toBe(10);
  });

  it('query_WithSinceSequenceAndLimit_CombinesFilters', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 10; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { sinceSequence: 5, limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(6);
    expect(events[1].sequence).toBe(7);
  });

  it('query_WithTypeFilterAndLimit_CombinesCorrectly', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });

    const events = await store.query('my-workflow', { type: 'task.assigned', limit: 2 });
    expect(events).toHaveLength(2);
    expect(events.every(e => e.type === 'task.assigned')).toBe(true);
    expect(events[0].sequence).toBe(2);
    expect(events[1].sequence).toBe(4);
  });

  /** `sinceSequence: 3` leaves sequences 4 to 6, the type filter leaves 4 and 6, and `limit: 1` leaves 4. */
  it('query_WithSinceSequenceAndTypeAndLimit_CombinesAllFilters', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });

    const events = await store.query('my-workflow', {
      sinceSequence: 3,
      type: 'task.assigned',
      limit: 1,
    });
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(4);
    expect(events[0].type).toBe('task.assigned');
  });

  it('query_WithOffsetAndLimit_InStreamingMode', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 10; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { offset: 3, limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(4);
    expect(events[1].sequence).toBe(5);
  });

  it('query_EmptyFile_ReturnsEmpty', async () => {
    const store = new EventStore(tempDir);
    const filePath = path.join(tempDir, 'empty-stream.events.jsonl');
    await fs.writeFile(filePath, '', 'utf-8');

    const events = await store.query('empty-stream');
    expect(events).toEqual([]);
  });
});

describe('EventStore Query Fast-Skip', () => {
  it('query_WithSinceSequence_ReturnsOnlyNewerEvents', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 100; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { sinceSequence: 90 });
    expect(events).toHaveLength(10);
    expect(events[0].sequence).toBe(91);
    expect(events[9].sequence).toBe(100);
  });

  it('query_WithSinceSequenceAndLimit_CombinesCorrectly', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 100; i++) {
      await store.append('my-workflow', { type: 'task.assigned' });
    }

    const events = await store.query('my-workflow', { sinceSequence: 90, limit: 5 });
    expect(events).toHaveLength(5);
    expect(events[0].sequence).toBe(91);
    expect(events[4].sequence).toBe(95);
  });

  /** An even `i` gives `task.claimed` at an odd sequence. The odd sequences from 51 to 99 hold 25 events. */
  it('query_WithSinceSequenceAndType_FallsBackToFullParse', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 100; i++) {
      const type = i % 2 === 0 ? 'task.claimed' : 'task.assigned';
      await store.append('my-workflow', { type });
    }

    const events = await store.query('my-workflow', {
      sinceSequence: 50,
      type: 'task.claimed',
    });
    expect(events).toHaveLength(25);
    expect(events.every(e => e.type === 'task.claimed')).toBe(true);
    expect(events[0].sequence).toBe(51);
  });
});

describe('EventStore Append Idempotency', () => {
  it('append_WithIdempotencyKey_DeduplicatesRetry', async () => {
    const store = new EventStore(tempDir);

    const first = await store.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'claim-1' },
    );
    const second = await store.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'claim-1' },
    );

    expect(second.sequence).toBe(first.sequence);
    expect(second.streamId).toBe(first.streamId);

    const events = await store.query('my-workflow');
    expect(events).toHaveLength(1);
  });

  it('append_WithDifferentKeys_BothSucceed', async () => {
    const store = new EventStore(tempDir);

    const a = await store.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'a' },
    );
    const b = await store.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'b' },
    );

    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);

    const events = await store.query('my-workflow');
    expect(events).toHaveLength(2);
  });

  it('append_WithoutKey_NoDedupe', async () => {
    const store = new EventStore(tempDir);

    await store.append('my-workflow', { type: 'task.claimed' });
    await store.append('my-workflow', { type: 'task.claimed' });

    const events = await store.query('my-workflow');
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
  });

  /**
   * Each claim persists in `idempotency_claims` with no cap.
   * A retry of the first of 201 keys returns its original sequence.
   */
  it('append_IdempotencyClaim_PersistsAcrossManyAppends', async () => {
    const store = new EventStore(tempDir);

    for (let i = 0; i < 201; i++) {
      await store.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: `key-${i}` },
      );
    }

    const retried = await store.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-0' },
    );
    expect(retried.sequence).toBe(1);

    const events = await store.query('my-workflow');
    expect(events).toHaveLength(201);
  });
});

describe('EventStore Query Sequence Pre-filter', () => {
  /** An even `i` gives `task.claimed` at an odd sequence. The odd sequences from 51 to 99 hold 25 events. */
  it('Query_WithSinceSequenceAndTypeFilter_ReturnsCorrectResults', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 100; i++) {
      const type = i % 2 === 0 ? 'task.claimed' : 'task.assigned';
      await store.append('my-workflow', { type });
    }

    const events = await store.query('my-workflow', {
      sinceSequence: 50,
      type: 'task.claimed',
    });
    expect(events).toHaveLength(25);
    expect(events.every(e => e.type === 'task.claimed')).toBe(true);
    expect(events.every(e => e.sequence > 50)).toBe(true);
  });

  /**
   * 1050 events make the sequences reach 4 digits. The test covers the sequence filter of the query, not the append path.
   * One `batchAppend` seeds the stream in one transaction, so the run time does not depend on the fsync speed of the host.
   * 1050 awaited appends took about 35 s on a Windows runner, which is more than the 30 s budget.
   * Each `i` with `i % 3 === 0` is `task.completed`. Sequences 1001 to 1050 hold 16 such events.
   */
  it('Query_SequenceRegex_HandlesMultiDigitSequences', async () => {
    const store = new EventStore(tempDir);
    await store.batchAppend(
      'my-workflow',
      Array.from({ length: 1050 }, (_, i) => ({
        type: i % 3 === 0 ? 'task.completed' : 'task.assigned',
      })),
    );

    const events = await store.query('my-workflow', {
      sinceSequence: 1000,
      type: 'task.completed',
    });

    expect(events.every(e => e.type === 'task.completed')).toBe(true);
    expect(events.every(e => e.sequence > 1000)).toBe(true);
    expect(events).toHaveLength(16);
  }, 30_000);
});

describe('EventStore Query with Event Migration', () => {
  it('Query_EventsAtCurrentVersion_ReturnedWithSchemaVersion', async () => {
    const store = new EventStore(tempDir);

    await store.append('migration-test', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    const events = await store.query('migration-test');

    expect(events).toHaveLength(1);
    expect(events[0].schemaVersion).toBe('1.0');
    expect(events[0].type).toBe('workflow.started');
  });

  /**
   * Each event is at version 1.0, so the migration is the identity.
   * The test asserts only that the event passes through `query`.
   */
  it('Query_AppliesMigrationTransform', async () => {
    const store = new EventStore(tempDir);

    await store.append('migration-transform', {
      type: 'task.assigned',
      data: { taskId: 'task-001', title: 'Test task' },
    });

    const events = await store.query('migration-transform');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task.assigned');
    expect(events[0].streamId).toBe('migration-transform');
  });
});

describe('EventStore appendValidated', () => {
  it('appendValidated_WritesEventWithoutZodParse', async () => {
    const store = new EventStore(tempDir);

    const prebuilt = {
      type: 'workflow.started' as const,
      data: { featureId: 'test' },
      streamId: '',
      sequence: 0,
      timestamp: '',
      schemaVersion: '1.0',
    };

    const event = await store.appendValidated('my-workflow', prebuilt, {});

    expect(event.streamId).toBe('my-workflow');
    expect(event.sequence).toBe(1);
    expect(event.type).toBe('workflow.started');
    expect(event.timestamp).toBeDefined();

    const stored = await store.query('my-workflow');
    expect(stored).toHaveLength(1);
    expect(stored[0].streamId).toBe('my-workflow');
    expect(stored[0].sequence).toBe(1);
  });

  it('appendValidated_RespectsIdempotencyKey', async () => {
    const store = new EventStore(tempDir);

    const prebuilt = {
      type: 'workflow.started' as const,
      data: { featureId: 'test' },
      streamId: '',
      sequence: 0,
      timestamp: '',
      schemaVersion: '1.0',
    };

    const first = await store.appendValidated('my-workflow', prebuilt, {
      idempotencyKey: 'dedup-key-1',
    });

    const second = await store.appendValidated('my-workflow', prebuilt, {
      idempotencyKey: 'dedup-key-1',
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(1);
    expect(second).toEqual(first);

    const stored = await store.query('my-workflow');
    expect(stored).toHaveLength(1);
  });

  /** A retry with the same idempotency key and a different payload must return the persisted event, not the retry payload. */
  it('append_idempotencyRetryWithDifferentPayload_returnsOriginallyPersisted', async () => {
    const store = new EventStore(tempDir);

    const first = await store.append(
      'my-workflow',
      { type: 'task.assigned', data: { payload: 'A' } },
      { idempotencyKey: 'shared-key' },
    );
    expect(first.sequence).toBe(1);
    expect((first.data as { payload: string }).payload).toBe('A');

    const retry = await store.append(
      'my-workflow',
      { type: 'task.assigned', data: { payload: 'B-DIFFERENT' } },
      { idempotencyKey: 'shared-key' },
    );
    expect(retry.sequence).toBe(1);
    expect((retry.data as { payload: string }).payload).toBe('A');

    const stored = await store.query('my-workflow');
    expect(stored).toHaveLength(1);
    expect((stored[0].data as { payload: string }).payload).toBe('A');
  });

  it('appendValidated_RespectsExpectedSequence', async () => {
    const store = new EventStore(tempDir);

    const prebuilt = {
      type: 'workflow.started' as const,
      streamId: '',
      sequence: 0,
      timestamp: '',
      schemaVersion: '1.0',
    };

    await store.appendValidated('my-workflow', prebuilt, {});

    const event = await store.appendValidated('my-workflow', prebuilt, {
      expectedSequence: 1,
    });
    expect(event.sequence).toBe(2);

    await expect(
      store.appendValidated('my-workflow', prebuilt, { expectedSequence: 1 }),
    ).rejects.toThrow(SequenceConflictError);
  });

  it('append_StillCallsZodParse_BackwardCompat', async () => {
    const store = new EventStore(tempDir);

    await expect(
      store.append('my-workflow', { type: 'invalid.type' }),
    ).rejects.toThrow();
  });
});

describe('EventStore.tailSequence', () => {
  /** An empty stream gives 0, not `undefined`, so a caller can compare the tail with a cached sequence by equality. */
  it('tailSequence_EmptyStream_ReturnsZero', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const tail = await store.tailSequence('never-written');
    expect(tail).toBe(0);
  });

  it('tailSequence_PopulatedStream_ReturnsHighestSequence', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();
    const streamId = 'populated-stream';

    await store.append(streamId, { type: 'workflow.started' });
    await store.append(streamId, { type: 'task.assigned' });
    await store.append(streamId, { type: 'workflow.transition' });

    const events = await store.query(streamId);
    const tail = await store.tailSequence(streamId);
    expect(tail).toBe(events.at(-1)!.sequence);
    expect(tail).toBe(3);
  });
});

describe('QueryFilters correlation tuple (Wave 4 / #1437)', () => {
  /**
   * `QueryFilters` accepts `operationId`, `correlationId` and `causationId`.
   * The type annotation and `assertType` are compile-time checks. The runtime part is a JSON round trip of the literal.
   */
  it('QueryFilters_AcceptsCorrelationTuple_TypeAndShape', () => {
    const filters: QueryFilters = {
      operationId: 'op-1',
      correlationId: 'c-1',
      causationId: 'ca-1',
    };
    assertType<QueryFilters>(filters);

    const roundTripped = JSON.parse(JSON.stringify(filters)) as QueryFilters;
    expect(roundTripped.operationId).toBe('op-1');
    expect(roundTripped.correlationId).toBe('c-1');
    expect(roundTripped.causationId).toBe('ca-1');
  });
});

/**
 * An observer learns about each event that landed, and about nothing else.
 * The seam can fail in three ways. It misses a real append, it reports a rejected or collapsed append,
 * or it leaks between two units of work that run concurrently.
 */
describe('EventStore append observation', () => {
  const yieldTick = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

  /**
   * Each write path notifies one time for each landed event. An append outside a scope notifies nobody.
   * The observer reads the row from the backend, which proves that the notification comes after persistence.
   */
  it('EventStore_SuccessfulNewAppend_NotifiesScopedObserver', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const unobserved = await store.append('quiet-stream', { type: 'workflow.started' });
    expect(unobserved.sequence).toBe(1);

    const seen: Array<{
      type: string;
      streamId: string;
      sequence: number;
      durableAtNotify: boolean;
    }> = [];

    await runWithAppendObserver(
      (observation) => {
        const durableAtNotify = store
          .getReadBackend()
          .queryEvents(observation.streamId)
          .some((event) => event.sequence === observation.sequence);
        seen.push({ ...observation, durableAtNotify });
      },
      async () => {
        await store.append('observed-stream', { type: 'workflow.started' });
        await store.appendValidated('observed-stream', {
          type: 'task.assigned' as const,
          streamId: '',
          sequence: 0,
          timestamp: '',
          schemaVersion: '1.0',
        });
        await store.batchAppend('observed-stream', [
          { type: 'task.claimed' },
          { type: 'task.progressed' },
        ]);
      },
    );

    expect(seen.map((s) => s.type)).toEqual([
      'workflow.started',
      'task.assigned',
      'task.claimed',
      'task.progressed',
    ]);
    expect(seen.map((s) => s.sequence)).toEqual([1, 2, 3, 4]);
    expect(seen.every((s) => s.streamId === 'observed-stream')).toBe(true);
    expect(seen.every((s) => s.durableAtNotify)).toBe(true);

    expect(seen.some((s) => s.streamId === 'quiet-stream')).toBe(false);

    store.close();
  });

  /**
   * Appends on each write path run outside a scope. They must not fail and must leave no observer state.
   * A scope that opens later sees only its own append.
   */
  it('EventStore_NoScopeInstalled_BurstOfAppendsNotifiesNothing', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    await store.append('unscoped-stream', { type: 'workflow.started' });
    await store.appendValidated('unscoped-stream', {
      type: 'task.assigned' as const,
      streamId: '',
      sequence: 0,
      timestamp: '',
      schemaVersion: '1.0',
    });
    await store.batchAppend('unscoped-stream', [
      { type: 'task.claimed' },
      { type: 'task.progressed' },
    ]);

    expect(await store.query('unscoped-stream')).toHaveLength(4);

    const seen: string[] = [];
    await runWithAppendObserver(
      (observation) => {
        seen.push(`${observation.streamId}#${observation.sequence}`);
      },
      async () => {
        await store.append('unscoped-stream', { type: 'task.progressed' });
      },
    );
    expect(seen).toEqual(['unscoped-stream#5']);

    store.close();
  });

  /**
   * One real append comes first, so the silence assertions have a denominator.
   * A schema rejection, a stale `expectedSequence`, and an idempotency retry on the single and batch paths must stay silent.
   * Three events land. The two rejections and the two retries add nothing.
   */
  it('EventStore_FailedOrCollapsedAppend_DoesNotNotifyObserver', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const seen: string[] = [];

    await runWithAppendObserver(
      (observation) => {
        seen.push(`${observation.streamId}#${observation.sequence}`);
      },
      async () => {
        await store.append('mixed-stream', { type: 'workflow.started' });

        await expect(
          store.append('mixed-stream', { type: 'invalid.type' }),
        ).rejects.toThrow();

        await expect(
          store.append(
            'mixed-stream',
            { type: 'task.assigned' },
            { expectedSequence: 0 },
          ),
        ).rejects.toThrow(SequenceConflictError);

        const claimed = await store.append(
          'mixed-stream',
          { type: 'task.claimed' },
          { idempotencyKey: 'claim-1' },
        );
        const retried = await store.append(
          'mixed-stream',
          { type: 'task.claimed' },
          { idempotencyKey: 'claim-1' },
        );
        expect(retried.sequence).toBe(claimed.sequence);

        const batched = await store.batchAppend('mixed-stream', [
          { type: 'task.progressed', idempotencyKey: 'batch-1' },
        ]);
        const rebatched = await store.batchAppend('mixed-stream', [
          { type: 'task.progressed', idempotencyKey: 'batch-1' },
        ]);
        expect(rebatched[0].sequence).toBe(batched[0].sequence);
      },
    );

    expect(seen).toEqual(['mixed-stream#1', 'mixed-stream#2', 'mixed-stream#3']);
    expect(await store.query('mixed-stream')).toHaveLength(3);

    store.close();
  });

  /**
   * The atomic trail notifies one time for each landed event, in trail order, with the assigned sequence.
   * One ordinary append comes first, so the trail does not start at sequence 1. A seam that reports trail positions then fails.
   */
  it('EventStore_AtomicTrailAppend_NotifiesOncePerLandedEvent', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const seen: Array<{
      type: string;
      streamId: string;
      sequence: number;
      durableAtNotify: boolean;
    }> = [];

    await runWithAppendObserver(
      (observation) => {
        const durableAtNotify = store
          .getReadBackend()
          .queryEvents(observation.streamId)
          .some((event) => event.sequence === observation.sequence);
        seen.push({ ...observation, durableAtNotify });
      },
      async () => {
        await store.append('trail-stream', { type: 'workflow.started' });
        await store.appendTrailAtomically(
          'trail-stream',
          [
            { type: 'task.assigned' },
            { type: 'task.claimed' },
            { type: 'task.progressed' },
          ],
          'trail-op-1',
        );
      },
    );

    expect(seen.map((s) => s.type)).toEqual([
      'workflow.started',
      'task.assigned',
      'task.claimed',
      'task.progressed',
    ]);
    expect(seen.map((s) => s.sequence)).toEqual([1, 2, 3, 4]);
    expect(seen.every((s) => s.streamId === 'trail-stream')).toBe(true);
    expect(seen.every((s) => s.durableAtNotify)).toBe(true);

    store.close();
  });

  /**
   * A retry with the same `operationId` and the same request returns the recorded claim.
   * It persists nothing and must notify nothing.
   */
  it('EventStore_AtomicTrailRetriedOnSameOperationId_NotifiesNothing', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const seen: string[] = [];
    const trail = [{ type: 'task.assigned' }, { type: 'task.claimed' }];

    await runWithAppendObserver(
      (observation) => {
        seen.push(`${observation.type}#${observation.sequence}`);
      },
      async () => {
        await store.appendTrailAtomically('retry-stream', trail, 'trail-op-2');
        await store.appendTrailAtomically('retry-stream', trail, 'trail-op-2');
      },
    );

    expect(seen).toEqual(['task.assigned#1', 'task.claimed#2']);
    expect(await store.query('retry-stream')).toHaveLength(2);

    store.close();
  });

  /**
   * Each scope yields to the macrotask queue through `yieldTick` before each append, so both scopes are active together.
   * A module-level observer fails this test.
   */
  it('EventStore_ConcurrentScopes_DoNotCrossTalk', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const seenA: string[] = [];
    const seenB: string[] = [];

    const scope = (
      sink: string[],
      streamId: string,
      types: readonly string[],
    ): Promise<void> =>
      runWithAppendObserver(
        (observation) => {
          sink.push(observation.streamId);
        },
        async () => {
          for (const type of types) {
            await yieldTick();
            await store.append(streamId, { type });
          }
        },
      );

    await Promise.all([
      scope(seenA, 'scope-a', ['workflow.started', 'task.assigned', 'task.claimed']),
      scope(seenB, 'scope-b', ['workflow.started', 'task.assigned']),
    ]);

    expect(seenA).toEqual(['scope-a', 'scope-a', 'scope-a']);
    expect(seenB).toEqual(['scope-b', 'scope-b']);

    store.close();
  });

  /**
   * The inner scope owns its appends, so the outer observer does not count them.
   * After the inner scope ends, the outer observer resumes.
   */
  it('EventStore_NestedScopes_InnerShadowsOuterThenOuterResumes', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const outer: number[] = [];
    const inner: number[] = [];

    await runWithAppendObserver(
      (observation) => {
        outer.push(observation.sequence);
      },
      async () => {
        await store.append('nested-stream', { type: 'workflow.started' });

        await runWithAppendObserver(
          (observation) => {
            inner.push(observation.sequence);
          },
          async () => {
            await store.append('nested-stream', { type: 'task.assigned' });
          },
        );

        await store.append('nested-stream', { type: 'task.claimed' });
      },
    );

    expect(inner).toEqual([2]);
    expect(outer).toEqual([1, 3]);

    store.close();
  });

  /**
   * A throw from the observer reaches the caller. It comes after the commit, so the event stays durable.
   * The observer cannot veto the write.
   */
  it('EventStore_ThrowingObserver_FaultsTheCallerAndLeavesEventDurable', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    await expect(
      runWithAppendObserver(
        () => {
          throw new Error('observer refused');
        },
        async () => {
          await store.append('throwing-stream', { type: 'workflow.started' });
        },
      ),
    ).rejects.toThrow('observer refused');

    const persisted = await store.query('throwing-stream');
    expect(persisted.map((event) => event.sequence)).toEqual([1]);

    store.close();
  });

  it('EventStore_ConcurrentScopes_DoNotCrossTalk_Property', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 3 }), { minLength: 2, maxLength: 4 }),
        async (appendCounts) => {
          const dir = await mkdtemp(path.join(tmpdir(), 'append-observation-prop-'));
          const store = new EventStore(dir);
          try {
            await store.initialize();

            const sinks = appendCounts.map((): string[] => []);
            await Promise.all(
              appendCounts.map((count, index) =>
                runWithAppendObserver(
                  (observation) => {
                    sinks[index].push(observation.streamId);
                  },
                  async () => {
                    for (let i = 0; i < count; i++) {
                      await new Promise((resolve) => setTimeout(resolve, 0));
                      await store.append(`prop-${index}`, { type: 'task.progressed' });
                    }
                  },
                ),
              ),
            );

            for (const [index, sink] of sinks.entries()) {
              expect(sink).toHaveLength(appendCounts[index]);
              expect(sink.every((s) => s === `prop-${index}`)).toBe(true);
            }
          } finally {
            store.close();
            await rmrfAsync(dir);
          }
        },
      ),
      { numRuns: 8 },
    );
  });
});

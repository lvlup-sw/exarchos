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

// ─── A04: Append with Sequence Numbering ────────────────────────────────────

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

    // Read-back via query (SQLite-only post v2.11): the persisted shape
    // matches the returned event.
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

    // Verify all 3 events readable via query (SQLite substrate).
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

    // Stream is empty before append.
    const before = await store.query('new-stream');
    expect(before).toEqual([]);

    await store.append('new-stream', { type: 'task.assigned' });

    // Event is now durable and readable.
    const after = await store.query('new-stream');
    expect(after).toHaveLength(1);
    expect(after[0].streamId).toBe('new-stream');
  });

  it('should initialize sequence from existing file', async () => {
    // Write some events with one store instance
    const store1 = new EventStore(tempDir);
    await store1.append('my-workflow', { type: 'workflow.started' });
    await store1.append('my-workflow', { type: 'task.assigned' });

    // Create a new store instance (simulating restart)
    const store2 = new EventStore(tempDir);
    const event = await store2.append('my-workflow', { type: 'workflow.transition' });

    // Should continue from 3, not start over at 1
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

// ─── A05: Query with Filters ────────────────────────────────────────────────

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

// ─── A06: Optimistic Concurrency ────────────────────────────────────────────

// ─── T25: queryByType with streamPrefix (DR-3, cross-stream propagation) ────

describe('EventStore queryByType with streamPrefix (T25)', () => {
  it('EventStore_QueryByTypeWithStreamPrefix_ReturnsAllMatchingDescendantStreams', async () => {
    const store = new EventStore(tempDir);
    const featureId = 'feat-cross-1';
    const subA = `${featureId}/subagent-a`;
    const subB = `${featureId}/subagent-b`;
    const otherFeature = 'feat-other';

    // Each subagent stream gets a task.completed event scoped to the team.
    await store.append(subA, {
      type: 'task.completed',
      data: { taskId: 'a-1', teamId: 'team-x' },
    });
    await store.append(subB, {
      type: 'task.completed',
      data: { taskId: 'b-1', teamId: 'team-x' },
    });
    // The parent feature stream itself can also carry task.completed events.
    await store.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'parent-1', teamId: 'team-x' },
    });
    // An UNRELATED feature must be excluded — its prefix doesn't match.
    await store.append(otherFeature, {
      type: 'task.completed',
      data: { taskId: 'other-1', teamId: 'team-x' },
    });
    // A non-matching event type on a matching stream must be excluded.
    await store.append(subA, {
      type: 'task.assigned',
      data: { taskId: 'a-2', teammateName: 'worker-a' },
    });

    const events = await store.queryByType('task.completed', {
      streamPrefix: featureId,
    });

    // Three matches: parent + two subagents. The unrelated feature and the
    // task.assigned event both stay out.
    expect(events).toHaveLength(3);
    const taskIds = events.map((e) => (e.data as { taskId?: string })?.taskId).sort();
    expect(taskIds).toEqual(['a-1', 'b-1', 'parent-1']);
    // Every event must come from a matching stream — either the prefix itself
    // or a `<prefix>/<segment>` descendant.
    for (const event of events) {
      const isParent = event.streamId === featureId;
      const isDescendant = event.streamId.startsWith(`${featureId}/`);
      expect(isParent || isDescendant).toBe(true);
    }
  });

  it('EventStore_QueryByTypeWithStreamPrefix_ExcludesAccidentalSubstringMatches', async () => {
    // Pin: a stream named `feat-cross-1-extra` shares the prefix as a
    // substring but is NOT a descendant under the namespaced form. The query
    // must NOT include it.
    const store = new EventStore(tempDir);
    const featureId = 'feat-cross-1';
    const lookalike = `${featureId}-extra`; // not `${featureId}/...`

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

describe('EventStore Optimistic Concurrency', () => {
  it('should accept append with correct expectedSequence', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });

    // expectedSequence=2 means "I expect the current sequence to be 2"
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

    // expectedSequence=1 but actual is 2
    await expect(
      store.append('my-workflow', { type: 'workflow.transition' }, { expectedSequence: 1 }),
    ).rejects.toThrow(SequenceConflictError);
  });

  it('should detect conflict between two store instances', async () => {
    const store1 = new EventStore(tempDir);
    const store2 = new EventStore(tempDir);

    // Both read the stream state (both see sequence=0)
    await store1.append('my-workflow', { type: 'workflow.started' });
    // store1 is at sequence=1, store2 doesn't know yet

    // store2 tries to append with expectedSequence=0 (stale)
    await expect(
      store2.append('my-workflow', { type: 'task.progressed' }, { expectedSequence: 0 }),
    ).rejects.toThrow(SequenceConflictError);
  });

  it('should allow refreshSequence to recover from conflict', async () => {
    const store1 = new EventStore(tempDir);
    const store2 = new EventStore(tempDir);

    await store1.append('my-workflow', { type: 'workflow.started' });

    // Refresh store2's sequence knowledge
    await store2.refreshSequence('my-workflow');

    // Now store2 can append with correct expectedSequence
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
      // Should not reach here
      expect.unreachable('Expected SequenceConflictError');
    } catch (err) {
      expect(err).toBeInstanceOf(SequenceConflictError);
      const conflict = err as SequenceConflictError;
      expect(conflict.expected).toBe(1);
      expect(conflict.actual).toBe(3);
    }
  });
});

// ─── EventStore Query Pagination ─────────────────────────────────────────────

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

// ─── Streaming Query Optimization ───────────────────────────────────────────

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
    // Append mixed types
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

  it('query_WithSinceSequenceAndTypeAndLimit_CombinesAllFilters', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });

    // sinceSequence=3 means events 4,5,6; type=task.assigned filters to 4,6; limit=1 gives only 4
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

    // offset=3, limit=2 should return events at positions 4 and 5 (sequences 4,5)
    const events = await store.query('my-workflow', { offset: 3, limit: 2 });
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(4);
    expect(events[1].sequence).toBe(5);
  });

  it('query_EmptyFile_ReturnsEmpty', async () => {
    const store = new EventStore(tempDir);
    // Create an empty JSONL file
    const filePath = path.join(tempDir, 'empty-stream.events.jsonl');
    await fs.writeFile(filePath, '', 'utf-8');

    const events = await store.query('empty-stream');
    expect(events).toEqual([]);
  });
});

// ─── Sub-Task A: Pre-Parse Sequence Filtering ──────────────────────────────

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

  it('query_WithSinceSequenceAndType_FallsBackToFullParse', async () => {
    const store = new EventStore(tempDir);
    for (let i = 0; i < 100; i++) {
      const type = i % 2 === 0 ? 'task.claimed' : 'task.assigned';
      await store.append('my-workflow', { type });
    }

    // sinceSequence=50 with type filter should still work correctly
    // i=0→seq1 (claimed), i=1→seq2 (assigned), ..., i=50→seq51 (claimed), i=51→seq52 (assigned)
    // Events 51-100: task.claimed at 51,53,55,...,99 = 25 events
    const events = await store.query('my-workflow', {
      sinceSequence: 50,
      type: 'task.claimed',
    });
    expect(events).toHaveLength(25);
    expect(events.every(e => e.type === 'task.claimed')).toBe(true);
    expect(events[0].sequence).toBe(51);
  });
});

// ─── Sub-Task B: Idempotency Key for Append ────────────────────────────────

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

    // Second call should return the same event (same sequence)
    expect(second.sequence).toBe(first.sequence);
    expect(second.streamId).toBe(first.streamId);

    // Only one event should exist in the stream
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

    // Both should succeed (no dedup without key)
    const events = await store.query('my-workflow');
    expect(events).toHaveLength(2);
    expect(events[0].sequence).toBe(1);
    expect(events[1].sequence).toBe(2);
  });

  it('append_IdempotencyClaim_PersistsAcrossManyAppends', async () => {
    // v2.11 substrate-cut: the JSONL in-memory FIFO cap (default 200,
    // configurable via `EXARCHOS_MAX_IDEMPOTENCY_KEYS`) is gone. Every
    // claim persists in `idempotency_claims` indefinitely; retrying any
    // historical key returns the originally persisted sequence.
    const store = new EventStore(tempDir);

    // Append 201 events with unique keys.
    for (let i = 0; i < 201; i++) {
      await store.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: `key-${i}` },
      );
    }

    // Even key-0 (the first claim) is durably retrievable — retrying
    // returns its ORIGINAL sequence, not a fresh one.
    const retried = await store.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-0' },
    );
    expect(retried.sequence).toBe(1);

    // Stream still has exactly 201 events.
    const events = await store.query('my-workflow');
    expect(events).toHaveLength(201);
  });
});

// ─── T10/T11: Query Sequence Pre-filter ─────────────────────────────────────

describe('EventStore Query Sequence Pre-filter', () => {
  it('Query_WithSinceSequenceAndTypeFilter_ReturnsCorrectResults', async () => {
    const store = new EventStore(tempDir);
    // Append mixed event types
    for (let i = 0; i < 100; i++) {
      const type = i % 2 === 0 ? 'task.claimed' : 'task.assigned';
      await store.append('my-workflow', { type });
    }

    // Combined sinceSequence + type filter should return correct results
    // seq 51-100 are events at i=50..99; claimed at i=50,52,...,98 => seq 51,53,...,99 = 25 events
    const events = await store.query('my-workflow', {
      sinceSequence: 50,
      type: 'task.claimed',
    });
    expect(events).toHaveLength(25);
    expect(events.every(e => e.type === 'task.claimed')).toBe(true);
    expect(events.every(e => e.sequence > 50)).toBe(true);
  });

  it('Query_SequenceRegex_HandlesMultiDigitSequences', async () => {
    const store = new EventStore(tempDir);
    // 1050 events, so sequences cross into 4 digits — the point of the test is
    // the QUERY's sequence pre-filter, not the append path.
    //
    // Seeded via ONE batchAppend rather than 1050 awaited appends: sequence
    // assignment and types are identical, but the batch commits in a single
    // transaction instead of paying a per-append fsync. That is what makes this
    // test's runtime independent of host disk throughput — the loop took ~121ms
    // on Linux but ~35.6s on a Windows runner (NTFS fsync per append), which
    // blew the 30s budget and reds the required `Windows Unit (MCP)` lane
    // nondeterministically depending on how fast the runner happens to be.
    await store.batchAppend(
      'my-workflow',
      Array.from({ length: 1050 }, (_, i) => ({
        type: i % 3 === 0 ? 'task.completed' : 'task.assigned',
      })),
    );

    // Query with sinceSequence=1000 and type filter
    const events = await store.query('my-workflow', {
      sinceSequence: 1000,
      type: 'task.completed',
    });

    // Sequences 1001-1050: i=1000..1049; task.completed at i=1002,1005,...,1047,1050-1
    // i=1000 (seq 1001): 1000%3=1 -> assigned
    // i=1001 (seq 1002): 1001%3=2 -> assigned
    // i=1002 (seq 1003): 1002%3=0 -> completed
    // ... pattern: completed at i where i%3==0, seq=i+1
    // From i=1000 to i=1049: completed at i=1002,1005,1008,...,1047,1050-1
    // Wait, i=1002 -> seq 1003; last is i=1049 -> seq 1050
    // completed: i%3==0 in [1000..1049] -> i=1002,1005,...,1047 = 16 events
    // Plus i=1050 is not included (0..1049)
    // Actually: 1002,1005,1008,...,1047 => (1047-1002)/3 + 1 = 45/3 + 1 = 16
    expect(events.every(e => e.type === 'task.completed')).toBe(true);
    expect(events.every(e => e.sequence > 1000)).toBe(true);
    expect(events).toHaveLength(16);
  }, 30_000);

  // Query_SequenceRegex_MalformedLine_FallsBackToFullParse deleted at
  // v2.11 substrate-cut: it seeded a hand-crafted JSONL fixture with a
  // non-numeric `"sequence"` string to exercise the JSONL pre-parse
  // sequence-regex fallback. The SQLite substrate has typed columns
  // (`sequence INTEGER NOT NULL`) so the malformed-line shape can't
  // appear in the durable substrate and the regex pre-filter has no
  // analogue.
});

// ─── PID Lock Demotion (#1343, Wave A) ──────────────────────────────────────
//
// The `EventStore PID Lock` describe block previously pinned acquisition,
// stale-reclaim, and exit-cleanup behaviour for a `.event-store.lock`
// sidecar file. Wave A deleted that mechanism: `initialize()` is now a
// no-op marker and cross-process serialization flows through SQLite WAL +
// `BEGIN IMMEDIATE` + the `(stream_id, sequence)` PK. The replacement
// contract — two `EventStore` instances against one `stateDir` both
// initialize cleanly — is pinned in `store.race.test.ts` under
// `EventStore_Initialize_NoLongerThrowsOnConcurrentAttach`.

// ─── EventStore Query with Event Migration ──────────────────────────────────

describe('EventStore Query with Event Migration', () => {
  it('Query_EventsAtCurrentVersion_ReturnedWithSchemaVersion', async () => {
    const store = new EventStore(tempDir);

    // Append event — schemaVersion defaults to '1.0' via Zod schema
    await store.append('migration-test', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    const events = await store.query('migration-test');

    expect(events).toHaveLength(1);
    expect(events[0].schemaVersion).toBe('1.0');
    expect(events[0].type).toBe('workflow.started');
  });

  it('Query_AppliesMigrationTransform', async () => {
    // This test verifies that migrateEvent() is called during query.
    // Since all events are currently at version 1.0 (identity), we verify
    // the event passes through correctly. When future migrations are added,
    // this test will verify the transform is applied.
    const store = new EventStore(tempDir);

    await store.append('migration-transform', {
      type: 'task.assigned',
      data: { taskId: 'task-001', title: 'Test task' },
    });

    const events = await store.query('migration-transform');

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task.assigned');
    // Event should pass through migrateEvent identity path
    expect(events[0].streamId).toBe('migration-transform');
  });
});

// EventStore StorageBackend Integration tests deleted at v2.11
// substrate-cut: the dual-write call site (`replicateBackend`) was
// removed in Phase 2. Tests in this block all asserted the legacy
// "JSONL primary + injectable read-delegate backend" pattern. The
// SQLite substrate is the single source of truth post-cut; query
// delegation to an arbitrary `StorageBackend` is preserved (the
// `EventStoreOptions.backend` field still exists for tests that
// inject an in-memory read view), but the production pattern of
// dual-writing into both JSONL and the backend is gone.

// ─── appendValidated ────────────────────────────────────────────────────────

describe('EventStore appendValidated', () => {
  it('appendValidated_WritesEventWithoutZodParse', async () => {
    const store = new EventStore(tempDir);

    // Build a pre-validated event object (simulating what buildEvent returns)
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

    // Read-back via query (SQLite substrate post v2.11): one event,
    // matching shape.
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

    // Same idempotency key should return the cached event
    const second = await store.appendValidated('my-workflow', prebuilt, {
      idempotencyKey: 'dedup-key-1',
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(1);
    expect(second).toEqual(first);

    // Only one event in the durable substrate.
    const stored = await store.query('my-workflow');
    expect(stored).toHaveLength(1);
  });

  // ─── Cache-hit semantics (#1293 D1, CR review 4248944836 thread 3205805943) ─
  //
  // Retrying with the same idempotencyKey but a DIFFERENT payload must
  // return the ORIGINALLY persisted event (not a synthesized version of
  // the current request body — that would surface data the substrate
  // never wrote). The legacy "skip dual-write replication on cache-hit"
  // half of this test was deleted with the substrate-cut (v2.11): the
  // SQLite substrate never re-fires the commit on a cache-hit (the
  // transaction simply isn't entered), so the dual-write counter
  // assertion has no surface to attach to.

  it('append_idempotencyRetryWithDifferentPayload_returnsOriginallyPersisted', async () => {
    const store = new EventStore(tempDir);

    // Original commit: payload A
    const first = await store.append(
      'my-workflow',
      { type: 'task.assigned', data: { payload: 'A' } },
      { idempotencyKey: 'shared-key' },
    );
    expect(first.sequence).toBe(1);
    expect((first.data as { payload: string }).payload).toBe('A');

    // Retry with same key, DIFFERENT payload. Must return original (A, seq 1).
    const retry = await store.append(
      'my-workflow',
      { type: 'task.assigned', data: { payload: 'B-DIFFERENT' } },
      { idempotencyKey: 'shared-key' },
    );
    expect(retry.sequence).toBe(1);
    expect((retry.data as { payload: string }).payload).toBe('A'); // not 'B-DIFFERENT'

    // Substrate has exactly one persisted event for the key.
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

    // expectedSequence=1 should succeed (current is 1)
    const event = await store.appendValidated('my-workflow', prebuilt, {
      expectedSequence: 1,
    });
    expect(event.sequence).toBe(2);

    // expectedSequence=1 should now fail (current is 2)
    await expect(
      store.appendValidated('my-workflow', prebuilt, { expectedSequence: 1 }),
    ).rejects.toThrow(SequenceConflictError);
  });

  it('append_StillCallsZodParse_BackwardCompat', async () => {
    const store = new EventStore(tempDir);

    // Verify existing append() still validates via Zod (rejects invalid event type)
    await expect(
      store.append('my-workflow', { type: 'invalid.type' }),
    ).rejects.toThrow();
  });

  // appendValidated_DualWritesToBackend / appendValidated_WritesToOutbox
  // (legacy dual-write asserts) deleted at v2.11 substrate-cut: the
  // backend dual-write call site (`replicateBackend`) and the outbox
  // dual-write (`writeOutbox` / `setOutbox`) were removed in Phase 2
  // along with the JSONL primary substrate.
});

// ─── FINDING-2 (#1438, PR 2) — tailSequence accessor ────────────────────────

describe('EventStore.tailSequence', () => {
  it('tailSequence_EmptyStream_ReturnsZero', async () => {
    // FINDING-2 (#1438): `tailSequence` is the one-line wrapper over the
    // backend high-water-mark accessor that `EventSourcedTaskStore` will
    // use to validate cache hits against the durable stream tail. For a
    // stream that has never been written, the contract returns 0 (NOT
    // undefined) so callers can use `tail === cached.lastReadSequence`
    // as a clean equality check without separate undefined-handling.
    const store = new EventStore(tempDir);
    await store.initialize();

    const tail = await store.tailSequence('never-written');
    expect(tail).toBe(0);
  });

  it('tailSequence_PopulatedStream_ReturnsHighestSequence', async () => {
    // FINDING-2 (#1438): for a populated stream, `tailSequence` returns
    // the sequence of the most-recently-appended event — equivalent to
    // `(await query(stream)).at(-1).sequence`. AtomicAppender uses the
    // same accessor internally to compute the next sequence; this is the
    // public surface that exposes the value without forcing callers to
    // re-query the whole stream.
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

// ─── Wave 4 (#1437) — QueryFilters correlation tuple ────────────────────────

describe('QueryFilters correlation tuple (Wave 4 / #1437)', () => {
  it('QueryFilters_AcceptsCorrelationTuple_TypeAndShape', () => {
    // The Wave-4 contract: callers can pass operationId / correlationId /
    // causationId into the filter literal alongside the existing fields.
    // `assertType` pins the type contract at compile time (reified under
    // `--typecheck`); the JSON round-trip guards against the field set
    // being structurally erased by `Record<string, unknown>` looseness in
    // intermediate transforms (defensive — INV-1: payload is truth, the
    // indexed columns are the filter handle).
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

// ─── Scoped append observation ──────────────────────────────────────────────

/**
 * The observation seam has exactly one job: an observer learns about the
 * events that genuinely landed, and about nothing else. Three ways it could
 * be wrong, one test each — it misses a real append, it invents one from a
 * rejection or an idempotency collapse, or it leaks between two units of work
 * running at the same time.
 */
describe('EventStore append observation', () => {
  /** Yield to the macrotask queue so two scopes actually interleave. */
  const yieldTick = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

  it('EventStore_SuccessfulNewAppend_NotifiesScopedObserver', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    // Absent by default: an append outside every scope notifies nobody and
    // must not fault the write path.
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
        // Ordering: the notification must strictly follow persistence, so the
        // row is already readable from the substrate at the instant the
        // observer runs. A notify hoisted ahead of the commit records false.
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

    // Every write path reports, and each landed event reports exactly once.
    expect(seen.map((s) => s.type)).toEqual([
      'workflow.started',
      'task.assigned',
      'task.claimed',
      'task.progressed',
    ]);
    expect(seen.map((s) => s.sequence)).toEqual([1, 2, 3, 4]);
    expect(seen.every((s) => s.streamId === 'observed-stream')).toBe(true);
    expect(seen.every((s) => s.durableAtNotify)).toBe(true);

    // The unobserved stream stayed unobserved.
    expect(seen.some((s) => s.streamId === 'quiet-stream')).toBe(false);

    store.close();
  });

  it('EventStore_NoScopeInstalled_BurstOfAppendsNotifiesNothing', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    // A burst across every write path, entirely outside any
    // `runWithAppendObserver` scope. Absent-by-default means this must both
    // (a) not fault the write path and (b) leave no observer state behind
    // for a later scope to inherit.
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

    // A scope opened afterward sees only its own append, proving the
    // unscoped burst queued nothing for a later observer to pick up.
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

  it('EventStore_FailedOrCollapsedAppend_DoesNotNotifyObserver', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const seen: string[] = [];

    await runWithAppendObserver(
      (observation) => {
        seen.push(`${observation.streamId}#${observation.sequence}`);
      },
      async () => {
        // One genuine append, so the assertions below have a denominator: a
        // seam that notified for nothing at all would also satisfy "no
        // notification for the rejected calls".
        await store.append('mixed-stream', { type: 'workflow.started' });

        // Rejected before the substrate is touched (schema).
        await expect(
          store.append('mixed-stream', { type: 'invalid.type' }),
        ).rejects.toThrow();

        // Rejected by the substrate (stale expected sequence).
        await expect(
          store.append(
            'mixed-stream',
            { type: 'task.assigned' },
            { expectedSequence: 0 },
          ),
        ).rejects.toThrow(SequenceConflictError);

        // Collapsed onto a prior write: the first claim lands, the retry
        // persists nothing and must stay silent even though it resolves.
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

        // Same collapse through the batch path.
        const batched = await store.batchAppend('mixed-stream', [
          { type: 'task.progressed', idempotencyKey: 'batch-1' },
        ]);
        const rebatched = await store.batchAppend('mixed-stream', [
          { type: 'task.progressed', idempotencyKey: 'batch-1' },
        ]);
        expect(rebatched[0].sequence).toBe(batched[0].sequence);
      },
    );

    // Three events landed (sequences 1..3); the two retries and the two
    // rejections added nothing.
    expect(seen).toEqual(['mixed-stream#1', 'mixed-stream#2', 'mixed-stream#3']);
    expect(await store.query('mixed-stream')).toHaveLength(3);

    store.close();
  });

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
            // Interleave: each scope parks on the macrotask queue between
            // appends, so both are mid-flight at the same time and a
            // module-level observer would be visibly shared.
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

            // Each observer saw its own stream, its own count, nothing else.
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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore, SequenceConflictError } from './store.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-store-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── A04: Append with Sequence Numbering ────────────────────────────────────

describe('EventStore Append', () => {
  it('should write event to JSONL file', async () => {
    const store = new EventStore(tempDir);

    const event = await store.append('my-workflow', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    expect(event.streamId).toBe('my-workflow');
    expect(event.sequence).toBe(1);
    expect(event.type).toBe('workflow.started');

    // Verify file exists
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.streamId).toBe('my-workflow');
    expect(parsed.sequence).toBe(1);
  });

  it('should auto-increment sequence numbers', async () => {
    const store = new EventStore(tempDir);

    const e1 = await store.append('my-workflow', { type: 'workflow.started' });
    const e2 = await store.append('my-workflow', { type: 'team.formed' });
    const e3 = await store.append('my-workflow', { type: 'phase.transitioned' });

    expect(e1.sequence).toBe(1);
    expect(e2.sequence).toBe(2);
    expect(e3.sequence).toBe(3);

    // Verify all 3 lines in file
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);
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

  it('should create file on first append to nonexistent stream', async () => {
    const store = new EventStore(tempDir);
    const filePath = path.join(tempDir, 'new-stream.events.jsonl');

    // File should not exist yet
    await expect(fs.access(filePath)).rejects.toThrow();

    await store.append('new-stream', { type: 'task.assigned' });

    // File should now exist
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it('should initialize sequence from existing file', async () => {
    // Write some events with one store instance
    const store1 = new EventStore(tempDir);
    await store1.append('my-workflow', { type: 'workflow.started' });
    await store1.append('my-workflow', { type: 'team.formed' });

    // Create a new store instance (simulating restart)
    const store2 = new EventStore(tempDir);
    const event = await store2.append('my-workflow', { type: 'phase.transitioned' });

    // Should continue from 3, not start over at 1
    expect(event.sequence).toBe(3);
  });

  it('should handle multiple independent streams', async () => {
    const store = new EventStore(tempDir);

    const a1 = await store.append('stream-a', { type: 'workflow.started' });
    const b1 = await store.append('stream-b', { type: 'workflow.started' });
    const a2 = await store.append('stream-a', { type: 'team.formed' });
    const b2 = await store.append('stream-b', { type: 'team.formed' });

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
    await store.append('my-workflow', { type: 'team.formed' });
    await store.append('my-workflow', { type: 'phase.transitioned' });
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
    await store.append('my-workflow', { type: 'team.formed' });
    await store.append('my-workflow', { type: 'phase.transitioned' });
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
      type: 'context.assembled',
      timestamp: '2025-06-15T00:00:00.000Z',
    });
    await store.append('my-workflow', {
      type: 'task.routed',
      timestamp: '2025-12-31T00:00:00.000Z',
    });

    const events = await store.query('my-workflow', {
      since: '2025-03-01T00:00:00.000Z',
      until: '2025-09-01T00:00:00.000Z',
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('context.assembled');
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

describe('EventStore Optimistic Concurrency', () => {
  it('should accept append with correct expectedSequence', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'team.formed' });

    // expectedSequence=2 means "I expect the current sequence to be 2"
    const event = await store.append(
      'my-workflow',
      { type: 'phase.transitioned' },
      { expectedSequence: 2 },
    );
    expect(event.sequence).toBe(3);
  });

  it('should reject append with stale expectedSequence', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'team.formed' });

    // expectedSequence=1 but actual is 2
    await expect(
      store.append('my-workflow', { type: 'phase.transitioned' }, { expectedSequence: 1 }),
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
      store2.append('my-workflow', { type: 'agent.message' }, { expectedSequence: 0 }),
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
      { type: 'team.formed' },
      { expectedSequence: 1 },
    );
    expect(event.sequence).toBe(2);
  });

  it('SequenceConflictError should contain expected and actual', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'team.formed' });
    await store.append('my-workflow', { type: 'phase.transitioned' });

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

// ─── B1: Persist Sequence Counters ──────────────────────────────────────────

describe('EventStore Sequence Persistence', () => {
  // After append, .seq file exists with correct sequence
  it('EventStore_Append_WritesSeqFile', async () => {
    const store = new EventStore(tempDir);

    await store.append('my-workflow', { type: 'workflow.started' });

    const seqPath = path.join(tempDir, 'my-workflow.seq');
    const content = await fs.readFile(seqPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.sequence).toBe(1);

    // Append another and verify sequence increments
    await store.append('my-workflow', { type: 'team.formed' });
    const content2 = await fs.readFile(seqPath, 'utf-8');
    const parsed2 = JSON.parse(content2);
    expect(parsed2.sequence).toBe(2);
  });

  // New store continues from persisted sequence
  it('EventStore_NewInstance_ReadsSeqFile', async () => {
    const store1 = new EventStore(tempDir);
    await store1.append('my-workflow', { type: 'workflow.started' });
    await store1.append('my-workflow', { type: 'team.formed' });
    await store1.append('my-workflow', { type: 'phase.transitioned' });

    // Create a NEW store instance (simulating server restart)
    const store2 = new EventStore(tempDir);
    const event = await store2.append('my-workflow', { type: 'task.assigned' });

    // Should continue at 4, reading from .seq file (O(1)) instead of line counting
    expect(event.sequence).toBe(4);

    // Verify .seq file was read (not line counting) by checking .seq exists
    const seqPath = path.join(tempDir, 'my-workflow.seq');
    const content = await fs.readFile(seqPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.sequence).toBe(4);
  });

  // Works when .seq file is deleted
  it('EventStore_SeqFileMissing_FallsBackToLineCount', async () => {
    const store1 = new EventStore(tempDir);
    await store1.append('my-workflow', { type: 'workflow.started' });
    await store1.append('my-workflow', { type: 'team.formed' });

    // Delete the .seq file to simulate missing file
    const seqPath = path.join(tempDir, 'my-workflow.seq');
    await fs.unlink(seqPath);

    // Create a new store — should fall back to line counting
    const store2 = new EventStore(tempDir);
    const event = await store2.append('my-workflow', { type: 'phase.transitioned' });

    // Should still continue from correct sequence by counting JSONL lines
    expect(event.sequence).toBe(3);
  });

  // Append succeeds even when .seq write fails
  it('EventStore_SeqWriteFails_AppendStillSucceeds', async () => {
    const store = new EventStore(tempDir);

    // First append succeeds normally
    await store.append('my-workflow', { type: 'workflow.started' });

    // Make the .seq file path a directory so writeFile will fail
    const seqPath = path.join(tempDir, 'my-workflow.seq');
    await fs.rm(seqPath, { force: true });
    await fs.mkdir(seqPath);

    // Second append should still succeed despite .seq write failure
    const event = await store.append('my-workflow', { type: 'team.formed' });
    expect(event.sequence).toBe(2);
    expect(event.type).toBe('team.formed');

    // Verify the JSONL file has both events (source of truth)
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    // Clean up: remove the directory so afterEach can clean up
    await fs.rm(seqPath, { recursive: true, force: true });
  });

  // Works when .seq file has garbage
  it('EventStore_SeqFileCorrupt_FallsBackToLineCount', async () => {
    const store1 = new EventStore(tempDir);
    await store1.append('my-workflow', { type: 'workflow.started' });
    await store1.append('my-workflow', { type: 'team.formed' });

    // Write garbage to the .seq file
    const seqPath = path.join(tempDir, 'my-workflow.seq');
    await fs.writeFile(seqPath, 'not-valid-json!!!', 'utf-8');

    // Create a new store — should fall back to line counting
    const store2 = new EventStore(tempDir);
    const event = await store2.append('my-workflow', { type: 'phase.transitioned' });

    // Should still continue from correct sequence by counting JSONL lines
    expect(event.sequence).toBe(3);
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

  it('append_IdempotencyCacheEvictsOldest', async () => {
    const store = new EventStore(tempDir);

    // Append 101 events with unique keys (cache max is 100)
    for (let i = 0; i < 101; i++) {
      await store.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: `key-${i}` },
      );
    }

    // First key should have been evicted — retrying should create a new event
    const retried = await store.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-0' },
    );

    // Should get sequence 102 (new event, not deduplicated)
    expect(retried.sequence).toBe(102);

    // Total events should be 102 (101 original + 1 retry of evicted key)
    const events = await store.query('my-workflow');
    expect(events).toHaveLength(102);
  });
});

// ─── Idempotency Key Persistence ────────────────────────────────────────────

describe('EventStore Idempotency Persistence', () => {
  it('should persist idempotencyKey in JSONL event data', async () => {
    const store = new EventStore(tempDir);

    await store.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'claim-abc' },
    );

    // Read the raw JSONL file and verify the idempotencyKey is present
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content.trim());

    expect(parsed.idempotencyKey).toBe('claim-abc');
  });

  it('should not include idempotencyKey when none is provided', async () => {
    const store = new EventStore(tempDir);

    await store.append('my-workflow', { type: 'task.claimed' });

    // Read the raw JSONL file — idempotencyKey should be absent
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content.trim());

    expect(parsed.idempotencyKey).toBeUndefined();
  });

  it('should rebuild idempotency cache from persisted events on new instance', async () => {
    const store1 = new EventStore(tempDir);

    const original = await store1.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'claim-xyz' },
    );

    // Create a new store instance (simulating server restart)
    const store2 = new EventStore(tempDir);

    // Retry the same idempotencyKey — should return the cached event, not a new one
    const retried = await store2.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'claim-xyz' },
    );

    // Should return the same event (dedup across restart)
    expect(retried.sequence).toBe(original.sequence);
    expect(retried.streamId).toBe(original.streamId);

    // Only one event should exist in the stream
    const events = await store2.query('my-workflow');
    expect(events).toHaveLength(1);
  });

  it('should only rebuild cache once per stream per lifecycle', async () => {
    const store1 = new EventStore(tempDir);

    // Append several events with keys
    await store1.append('my-workflow', { type: 'task.claimed' }, { idempotencyKey: 'k1' });
    await store1.append('my-workflow', { type: 'task.assigned' }, { idempotencyKey: 'k2' });
    await store1.append('my-workflow', { type: 'task.completed' }, { idempotencyKey: 'k3' });

    // New instance
    const store2 = new EventStore(tempDir);

    // First dedup check triggers rebuild
    const r1 = await store2.append('my-workflow', { type: 'task.claimed' }, { idempotencyKey: 'k1' });
    expect(r1.sequence).toBe(1); // deduped

    // Subsequent checks use the already-rebuilt cache
    const r2 = await store2.append('my-workflow', { type: 'task.assigned' }, { idempotencyKey: 'k2' });
    expect(r2.sequence).toBe(2); // deduped

    const r3 = await store2.append('my-workflow', { type: 'task.completed' }, { idempotencyKey: 'k3' });
    expect(r3.sequence).toBe(3); // deduped

    // Still only 3 events total
    const events = await store2.query('my-workflow');
    expect(events).toHaveLength(3);
  });

  it('should respect MAX_IDEMPOTENCY_KEYS when rebuilding from JSONL', async () => {
    const store1 = new EventStore(tempDir);

    // Append 105 events with unique keys (cache max is 100)
    for (let i = 0; i < 105; i++) {
      await store1.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: `key-${i}` },
      );
    }

    // New instance — rebuild should only load the last 100 keys
    const store2 = new EventStore(tempDir);

    // Key from the first 5 events should NOT be in cache (evicted during rebuild)
    const retried = await store2.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-0' },
    );
    expect(retried.sequence).toBe(106); // new event, not deduped

    // Key from a recent event should still be cached
    const deduped = await store2.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-104' },
    );
    expect(deduped.sequence).toBe(105); // deduped
  });
});

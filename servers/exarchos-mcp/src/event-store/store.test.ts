import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore, SequenceConflictError, PidLockError } from './store.js';
import { Outbox } from '../sync/outbox.js';
import { InMemoryBackend } from '../storage/memory-backend.js';
import type { StorageBackend } from '../storage/backend.js';

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
    const e2 = await store.append('my-workflow', { type: 'task.assigned' });
    const e3 = await store.append('my-workflow', { type: 'workflow.transition' });

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
    await store.append('my-workflow', { type: 'task.assigned' });
    const content2 = await fs.readFile(seqPath, 'utf-8');
    const parsed2 = JSON.parse(content2);
    expect(parsed2.sequence).toBe(2);
  });

  // New store continues from persisted sequence
  it('EventStore_NewInstance_ReadsSeqFile', async () => {
    const store1 = new EventStore(tempDir);
    await store1.append('my-workflow', { type: 'workflow.started' });
    await store1.append('my-workflow', { type: 'task.assigned' });
    await store1.append('my-workflow', { type: 'workflow.transition' });

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
    await store1.append('my-workflow', { type: 'task.assigned' });

    // Delete the .seq file to simulate missing file
    const seqPath = path.join(tempDir, 'my-workflow.seq');
    await fs.unlink(seqPath);

    // Create a new store — should fall back to line counting
    const store2 = new EventStore(tempDir);
    const event = await store2.append('my-workflow', { type: 'workflow.transition' });

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
    const event = await store.append('my-workflow', { type: 'task.assigned' });
    expect(event.sequence).toBe(2);
    expect(event.type).toBe('task.assigned');

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
    await store1.append('my-workflow', { type: 'task.assigned' });

    // Write garbage to the .seq file
    const seqPath = path.join(tempDir, 'my-workflow.seq');
    await fs.writeFile(seqPath, 'not-valid-json!!!', 'utf-8');

    // Create a new store — should fall back to line counting
    const store2 = new EventStore(tempDir);
    const event = await store2.append('my-workflow', { type: 'workflow.transition' });

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

    // Append 201 events with unique keys (cache max is 200 by default)
    for (let i = 0; i < 201; i++) {
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

    // Should get sequence 202 (new event, not deduplicated)
    expect(retried.sequence).toBe(202);

    // Total events should be 202 (201 original + 1 retry of evicted key)
    const events = await store.query('my-workflow');
    expect(events).toHaveLength(202);
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

    // Append 205 events with unique keys (cache max is 200 by default)
    for (let i = 0; i < 205; i++) {
      await store1.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: `key-${i}` },
      );
    }

    // New instance — rebuild should only load the last 200 keys
    const store2 = new EventStore(tempDir);

    // Key from the first 5 events should NOT be in cache (evicted during rebuild)
    const retried = await store2.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-0' },
    );
    expect(retried.sequence).toBe(206); // new event, not deduped

    // Key from a recent event should still be cached
    const deduped = await store2.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-204' },
    );
    expect(deduped.sequence).toBe(205); // deduped
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
    // Append 1050 events to get multi-digit sequences
    for (let i = 0; i < 1050; i++) {
      const type = i % 3 === 0 ? 'task.completed' : 'task.assigned';
      await store.append('my-workflow', { type });
    }

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
  });

  it('Query_SequenceRegex_MalformedLine_FallsBackToFullParse', async () => {
    // Arrange: write a JSONL file where the second line has "sequence":"NaN" (a string value).
    // The SEQUENCE_REGEX only matches numeric digits so it will not extract a sequence from
    // that line; the code must fall back to JSON.parse to evaluate the event.
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');

    const line1 = JSON.stringify({
      streamId: 'my-workflow', sequence: 1, type: 'workflow.started',
      timestamp: '2025-01-01T00:00:00.000Z', schemaVersion: '1.0',
    });
    // Non-numeric sequence string — regex will not match, fallback to JSON.parse
    const line2 = `{"streamId":"my-workflow","sequence":"NaN","type":"task.assigned","timestamp":"2025-01-01T00:00:00.001Z","schemaVersion":"1.0"}`;
    const line3 = JSON.stringify({
      streamId: 'my-workflow', sequence: 3, type: 'task.completed',
      timestamp: '2025-01-01T00:00:00.002Z', schemaVersion: '1.0',
    });
    await fs.writeFile(filePath, [line1, line2, line3].join('\n') + '\n', 'utf-8');

    const store = new EventStore(tempDir);

    // Act: combined sinceSequence + type filter — exercises the regex pre-filter path.
    // Line 2 has a non-numeric sequence so the regex produces NaN; the code falls back to
    // JSON.parse and then applies the type filter, which should exclude it.
    const events = await store.query('my-workflow', {
      sinceSequence: 1,
      type: 'task.completed',
    });

    // Assert: only the task.completed event (sequence 3) should be returned.
    expect(events).toHaveLength(1);
    expect(events[0].sequence).toBe(3);
    expect(events[0].type).toBe('task.completed');
  });
});

// ─── T14/T15: Idempotency Cache Pre-filter ──────────────────────────────────

describe('EventStore Idempotency Cache Pre-filter', () => {
  it('RebuildIdempotencyCache_SkipsLinesWithoutIdempotencyKey', async () => {
    const store1 = new EventStore(tempDir);

    // Append events: some with idempotency keys, some without
    await store1.append('my-workflow', { type: 'workflow.started' });
    await store1.append('my-workflow', { type: 'task.assigned' });
    const keyed = await store1.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'claim-1' },
    );
    await store1.append('my-workflow', { type: 'task.progressed' });

    // New instance triggers rebuild
    const store2 = new EventStore(tempDir);

    // Retry the keyed event — should be deduped (found in cache)
    const retried = await store2.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'claim-1' },
    );
    expect(retried.sequence).toBe(keyed.sequence);

    // Non-keyed events should not be affected
    const events = await store2.query('my-workflow');
    expect(events).toHaveLength(4); // still 4 events total
  });

  it('RebuildIdempotencyCache_AllKeyedEvents_FoundAfterPrefilter', async () => {
    const store1 = new EventStore(tempDir);

    // Append a mix of keyed and non-keyed events
    const keyedEvents: Array<{ key: string; seq: number }> = [];
    for (let i = 0; i < 20; i++) {
      if (i % 3 === 0) {
        const event = await store1.append(
          'my-workflow',
          { type: 'task.assigned' },
          { idempotencyKey: `key-${i}` },
        );
        keyedEvents.push({ key: `key-${i}`, seq: event.sequence });
      } else {
        await store1.append('my-workflow', { type: 'task.progressed' });
      }
    }

    // New instance — rebuild cache
    const store2 = new EventStore(tempDir);

    // All keyed events should be found in cache
    for (const { key, seq } of keyedEvents) {
      const retried = await store2.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: key },
      );
      expect(retried.sequence).toBe(seq);
    }

    // Total events should remain the same
    const events = await store2.query('my-workflow');
    expect(events).toHaveLength(20);
  });
});

// ─── Blank-line Tolerance ───────────────────────────────────────────────────

describe('query_BlankLineTolerance', () => {
  it('should correctly skip with sinceSequence when JSONL has blank lines', async () => {
    // Arrange: append events normally, then manually inject blank lines into JSONL
    const store = new EventStore(tempDir);

    await store.append('my-workflow', { type: 'workflow.started', data: { featureId: 'test' } });
    await store.append('my-workflow', { type: 'workflow.transition', data: { from: 'a', to: 'b' } });
    await store.append('my-workflow', { type: 'task.claimed', data: { taskId: 't1' } });

    // Manually inject blank lines between events in the JSONL file
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const original = await fs.readFile(filePath, 'utf-8');
    const lines = original.trim().split('\n');
    // Insert blank lines: before first, between each, and after last
    const corrupted = '\n' + lines[0] + '\n\n' + lines[1] + '\n\n\n' + lines[2] + '\n';
    await fs.writeFile(filePath, corrupted, 'utf-8');

    // Create a fresh store to avoid cached sequence counters
    const freshStore = new EventStore(tempDir);

    // Act: query with sinceSequence=1 (should return events 2 and 3)
    const result = await freshStore.query('my-workflow', { sinceSequence: 1 });

    // Assert: returns correct events (not off-by-one due to blank lines)
    expect(result).toHaveLength(2);
    expect(result[0].sequence).toBe(2);
    expect(result[1].sequence).toBe(3);
  });
});

// ─── Orphaned .seq.tmp Cleanup ──────────────────────────────────────────────

describe('initializeSequence_CleansTmpFiles', () => {
  it('should remove orphaned .seq.tmp files during initialization', async () => {
    // Arrange: create a JSONL file so initializeSequence has something to read,
    // plus an orphaned .seq.tmp that simulates a crash during atomic write.
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started', data: { featureId: 'test' } });

    // Now create an orphaned .seq.tmp file (simulating a crash mid-write)
    const tmpFilePath = path.join(tempDir, 'my-workflow.seq.tmp');
    await fs.writeFile(tmpFilePath, JSON.stringify({ sequence: 999 }), 'utf-8');

    // Act: trigger initializeSequence via refreshSequence (no append side effects)
    const freshStore = new EventStore(tempDir);
    await freshStore.refreshSequence('my-workflow');

    // Assert: .seq.tmp file should be removed by initializeSequence
    let tmpExists = true;
    try {
      await fs.access(tmpFilePath);
    } catch {
      tmpExists = false;
    }
    expect(tmpExists).toBe(false);
  });
});

// ─── T20: PID Lock File Acquisition ──────────────────────────────────────────

describe('EventStore PID Lock', () => {
  it('AcquirePidLock_CreatesLockFile_WithCurrentPid', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const lockPath = path.join(tempDir, '.event-store.lock');
    const content = await fs.readFile(lockPath, 'utf-8');
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  it('AcquirePidLock_ThrowsWhenLivePidHoldsLock', async () => {
    // Create a lock file with the current PID (simulating another live process)
    const lockPath = path.join(tempDir, '.event-store.lock');
    await fs.writeFile(lockPath, String(process.pid), 'utf-8');

    const store = new EventStore(tempDir);
    await expect(store.initialize()).rejects.toThrow(PidLockError);
  });

  // T21: Stale lock reclaim
  it('AcquirePidLock_ReclaimsStaleLock_WhenPidDead', async () => {
    // Create a lock file with a PID that is very unlikely to be alive
    const lockPath = path.join(tempDir, '.event-store.lock');
    await fs.writeFile(lockPath, '999999999', 'utf-8');

    const store = new EventStore(tempDir);
    await store.initialize();

    // Lock should be reclaimed with our PID
    const content = await fs.readFile(lockPath, 'utf-8');
    expect(parseInt(content, 10)).toBe(process.pid);
  });

  // T22: Lock file cleanup on process exit
  it('AcquirePidLock_RegistersExitCleanup', async () => {
    const processOnSpy = vi.spyOn(process, 'on');

    const store = new EventStore(tempDir);
    await store.initialize();

    // Verify that an 'exit' handler was registered
    expect(processOnSpy).toHaveBeenCalledWith('exit', expect.any(Function));

    processOnSpy.mockRestore();
  });

  // T23: EventStore initialize acquires PID lock
  it('EventStore_Initialize_AcquiresPidLock', async () => {
    const store = new EventStore(tempDir);

    // Before initialize, lock should not exist
    const lockPath = path.join(tempDir, '.event-store.lock');
    await expect(fs.access(lockPath)).rejects.toThrow();

    await store.initialize();

    // After initialize, lock should exist with our PID
    const content = await fs.readFile(lockPath, 'utf-8');
    expect(parseInt(content, 10)).toBe(process.pid);
  });
});

// ─── T24-T25: Sequence Invariant Validation ──────────────────────────────────

describe('EventStore Sequence Invariant', () => {
  it('InitializeSequence_ValidInvariant_Succeeds', async () => {
    // Create a valid JSONL file where line N has sequence N
    const filePath = path.join(tempDir, 'valid-seq.events.jsonl');
    const events = [
      { streamId: 'valid-seq', sequence: 1, type: 'workflow.started', timestamp: '2025-01-01T00:00:00.000Z', schemaVersion: '1.0' },
      { streamId: 'valid-seq', sequence: 2, type: 'task.assigned', timestamp: '2025-01-01T00:00:01.000Z', schemaVersion: '1.0' },
      { streamId: 'valid-seq', sequence: 3, type: 'workflow.transition', timestamp: '2025-01-01T00:00:02.000Z', schemaVersion: '1.0' },
    ];
    await fs.writeFile(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

    // Delete .seq file to force fallback path
    const seqPath = path.join(tempDir, 'valid-seq.seq');
    await fs.rm(seqPath, { force: true });

    const store = new EventStore(tempDir);
    // Should succeed without error — appending should continue from seq 3
    const event = await store.append('valid-seq', { type: 'task.claimed' });
    expect(event.sequence).toBe(4);
  });

  it('InitializeSequence_BrokenInvariant_Throws', async () => {
    // Create a JSONL file where first line has wrong sequence
    const filePath = path.join(tempDir, 'broken-seq.events.jsonl');
    const events = [
      { streamId: 'broken-seq', sequence: 5, type: 'workflow.started', timestamp: '2025-01-01T00:00:00.000Z', schemaVersion: '1.0' },
      { streamId: 'broken-seq', sequence: 6, type: 'task.assigned', timestamp: '2025-01-01T00:00:01.000Z', schemaVersion: '1.0' },
    ];
    await fs.writeFile(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

    // Delete .seq file to force fallback path with invariant check
    const seqPath = path.join(tempDir, 'broken-seq.seq');
    await fs.rm(seqPath, { force: true });

    const store = new EventStore(tempDir);
    await expect(store.append('broken-seq', { type: 'task.claimed' })).rejects.toThrow(/sequence invariant/i);
  });

  // T25: Blank-line tolerance
  it('InitializeSequence_WithBlankLines_ValidatesCorrectly', async () => {
    // Create a JSONL with blank lines interspersed
    const filePath = path.join(tempDir, 'blank-seq.events.jsonl');
    const events = [
      { streamId: 'blank-seq', sequence: 1, type: 'workflow.started', timestamp: '2025-01-01T00:00:00.000Z', schemaVersion: '1.0' },
      { streamId: 'blank-seq', sequence: 2, type: 'task.assigned', timestamp: '2025-01-01T00:00:01.000Z', schemaVersion: '1.0' },
      { streamId: 'blank-seq', sequence: 3, type: 'workflow.transition', timestamp: '2025-01-01T00:00:02.000Z', schemaVersion: '1.0' },
    ];
    // Insert blank lines between events
    const content = '\n' + JSON.stringify(events[0]) + '\n\n' + JSON.stringify(events[1]) + '\n\n\n' + JSON.stringify(events[2]) + '\n';
    await fs.writeFile(filePath, content, 'utf-8');

    // Delete .seq file to force fallback path
    const seqPath = path.join(tempDir, 'blank-seq.seq');
    await fs.rm(seqPath, { force: true });

    const store = new EventStore(tempDir);
    // Should succeed despite blank lines — sequence count should be 3
    const event = await store.append('blank-seq', { type: 'task.claimed' });
    expect(event.sequence).toBe(4);
  });
});

// ─── T31-T32: Configurable Idempotency Cache ────────────────────────────────

describe('EventStore Configurable Idempotency Cache', () => {
  it('EventStore_RespectsEnvVar_MaxIdempotencyKeys', async () => {
    process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS = '5';
    try {
      const store = new EventStore(tempDir);

      // Append 6 events with unique keys (cache max is 5)
      for (let i = 0; i < 6; i++) {
        await store.append(
          'my-workflow',
          { type: 'task.assigned' },
          { idempotencyKey: `key-${i}` },
        );
      }

      // First key should have been evicted
      const retried = await store.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: 'key-0' },
      );
      expect(retried.sequence).toBe(7); // new event, not deduped
    } finally {
      delete process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS;
    }
  });

  it('EventStore_DefaultsTo200_WhenNoEnvVar', async () => {
    delete process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS;
    const store = new EventStore(tempDir);

    // Append 201 events with unique keys (cache max should be 200)
    for (let i = 0; i < 201; i++) {
      await store.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: `key-${i}` },
      );
    }

    // First key should have been evicted at 200 limit
    const retried = await store.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-0' },
    );
    expect(retried.sequence).toBe(202); // new event, not deduped

    // Most recent key should still be deduped (within the 200 limit)
    const deduped = await store.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-200' },
    );
    expect(deduped.sequence).toBe(201); // deduped
  });

  it('EventStore_InvalidIdempotencyEnvVar_FallsBackToDefault', async () => {
    process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS = 'abc';
    try {
      const store = new EventStore(tempDir);

      // Should use default of 200 — append 201 events
      for (let i = 0; i < 201; i++) {
        await store.append(
          'my-workflow',
          { type: 'task.assigned' },
          { idempotencyKey: `key-${i}` },
        );
      }

      // First key should have been evicted at 200 limit (default)
      const retried = await store.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: 'key-0' },
      );
      expect(retried.sequence).toBe(202);
    } finally {
      delete process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS;
    }
  });
});

// ─── EventStore Outbox Integration ────────────────────────────────────────

describe('EventStore Outbox Integration', () => {
  it('EventStoreAppend_OutboxConfigured_CreatesEntry', async () => {
    const store = new EventStore(tempDir);
    const outbox = new Outbox(tempDir);
    const addEntrySpy = vi.spyOn(outbox, 'addEntry');

    store.setOutbox(outbox);

    const event = await store.append('my-workflow', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    expect(addEntrySpy).toHaveBeenCalledOnce();
    expect(addEntrySpy).toHaveBeenCalledWith('my-workflow', event);
  });

  it('EventStoreAppend_NoOutbox_AppendsNormally', async () => {
    const store = new EventStore(tempDir);

    // No outbox configured — should succeed without error
    const event = await store.append('my-workflow', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    expect(event.sequence).toBe(1);
    expect(event.type).toBe('workflow.started');

    // Verify JSONL was written
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });

  it('EventStoreAppend_OutboxFailure_DoesNotBreakAppend', async () => {
    const store = new EventStore(tempDir);
    const outbox = new Outbox(tempDir);
    vi.spyOn(outbox, 'addEntry').mockRejectedValue(new Error('Outbox disk full'));

    store.setOutbox(outbox);

    // Append should succeed despite outbox failure
    const event = await store.append('my-workflow', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    expect(event.sequence).toBe(1);
    expect(event.type).toBe('workflow.started');

    // Verify JSONL was still written successfully
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.streamId).toBe('my-workflow');
    expect(parsed.sequence).toBe(1);
  });
});

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

// ─── Idempotency Cache Rebuild Race Condition ────────────────────────────────

describe('EventStore Idempotency Cache Race Condition', () => {
  it('rebuildIdempotencyCache_ConcurrentAccess_DoesNotReturnStaleCache', async () => {
    // Arrange: write events with idempotency keys via store1
    const store1 = new EventStore(tempDir);
    await store1.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-a' },
    );
    await store1.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'key-b' },
    );

    // Create a new store instance (simulating restart) — cache is empty
    const store2 = new EventStore(tempDir);

    // Act: fire two concurrent appends with the same idempotency key
    // Both will trigger rebuildIdempotencyCache since the cache is not yet initialized.
    // With the bug (marking initialized BEFORE populating), the second call may
    // see the stream as initialized but find an empty/incomplete cache,
    // leading to a duplicate event instead of deduplication.
    const [resultA, resultB] = await Promise.all([
      store2.append('my-workflow', { type: 'task.assigned' }, { idempotencyKey: 'key-a' }),
      store2.append('my-workflow', { type: 'task.assigned' }, { idempotencyKey: 'key-a' }),
    ]);

    // Assert: both should return the SAME event (deduplication)
    // The original event was sequence 1 with key-a
    expect(resultA.sequence).toBe(1);
    expect(resultB.sequence).toBe(1);

    // No duplicates should have been appended
    const events = await store2.query('my-workflow');
    expect(events).toHaveLength(2); // only the original 2 events
  });

  it('rebuildIdempotencyCache_PartialFailure_DoesNotPermanentlyMarkInitialized', async () => {
    // Arrange: write events with idempotency keys via store1
    const store1 = new EventStore(tempDir);
    await store1.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-a' },
    );
    await store1.append(
      'my-workflow',
      { type: 'task.claimed' },
      { idempotencyKey: 'key-b' },
    );

    // Create a new store (simulating restart)
    const store2 = new EventStore(tempDir);

    // Corrupt the JSONL file AFTER the first valid line — force a JSON.parse error
    // during rebuild. With the bug, the stream gets marked as "initialized" BEFORE
    // the file is read, so even after the error, subsequent calls skip the rebuild
    // and use an empty/stale cache.
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const original = await fs.readFile(filePath, 'utf-8');
    const lines = original.trim().split('\n');
    // Replace second line with an idempotencyKey-containing but invalid JSON
    const corrupted = lines[0] + '\n' + '{"idempotencyKey":"key-b", INVALID_JSON}\n';
    await fs.writeFile(filePath, corrupted, 'utf-8');

    // First attempt: append with idempotency key — triggers rebuildIdempotencyCache
    // The rebuild will encounter a JSON parse error on the corrupted line.
    // With the bug, the stream is marked "initialized" before reading, so the error
    // means the cache stays empty but the flag says it's done.
    try {
      await store2.append(
        'my-workflow',
        { type: 'task.assigned' },
        { idempotencyKey: 'key-a' },
      );
    } catch {
      // Expected: the corrupt JSON may cause an error
    }

    // Fix the file — restore the original valid content
    await fs.writeFile(filePath, original, 'utf-8');

    // Second attempt: with the bug, the cache is marked "initialized" but empty,
    // so key-a won't be found and a DUPLICATE event gets appended.
    // After the fix (marking initialized AFTER populating), the cache won't be
    // marked initialized if the first attempt failed, so rebuild will be retried.
    const result = await store2.append(
      'my-workflow',
      { type: 'task.assigned' },
      { idempotencyKey: 'key-a' },
    );

    // Assert: should deduplicate to original event (sequence 1), NOT create a new event
    expect(result.sequence).toBe(1);
  });
});

// ─── Task 9: EventStore StorageBackend Integration ────────────────────────────

describe('EventStore StorageBackend Integration', () => {
  it('EventStore_query_DelegatesToBackend', async () => {
    const backend = new InMemoryBackend();
    const store = new EventStore(tempDir, { backend });

    // Append an event through the store (writes to JSONL and backend)
    await store.append('my-workflow', { type: 'workflow.started', data: { featureId: 'test' } });

    // Query should delegate to the backend
    const querySpy = vi.spyOn(backend, 'queryEvents');
    const events = await store.query('my-workflow');

    expect(querySpy).toHaveBeenCalledWith('my-workflow', undefined);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('workflow.started');
  });

  it('EventStore_query_WithBackend_DoesNotReadJSONL', async () => {
    const backend = new InMemoryBackend();
    const store = new EventStore(tempDir, { backend });

    await store.append('my-workflow', { type: 'workflow.started', data: { featureId: 'test' } });

    // Delete the JSONL file — if query tried to read it, it would return empty
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    await rm(filePath);

    // Query should still succeed via backend (not JSONL)
    const events = await store.query('my-workflow');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('workflow.started');
  });

  it('EventStore_query_WithoutBackend_FallsBackToJSONL', async () => {
    // No backend — existing behavior
    const store = new EventStore(tempDir);

    await store.append('my-workflow', { type: 'workflow.started', data: { featureId: 'test' } });

    const events = await store.query('my-workflow');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('workflow.started');

    // Verify JSONL file was created (proof of file-based storage)
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });

  it('EventStore_append_WritesToJSONLAndBackend', async () => {
    const backend = new InMemoryBackend();
    const appendSpy = vi.spyOn(backend, 'appendEvent');
    const store = new EventStore(tempDir, { backend });

    const event = await store.append('my-workflow', { type: 'workflow.started', data: { featureId: 'test' } });

    // Backend should have received the event
    expect(appendSpy).toHaveBeenCalledWith('my-workflow', event);

    // JSONL file should also have the event
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });

  it('EventStore_getSequence_DelegatesToBackend', async () => {
    const backend = new InMemoryBackend();
    const store = new EventStore(tempDir, { backend });

    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.transition' });

    const seqSpy = vi.spyOn(backend, 'getSequence');

    // Create a new store with the same backend (simulating restart)
    const store2 = new EventStore(tempDir, { backend });
    const event = await store2.append('my-workflow', { type: 'task.claimed' });

    // Backend's getSequence should have been used for initialization
    expect(seqSpy).toHaveBeenCalledWith('my-workflow');
    expect(event.sequence).toBe(4);
  });

  it('append_BackendWriteFails_StillSucceedsWithWarning', async () => {
    const backend = new InMemoryBackend();
    // Make appendEvent throw an error (simulating disk full, constraint violation, etc.)
    vi.spyOn(backend, 'appendEvent').mockImplementation(() => {
      throw new Error('SQLite disk full');
    });

    const store = new EventStore(tempDir, { backend });

    // The append should still succeed (JSONL is source of truth)
    const event = await store.append('my-workflow', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    expect(event.sequence).toBe(1);
    expect(event.type).toBe('workflow.started');

    // Verify JSONL file was written (source of truth)
    const filePath = path.join(tempDir, 'my-workflow.events.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });

  it('EventStore_query_WithBackend_PassesFilters', async () => {
    const backend = new InMemoryBackend();
    const store = new EventStore(tempDir, { backend });

    await store.append('my-workflow', { type: 'workflow.started' });
    await store.append('my-workflow', { type: 'task.assigned' });
    await store.append('my-workflow', { type: 'workflow.transition' });

    const querySpy = vi.spyOn(backend, 'queryEvents');
    const filters = { type: 'task.assigned' };
    const events = await store.query('my-workflow', filters);

    expect(querySpy).toHaveBeenCalledWith('my-workflow', filters);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('task.assigned');
  });
});

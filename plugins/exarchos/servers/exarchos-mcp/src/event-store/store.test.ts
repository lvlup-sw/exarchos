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

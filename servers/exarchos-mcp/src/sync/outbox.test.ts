import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Outbox } from './outbox.js';
import type { EventSender, ExarchosEventDto } from './types.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { InMemoryBackend } from '../storage/memory-backend.js';

function makeEvent(overrides?: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: '2026-02-15T00:00:00.000Z',
    type: 'task.completed',
    schemaVersion: '1.0',
    ...overrides,
  };
}

describe('Outbox drain idempotencyKey propagation', () => {
  let tempDir: string;
  let outbox: Outbox;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'outbox-idem-test-'));
    outbox = new Outbox(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should propagate idempotencyKey to remote client when draining', async () => {
    // Arrange: create an event with an idempotencyKey
    const eventWithKey = makeEvent({
      idempotencyKey: 'unique-key-123',
      agentId: 'agent-1',
      source: 'test',
    });
    await outbox.addEntry('test-stream', eventWithKey);

    // Capture the events sent to the remote client
    const sentEvents: ExarchosEventDto[][] = [];
    const mockClient: EventSender = {
      appendEvents: vi.fn().mockImplementation(async (_streamId, events) => {
        sentEvents.push(events);
        return { accepted: events.length, streamVersion: 1 };
      }),
    };

    // Act
    const result = await outbox.drain(mockClient, 'test-stream');

    // Assert
    expect(result.sent).toBe(1);
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toHaveLength(1);
    expect(sentEvents[0][0].idempotencyKey).toBe('unique-key-123');
  });

  it('should not include idempotencyKey when event does not have one', async () => {
    // Arrange: event without idempotencyKey
    const eventWithoutKey = makeEvent();
    await outbox.addEntry('test-stream', eventWithoutKey);

    const sentEvents: ExarchosEventDto[][] = [];
    const mockClient: EventSender = {
      appendEvents: vi.fn().mockImplementation(async (_streamId, events) => {
        sentEvents.push(events);
        return { accepted: events.length, streamVersion: 1 };
      }),
    };

    // Act
    await outbox.drain(mockClient, 'test-stream');

    // Assert
    expect(sentEvents[0][0].idempotencyKey).toBeUndefined();
  });
});

// ─── Task 10: Outbox StorageBackend Integration ──────────────────────────────

describe('Outbox StorageBackend Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'outbox-backend-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('Outbox_addEntry_WithBackend_DelegatesToBackend', async () => {
    const backend = new InMemoryBackend();
    const addSpy = vi.spyOn(backend, 'addOutboxEntry');
    const outbox = new Outbox(tempDir, { backend });

    const event = makeEvent();
    await outbox.addEntry('test-stream', event);

    expect(addSpy).toHaveBeenCalledWith('test-stream', event);
  });

  it('Outbox_drain_WithBackend_DelegatesToBackend', async () => {
    const backend = new InMemoryBackend();
    const drainSpy = vi.spyOn(backend, 'drainOutbox');
    const outbox = new Outbox(tempDir, { backend });

    const event = makeEvent();
    await outbox.addEntry('test-stream', event);

    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    const result = await outbox.drain(mockSender, 'test-stream');

    expect(drainSpy).toHaveBeenCalledWith('test-stream', mockSender, 50);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('Outbox_addEntry_WithoutBackend_UsesJSONFile', async () => {
    // No backend — existing behavior
    const outbox = new Outbox(tempDir);

    const event = makeEvent();
    const entry = await outbox.addEntry('test-stream', event);

    expect(entry.id).toBeDefined();
    expect(entry.status).toBe('pending');

    // Verify JSON file was created
    const entries = await outbox.loadEntries('test-stream');
    expect(entries).toHaveLength(1);
    expect(entries[0].event.type).toBe('task.completed');
  });

  it('Outbox_addEntry_WithBackend_ReturnsEntryWithId', async () => {
    const backend = new InMemoryBackend();
    const outbox = new Outbox(tempDir, { backend });

    const event = makeEvent();
    const entry = await outbox.addEntry('test-stream', event);

    // Should return a properly structured entry even with backend
    expect(entry.id).toBeDefined();
    expect(entry.status).toBe('pending');
    expect(entry.streamId).toBe('test-stream');
  });
});

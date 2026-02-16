import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Outbox } from './outbox.js';
import type { EventSender, ExarchosEventDto } from './types.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Outbox } from '../../../src/sync/outbox.js';
import type { EventSender, ExarchosEventDto } from '../../../src/sync/types.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { InMemoryBackend } from '../../../src/storage/memory-backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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
    await rmrfAsync(tempDir);
  });

  it('should propagate idempotencyKey to remote client when draining', async () => {
    const eventWithKey = makeEvent({
      idempotencyKey: 'unique-key-123',
      agentId: 'agent-1',
      source: 'test',
    });
    await outbox.addEntry('test-stream', eventWithKey);

    const sentEvents: ExarchosEventDto[][] = [];
    const mockClient: EventSender = {
      appendEvents: vi.fn().mockImplementation(async (_streamId, events) => {
        sentEvents.push(events);
        return { accepted: events.length, streamVersion: 1 };
      }),
    };

    const result = await outbox.drain(mockClient, 'test-stream');

    expect(result.sent).toBe(1);
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toHaveLength(1);
    expect(sentEvents[0][0].idempotencyKey).toBe('unique-key-123');
  });

  it('should not include idempotencyKey when event does not have one', async () => {
    const eventWithoutKey = makeEvent();
    await outbox.addEntry('test-stream', eventWithoutKey);

    const sentEvents: ExarchosEventDto[][] = [];
    const mockClient: EventSender = {
      appendEvents: vi.fn().mockImplementation(async (_streamId, events) => {
        sentEvents.push(events);
        return { accepted: events.length, streamVersion: 1 };
      }),
    };

    await outbox.drain(mockClient, 'test-stream');

    expect(sentEvents[0][0].idempotencyKey).toBeUndefined();
  });
});

describe('Outbox drain batch I/O', () => {
  let tempDir: string;
  let outbox: Outbox;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'outbox-batch-test-'));
    outbox = new Outbox(tempDir);
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('drain_BatchOfN_LoadsEntriesOnce', async () => {
    for (let i = 1; i <= 3; i++) {
      await outbox.addEntry('test-stream', makeEvent({ sequence: i }));
    }

    const mockClient: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    const loadSpy = vi.spyOn(outbox, 'loadEntries');

    await outbox.drain(mockClient, 'test-stream');

    expect(loadSpy.mock.calls.length).toBe(1);
  });

  /** `saveEntries` is private, so the spy needs the `never` casts. */
  it('drain_BatchOfN_SavesEntriesOnce', async () => {
    for (let i = 1; i <= 3; i++) {
      await outbox.addEntry('test-stream', makeEvent({ sequence: i }));
    }

    const mockClient: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    const saveSpy = vi.spyOn(outbox as never, 'saveEntries' as never);

    await outbox.drain(mockClient, 'test-stream');

    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Outbox StorageBackend Integration', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'outbox-backend-test-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
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
    const outbox = new Outbox(tempDir);

    const event = makeEvent();
    const entry = await outbox.addEntry('test-stream', event);

    expect(entry.id).toBeDefined();
    expect(entry.status).toBe('pending');

    const entries = await outbox.loadEntries('test-stream');
    expect(entries).toHaveLength(1);
    expect(entries[0].event.type).toBe('task.completed');
  });

  /**
   * Two outboxes on one directory write one stream in the same millisecond. A
   * temp name made from `Date.now()` alone is then the same for both writers,
   * and the second rename fails. Both writes must resolve, and the file must
   * stay whole JSON. The test claims no merge: the two writers still race, and
   * the last one wins.
   */
  it('Outbox_TwoOutboxesWriteOneStreamInOneMillisecond_BothResolveAndTheFileIsWhole', async () => {
    const first = new Outbox(tempDir);
    const second = new Outbox(tempDir);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const results = await Promise.allSettled([
        first.addEntry('test-stream', makeEvent({ sequence: 1 })),
        second.addEntry('test-stream', makeEvent({ sequence: 2 })),
      ]);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect((await first.loadEntries('test-stream')).length).toBeGreaterThanOrEqual(1);
    } finally {
      now.mockRestore();
    }
  });

  it('Outbox_addEntry_WithBackend_ReturnsEntryWithId', async () => {
    const backend = new InMemoryBackend();
    const outbox = new Outbox(tempDir, { backend });

    const event = makeEvent();
    const entry = await outbox.addEntry('test-stream', event);

    expect(entry.id).toBeDefined();
    expect(entry.status).toBe('pending');
    expect(entry.streamId).toBe('test-stream');
  });
});

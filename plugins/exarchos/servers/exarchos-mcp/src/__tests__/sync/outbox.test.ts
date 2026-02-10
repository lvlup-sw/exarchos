import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Outbox } from '../../sync/outbox.js';
import type { EventSender } from '../../sync/types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

function makeEvent(overrides?: Partial<WorkflowEvent>): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: '2026-02-08T00:00:00.000Z',
    type: 'task.completed',
    schemaVersion: '1.0',
    ...overrides,
  };
}

describe('Outbox', () => {
  let tempDir: string;
  let outbox: Outbox;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'outbox-test-'));
    outbox = new Outbox(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── addEntry ──────────────────────────────────────────────────────────

  describe('addEntry', () => {
    it('should create an outbox entry and persist to file', async () => {
      const event = makeEvent();
      const entry = await outbox.addEntry('test-stream', event);

      expect(entry.id).toBeTruthy();
      expect(entry.streamId).toBe('test-stream');
      expect(entry.event).toEqual(event);
      expect(entry.status).toBe('pending');
      expect(entry.attempts).toBe(0);
      expect(entry.createdAt).toBeTruthy();

      // Verify file was written
      const filePath = path.join(tempDir, 'test-stream.outbox.json');
      const content = await readFile(filePath, 'utf-8');
      const entries = JSON.parse(content);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
    });

    it('should append to existing entries', async () => {
      const event1 = makeEvent({ sequence: 1 });
      const event2 = makeEvent({ sequence: 2 });

      await outbox.addEntry('test-stream', event1);
      await outbox.addEntry('test-stream', event2);

      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(2);
    });
  });

  // ─── loadEntries ──────────────────────────────────────────────────────

  describe('loadEntries', () => {
    it('should return entries from file', async () => {
      const event = makeEvent();
      await outbox.addEntry('test-stream', event);

      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(1);
      expect(entries[0].event).toEqual(event);
    });

    it('should return empty array when file does not exist', async () => {
      const entries = await outbox.loadEntries('nonexistent');
      expect(entries).toEqual([]);
    });

    it('should return empty array for empty file', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        path.join(tempDir, 'empty.outbox.json'),
        '',
        'utf-8',
      );

      const entries = await outbox.loadEntries('empty');
      expect(entries).toEqual([]);
    });
  });

  // ─── updateEntry ──────────────────────────────────────────────────────

  describe('updateEntry', () => {
    it('should modify entry in place', async () => {
      const event = makeEvent();
      const entry = await outbox.addEntry('test-stream', event);

      await outbox.updateEntry('test-stream', entry.id, {
        status: 'sent',
        attempts: 1,
        lastAttemptAt: '2026-02-08T01:00:00Z',
      });

      const entries = await outbox.loadEntries('test-stream');
      expect(entries[0].status).toBe('sent');
      expect(entries[0].attempts).toBe(1);
      expect(entries[0].lastAttemptAt).toBe('2026-02-08T01:00:00Z');
    });

    it('should not affect other entries', async () => {
      const entry1 = await outbox.addEntry('test-stream', makeEvent({ sequence: 1 }));
      const entry2 = await outbox.addEntry('test-stream', makeEvent({ sequence: 2 }));

      await outbox.updateEntry('test-stream', entry1.id, { status: 'confirmed' });

      const entries = await outbox.loadEntries('test-stream');
      expect(entries.find((e) => e.id === entry1.id)?.status).toBe('confirmed');
      expect(entries.find((e) => e.id === entry2.id)?.status).toBe('pending');
    });
  });

  // ─── removeEntry ──────────────────────────────────────────────────────

  describe('removeEntry', () => {
    it('should remove entry from file', async () => {
      const entry = await outbox.addEntry('test-stream', makeEvent());

      await outbox.removeEntry('test-stream', entry.id);

      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(0);
    });

    it('should preserve other entries', async () => {
      const entry1 = await outbox.addEntry('test-stream', makeEvent({ sequence: 1 }));
      await outbox.addEntry('test-stream', makeEvent({ sequence: 2 }));

      await outbox.removeEntry('test-stream', entry1.id);

      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(1);
      expect(entries[0].event.sequence).toBe(2);
    });
  });

  // ─── drain ──────────────────────────────────────────────────────────────

  describe('drain', () => {
    function mockClient(
      overrides?: Partial<EventSender>,
    ): EventSender {
      return {
        appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
        ...overrides,
      };
    }

    it('should send pending entries via client and mark confirmed', async () => {
      const client = mockClient();
      await outbox.addEntry('test-stream', makeEvent());

      const result = await outbox.drain(client, 'test-stream');

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
      expect(client.appendEvents).toHaveBeenCalledOnce();

      const entries = await outbox.loadEntries('test-stream');
      expect(entries[0].status).toBe('confirmed');
    });

    it('should increment attempts on failure and calculate backoff', async () => {
      const client = mockClient({
        appendEvents: vi.fn().mockRejectedValue(new Error('network error')),
      });
      await outbox.addEntry('test-stream', makeEvent());

      const result = await outbox.drain(client, 'test-stream');

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);

      const entries = await outbox.loadEntries('test-stream');
      expect(entries[0].attempts).toBe(1);
      expect(entries[0].nextRetryAt).toBeTruthy();
      expect(entries[0].error).toBe('network error');
    });

    it('should dead-letter after 10 attempts', async () => {
      const client = mockClient({
        appendEvents: vi.fn().mockRejectedValue(new Error('persistent error')),
      });
      const entry = await outbox.addEntry('test-stream', makeEvent());

      // Manually set attempts to 9 (next failure = 10th attempt = dead-letter)
      await outbox.updateEntry('test-stream', entry.id, { attempts: 9 });

      await outbox.drain(client, 'test-stream');

      const entries = await outbox.loadEntries('test-stream');
      expect(entries[0].status).toBe('dead-letter');
    });

    it('should return noop when no pending entries', async () => {
      const client = mockClient();
      const result = await outbox.drain(client, 'test-stream');
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
    });

    it('should respect batch size', async () => {
      const client = mockClient();
      for (let i = 0; i < 5; i++) {
        await outbox.addEntry('test-stream', makeEvent({ sequence: i + 1 }));
      }

      const result = await outbox.drain(client, 'test-stream', 2);
      expect(result.sent).toBe(2);
    });
  });

  // ─── calculateNextRetry ───────────────────────────────────────────────

  describe('calculateNextRetry', () => {
    it('should use exponential backoff: 1s, 2s, 4s, 8s...', () => {
      const now = Date.now();
      vi.useFakeTimers({ now });

      // attempt 1 -> 1s
      const retry1 = outbox.calculateNextRetry(1);
      expect(new Date(retry1).getTime() - now).toBe(1000);

      // attempt 2 -> 2s
      const retry2 = outbox.calculateNextRetry(2);
      expect(new Date(retry2).getTime() - now).toBe(2000);

      // attempt 3 -> 4s
      const retry3 = outbox.calculateNextRetry(3);
      expect(new Date(retry3).getTime() - now).toBe(4000);

      vi.useRealTimers();
    });

    it('should cap at 60s', () => {
      const now = Date.now();
      vi.useFakeTimers({ now });

      // attempt 10 -> 2^9 * 1000 = 512_000 -> capped at 60_000
      const retry = outbox.calculateNextRetry(10);
      expect(new Date(retry).getTime() - now).toBe(60_000);

      vi.useRealTimers();
    });
  });

  // ─── cleanup ──────────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('should remove confirmed entries older than maxAge', async () => {
      const entry = await outbox.addEntry('test-stream', makeEvent());
      // Mark as confirmed with old timestamp
      const oldDate = new Date(Date.now() - 100_000).toISOString();
      await outbox.updateEntry('test-stream', entry.id, {
        status: 'confirmed',
        lastAttemptAt: oldDate,
      });

      const removed = await outbox.cleanup('test-stream', 50_000);
      expect(removed).toBe(1);

      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(0);
    });

    it('should preserve dead-letter entries', async () => {
      const entry = await outbox.addEntry('test-stream', makeEvent());
      const oldDate = new Date(Date.now() - 100_000).toISOString();
      await outbox.updateEntry('test-stream', entry.id, {
        status: 'dead-letter',
        lastAttemptAt: oldDate,
        error: 'failed permanently',
      });

      const removed = await outbox.cleanup('test-stream', 50_000);
      expect(removed).toBe(0);

      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe('dead-letter');
    });

    it('should preserve recent confirmed entries', async () => {
      const entry = await outbox.addEntry('test-stream', makeEvent());
      await outbox.updateEntry('test-stream', entry.id, {
        status: 'confirmed',
        lastAttemptAt: new Date().toISOString(),
      });

      const removed = await outbox.cleanup('test-stream', 86400000);
      expect(removed).toBe(0);

      const entries = await outbox.loadEntries('test-stream');
      expect(entries).toHaveLength(1);
    });
  });
});

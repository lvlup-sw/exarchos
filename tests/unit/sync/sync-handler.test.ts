import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { handleSyncNow } from '../../../src/sync/sync-handler.js';
import { Outbox } from '../../../src/sync/outbox.js';
import type { EventSender, OutboxEntry } from '../../../src/sync/types.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('handleSyncNow', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'sync-handler-test-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('should drain pending outbox entries for discovered streams when sender provided', async () => {
    const outbox1 = [
      {
        id: 'entry-1',
        streamId: 'stream-a',
        event: {
          streamId: 'stream-a',
          sequence: 1,
          timestamp: '2026-02-15T00:00:00Z',
          type: 'task.completed',
          schemaVersion: '1.0',
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-02-15T00:00:00Z',
      },
    ];
    const outbox2 = [
      {
        id: 'entry-2',
        streamId: 'stream-b',
        event: {
          streamId: 'stream-b',
          sequence: 1,
          timestamp: '2026-02-15T00:00:00Z',
          type: 'workflow.started',
          schemaVersion: '1.0',
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-02-15T00:00:00Z',
      },
    ];

    await writeFile(
      path.join(tempDir, 'stream-a.outbox.json'),
      JSON.stringify(outbox1),
      'utf-8',
    );
    await writeFile(
      path.join(tempDir, 'stream-b.outbox.json'),
      JSON.stringify(outbox2),
      'utf-8',
    );

    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    const result = await handleSyncNow(tempDir, undefined, mockSender);

    expect(result.success).toBe(true);
    const data = result.data as { streams: number; results: Array<Record<string, unknown>>; message: string };
    expect(data.streams).toBe(2);
    expect(data.results).toHaveLength(2);
  });

  it('should return success with 0 streams when no outbox files exist', async () => {
    const result = await handleSyncNow(tempDir);

    expect(result.success).toBe(true);
    const data = result.data as { streams: number; message: string };
    expect(data.streams).toBe(0);
  });

  it('should use ctx.outbox when provided instead of creating a new instance', async () => {
    const outboxEntries = [
      {
        id: 'entry-shared',
        streamId: 'shared-stream',
        event: {
          streamId: 'shared-stream',
          sequence: 1,
          timestamp: '2026-02-15T00:00:00Z',
          type: 'task.completed',
          schemaVersion: '1.0',
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-02-15T00:00:00Z',
      },
    ];
    await writeFile(
      path.join(tempDir, 'shared-stream.outbox.json'),
      JSON.stringify(outboxEntries),
      'utf-8',
    );

    const sharedOutbox = new Outbox(tempDir);
    const drainSpy = vi.spyOn(sharedOutbox, 'drain');

    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    const result = await handleSyncNow(tempDir, sharedOutbox, mockSender);

    expect(result.success).toBe(true);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledWith(mockSender, 'shared-stream');
  });

  it('should include local-mode message when no sender is provided', async () => {
    const outbox = [
      {
        id: 'entry-1',
        streamId: 'my-stream',
        event: {
          streamId: 'my-stream',
          sequence: 1,
          timestamp: '2026-02-15T00:00:00Z',
          type: 'task.completed',
          schemaVersion: '1.0',
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-02-15T00:00:00Z',
      },
    ];
    await writeFile(
      path.join(tempDir, 'my-stream.outbox.json'),
      JSON.stringify(outbox),
      'utf-8',
    );

    const result = await handleSyncNow(tempDir);

    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('Local mode');
    expect(data.message).toContain('drain skipped');
  });

  it('should skip outbox drain in local mode and leave entries pending', async () => {
    const outboxEntries = [
      {
        id: 'entry-local-1',
        streamId: 'local-stream',
        event: {
          streamId: 'local-stream',
          sequence: 1,
          timestamp: '2026-02-15T00:00:00Z',
          type: 'task.completed',
          schemaVersion: '1.0',
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-02-15T00:00:00Z',
      },
      {
        id: 'entry-local-2',
        streamId: 'local-stream',
        event: {
          streamId: 'local-stream',
          sequence: 2,
          timestamp: '2026-02-15T00:01:00Z',
          type: 'task.completed',
          schemaVersion: '1.0',
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-02-15T00:01:00Z',
      },
    ];
    await writeFile(
      path.join(tempDir, 'local-stream.outbox.json'),
      JSON.stringify(outboxEntries),
      'utf-8',
    );

    const result = await handleSyncNow(tempDir);

    expect(result.success).toBe(true);

    const raw = await readFile(
      path.join(tempDir, 'local-stream.outbox.json'),
      'utf-8',
    );
    const entries = JSON.parse(raw) as OutboxEntry[];
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe('pending');
    expect(entries[1].status).toBe('pending');
  });

  it('should drain outbox when a sender is provided', async () => {
    const outboxEntries = [
      {
        id: 'entry-remote-1',
        streamId: 'remote-stream',
        event: {
          streamId: 'remote-stream',
          sequence: 1,
          timestamp: '2026-02-15T00:00:00Z',
          type: 'task.completed',
          schemaVersion: '1.0',
        },
        status: 'pending',
        attempts: 0,
        createdAt: '2026-02-15T00:00:00Z',
      },
    ];
    await writeFile(
      path.join(tempDir, 'remote-stream.outbox.json'),
      JSON.stringify(outboxEntries),
      'utf-8',
    );

    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    const result = await handleSyncNow(tempDir, undefined, mockSender);

    expect(result.success).toBe(true);
    const data = result.data as { streams: number; results: Array<{ sent: number; failed: number }> };
    expect(data.streams).toBe(1);
    expect(data.results[0].sent).toBe(1);
    expect(data.results[0].failed).toBe(0);

    expect(mockSender.appendEvents).toHaveBeenCalledTimes(1);

    const raw = await readFile(
      path.join(tempDir, 'remote-stream.outbox.json'),
      'utf-8',
    );
    const entries = JSON.parse(raw) as OutboxEntry[];
    expect(entries[0].status).toBe('confirmed');
  });
});

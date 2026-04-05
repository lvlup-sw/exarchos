import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { handleSyncNow } from './sync-handler.js';
import { Outbox } from './outbox.js';
import type { EventSender, OutboxEntry } from './types.js';

describe('handleSyncNow', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'sync-handler-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should drain pending outbox entries for discovered streams when sender provided', async () => {
    // Arrange: create outbox files with pending entries for two streams
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

    // Arrange: mock sender that succeeds
    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    // Act: pass sender to trigger actual drain
    const result = await handleSyncNow(tempDir, undefined, mockSender);

    // Assert: result should indicate success and report drained streams
    expect(result.success).toBe(true);
    const data = result.data as { streams: number; results: Array<Record<string, unknown>>; message: string };
    expect(data.streams).toBe(2);
    expect(data.results).toHaveLength(2);
  });

  it('should return success with 0 streams when no outbox files exist', async () => {
    // Act
    const result = await handleSyncNow(tempDir);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { streams: number; message: string };
    expect(data.streams).toBe(0);
  });

  it('should use ctx.outbox when provided instead of creating a new instance', async () => {
    // Arrange: create an outbox file with a pending entry
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

    // Create a shared Outbox instance and spy on its drain method
    const sharedOutbox = new Outbox(tempDir);
    const drainSpy = vi.spyOn(sharedOutbox, 'drain');

    // Arrange: mock sender so drain actually happens
    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    // Act: pass the shared outbox and sender to handleSyncNow
    const result = await handleSyncNow(tempDir, sharedOutbox, mockSender);

    // Assert: the shared outbox's drain was called (not a new instance's)
    expect(result.success).toBe(true);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledWith(mockSender, 'shared-stream');
  });

  it('should include local-mode message when no sender is provided', async () => {
    // Arrange: create an outbox file
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

    // Act: no sender passed (local mode)
    const result = await handleSyncNow(tempDir);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('Local mode');
    expect(data.message).toContain('drain skipped');
  });

  it('should skip outbox drain in local mode and leave entries pending', async () => {
    // Arrange: create outbox file with pending entries
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

    // Act: call without sender (local mode)
    const result = await handleSyncNow(tempDir);

    // Assert: result indicates local mode
    expect(result.success).toBe(true);

    // Assert: entries remain pending (not confirmed)
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
    // Arrange: create outbox file with pending entries
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

    // Create a mock sender that succeeds
    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    // Act: pass a sender to trigger drain
    const result = await handleSyncNow(tempDir, undefined, mockSender);

    // Assert: result indicates drain happened
    expect(result.success).toBe(true);
    const data = result.data as { streams: number; results: Array<{ sent: number; failed: number }> };
    expect(data.streams).toBe(1);
    expect(data.results[0].sent).toBe(1);
    expect(data.results[0].failed).toBe(0);

    // Assert: sender was actually called
    expect(mockSender.appendEvents).toHaveBeenCalledTimes(1);

    // Assert: entry is now confirmed
    const raw = await readFile(
      path.join(tempDir, 'remote-stream.outbox.json'),
      'utf-8',
    );
    const entries = JSON.parse(raw) as OutboxEntry[];
    expect(entries[0].status).toBe('confirmed');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { handleSyncNow } from './sync-handler.js';
import { Outbox } from './outbox.js';

describe('handleSyncNow', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'sync-handler-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should drain pending outbox entries for discovered streams', async () => {
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

    // Act
    const result = await handleSyncNow(tempDir);

    // Assert: result should indicate success and report drained streams
    expect(result.success).toBe(true);
    const data = result.data as { streams: number; message: string };
    expect(data.streams).toBe(2);
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

    // Act: pass the shared outbox to handleSyncNow
    const result = await handleSyncNow(tempDir, sharedOutbox);

    // Assert: the shared outbox's drain was called (not a new instance's)
    expect(result.success).toBe(true);
    expect(drainSpy).toHaveBeenCalledTimes(1);
    expect(drainSpy).toHaveBeenCalledWith(expect.anything(), 'shared-stream');
  });

  it('should include no-remote-configured message when no remote is configured', async () => {
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

    // Act
    const result = await handleSyncNow(tempDir);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { message: string };
    expect(data.message).toContain('no remote configured');
  });
});

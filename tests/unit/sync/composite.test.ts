import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleSyncNow } from '../../../src/sync/sync-handler.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { EventSender } from '../../../src/sync/types.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const NOW = '2026-01-15T12:00:00.000Z';

function makeOutboxEntry(
  streamId: string,
  sequence: number,
  status: 'pending' | 'confirmed' = 'pending',
) {
  const event: WorkflowEvent = {
    streamId,
    sequence,
    timestamp: NOW,
    type: 'workflow.started',
    schemaVersion: '1.0',
  };
  return {
    id: `entry-${streamId}-${sequence}`,
    streamId,
    event,
    status,
    attempts: 0,
    createdAt: NOW,
  };
}

describe('handleSyncNow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-sync-test-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('handleSyncNow_DiscoverStreams_ReturnsStreamList', async () => {
    const entries1 = [makeOutboxEntry('stream-a', 1)];
    const entries2 = [makeOutboxEntry('stream-b', 1)];
    await fs.writeFile(
      path.join(tmpDir, 'stream-a.outbox.json'),
      JSON.stringify(entries1),
    );
    await fs.writeFile(
      path.join(tmpDir, 'stream-b.outbox.json'),
      JSON.stringify(entries2),
    );

    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    const result = await handleSyncNow(tmpDir, undefined, mockSender);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.streams).toBe(2);
    const results = data.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    const streamIds = results.map(r => r.streamId);
    expect(streamIds).toContain('stream-a');
    expect(streamIds).toContain('stream-b');
  });

  it('handleSyncNow_DrainOutbox_CallsSenderForPendingEvents', async () => {
    const entries = [
      makeOutboxEntry('test-stream', 1, 'pending'),
      makeOutboxEntry('test-stream', 2, 'pending'),
    ];
    await fs.writeFile(
      path.join(tmpDir, 'test-stream.outbox.json'),
      JSON.stringify(entries),
    );

    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    };

    const result = await handleSyncNow(tmpDir, undefined, mockSender);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.streams).toBe(1);
    const results = data.results as Array<{ streamId: string; sent: number; failed: number }>;
    expect(results).toHaveLength(1);
    expect(results[0].streamId).toBe('test-stream');
    expect(results[0].sent).toBe(2);
    expect(results[0].failed).toBe(0);
  });

  it('handleSyncNow_NoStreams_ReturnsZeroCounts', async () => {
    const result = await handleSyncNow(tmpDir);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.streams).toBe(0);
    expect(data.message).toContain('No outbox streams found');
  });

  /**
   * The outbox file holds invalid JSON, so `Outbox.loadEntries` throws and
   * `handleSyncNow` returns `SYNC_FAILED`. The test passes a sender, because
   * `handleSyncNow` skips the drain without one.
   */
  it('handleSyncNow_SenderFailure_ReportsFailedCount', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'broken-stream.outbox.json'),
      'NOT_VALID_JSON{{{',
    );

    const mockSender: EventSender = {
      appendEvents: vi.fn().mockResolvedValue({ accepted: 0, streamVersion: 0 }),
    };

    const result = await handleSyncNow(tmpDir, undefined, mockSender);

    expect(result.success).toBe(false);
    const error = result.error as { code: string; message: string };
    expect(error.code).toBe('SYNC_FAILED');
    expect(error.message).toBeDefined();
  });
});

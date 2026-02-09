import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-store/store.js';
import {
  handleStackStatus,
  handleStackPlace,
} from '../../stack/tools.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'stack-tools-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── A18: Stack MCP Tools ──────────────────────────────────────────────────

describe('handleStackStatus', () => {
  it('with positions returns stack state', async () => {
    // Arrange: Append stack.position-filled events to EventStore
    await store.append('wf-001', {
      type: 'stack.position-filled',
      data: { position: 1, taskId: 't1', branch: 'feature/t1' },
    });
    await store.append('wf-001', {
      type: 'stack.position-filled',
      data: { position: 2, taskId: 't2', branch: 'feature/t2', prUrl: 'https://github.com/pr/1' },
    });

    // Act
    const result = await handleStackStatus({ streamId: 'wf-001' }, tempDir);

    // Assert
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const positions = result.data as Array<{ position: number; taskId: string; branch?: string; prUrl?: string }>;
    expect(positions).toHaveLength(2);
    expect(positions[0]).toEqual(
      expect.objectContaining({ position: 1, taskId: 't1', branch: 'feature/t1' }),
    );
    expect(positions[1]).toEqual(
      expect.objectContaining({ position: 2, taskId: 't2', branch: 'feature/t2', prUrl: 'https://github.com/pr/1' }),
    );
  });

  it('without streamId returns empty positions', async () => {
    const result = await handleStackStatus({}, tempDir);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('with non-existent stream returns empty positions', async () => {
    const result = await handleStackStatus({ streamId: 'non-existent' }, tempDir);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('filters only stack.position-filled events', async () => {
    // Append mixed events
    await store.append('wf-001', {
      type: 'task.completed',
      data: { taskId: 't1' },
    });
    await store.append('wf-001', {
      type: 'stack.position-filled',
      data: { position: 1, taskId: 't1', branch: 'feature/t1' },
    });
    await store.append('wf-001', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2' },
    });

    const result = await handleStackStatus({ streamId: 'wf-001' }, tempDir);

    expect(result.success).toBe(true);
    const positions = result.data as Array<{ position: number; taskId: string }>;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual(
      expect.objectContaining({ position: 1, taskId: 't1' }),
    );
  });
});

describe('handleStackPlace', () => {
  it('valid position emits stack event', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: 1, taskId: 't1', branch: 'feature/t1' },
      tempDir,
    );

    expect(result.success).toBe(true);

    // Verify event was emitted
    const events = await store.query('wf-001', { type: 'stack.position-filled' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        position: 1,
        taskId: 't1',
        branch: 'feature/t1',
      }),
    );
  });

  it('with prUrl includes it in event data', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: 2, taskId: 't2', prUrl: 'https://github.com/pr/42' },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'stack.position-filled' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        position: 2,
        taskId: 't2',
        prUrl: 'https://github.com/pr/42',
      }),
    );
  });

  it('missing streamId returns error', async () => {
    const result = await handleStackPlace(
      { streamId: '', position: 1, taskId: 't1' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('missing taskId returns error', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: 1, taskId: '' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('status after place reflects new position', async () => {
    // Place a position
    await handleStackPlace(
      { streamId: 'wf-001', position: 1, taskId: 't1', branch: 'feature/t1' },
      tempDir,
    );

    // Check status
    const status = await handleStackStatus({ streamId: 'wf-001' }, tempDir);

    expect(status.success).toBe(true);
    const positions = status.data as Array<{ position: number; taskId: string; branch?: string }>;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toEqual(
      expect.objectContaining({ position: 1, taskId: 't1', branch: 'feature/t1' }),
    );
  });

  it('multiple places accumulate positions', async () => {
    await handleStackPlace(
      { streamId: 'wf-001', position: 1, taskId: 't1', branch: 'feature/t1' },
      tempDir,
    );
    await handleStackPlace(
      { streamId: 'wf-001', position: 2, taskId: 't2', branch: 'feature/t2' },
      tempDir,
    );
    await handleStackPlace(
      { streamId: 'wf-001', position: 3, taskId: 't3' },
      tempDir,
    );

    const status = await handleStackStatus({ streamId: 'wf-001' }, tempDir);

    expect(status.success).toBe(true);
    const positions = status.data as Array<{ position: number; taskId: string }>;
    expect(positions).toHaveLength(3);
    expect(positions[0].position).toBe(1);
    expect(positions[1].position).toBe(2);
    expect(positions[2].position).toBe(3);
  });

  it('negative position returns INVALID_INPUT', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: -1, taskId: 't1' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('position must be a non-negative integer');
  });

  it('float position returns INVALID_INPUT', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: 1.5, taskId: 't1' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('position must be a non-negative integer');
  });

  it('NaN position returns INVALID_INPUT', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: NaN, taskId: 't1' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('position must be a non-negative integer');
  });

  it('without optional branch and prUrl includes only required fields', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: 0, taskId: 't1' },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'stack.position-filled' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({ position: 0, taskId: 't1' });
    expect(events[0].data).not.toHaveProperty('branch');
    expect(events[0].data).not.toHaveProperty('prUrl');
  });

  it('when store.append() throws returns PLACE_FAILED', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: 1, taskId: 't1' },
      '/nonexistent/path/that/does/not/exist',
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PLACE_FAILED');
    expect(result.error?.message).toBeDefined();
  });
});

describe('handleStackStatus error path', () => {
  it('when store.query() throws returns STATUS_FAILED', async () => {
    // Use an invalid stream ID (uppercase chars) to trigger validateStreamId error
    const result = await handleStackStatus(
      { streamId: 'INVALID_STREAM_ID!!' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATUS_FAILED');
    expect(result.error?.message).toBeDefined();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-store/store.js';
import {
  handleStackStatus,
  handleStackPlace,
  registerStackTools,
} from '../../stack/tools.js';
import { resetMaterializerCache } from '../../views/tools.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  resetMaterializerCache();
  tempDir = await mkdtemp(path.join(tmpdir(), 'stack-tools-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  resetMaterializerCache();
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

  it('success returns EventAck with only streamId, sequence, type keys', async () => {
    const result = await handleStackPlace(
      { streamId: 'wf-001', position: 1, taskId: 't1', branch: 'feature/t1' },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const keys = Object.keys(result.data as Record<string, unknown>).sort();
    expect(keys).toEqual(['sequence', 'streamId', 'type']);
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

// ─── Pagination ─────────────────────────────────────────────────────────────

describe('handleStackStatus pagination', () => {
  async function seedPositions(streamId: string, count: number): Promise<void> {
    for (let i = 1; i <= count; i++) {
      await store.append(streamId, {
        type: 'stack.position-filled',
        data: { position: i, taskId: `t${i}`, branch: `feature/t${i}` },
      });
    }
  }

  it('with limit returns subset of positions', async () => {
    // Arrange
    await seedPositions('wf-paginate', 10);

    // Act
    const result = await handleStackStatus(
      { streamId: 'wf-paginate', limit: 3 },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const positions = result.data as Array<{ position: number; taskId: string }>;
    expect(positions).toHaveLength(3);
    expect(positions[0].taskId).toBe('t1');
    expect(positions[1].taskId).toBe('t2');
    expect(positions[2].taskId).toBe('t3');
  });

  it('with offset and limit skips and returns correct positions', async () => {
    // Arrange
    await seedPositions('wf-paginate-offset', 10);

    // Act
    const result = await handleStackStatus(
      { streamId: 'wf-paginate-offset', offset: 5, limit: 3 },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const positions = result.data as Array<{ position: number; taskId: string }>;
    expect(positions).toHaveLength(3);
    expect(positions[0].taskId).toBe('t6');
    expect(positions[1].taskId).toBe('t7');
    expect(positions[2].taskId).toBe('t8');
  });

  it('without pagination params returns all positions', async () => {
    // Arrange
    await seedPositions('wf-paginate-all', 10);

    // Act
    const result = await handleStackStatus(
      { streamId: 'wf-paginate-all' },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const positions = result.data as Array<{ position: number; taskId: string }>;
    expect(positions).toHaveLength(10);
  });

  it('with offset beyond array length returns empty', async () => {
    // Arrange
    await seedPositions('wf-paginate-beyond', 5);

    // Act
    const result = await handleStackStatus(
      { streamId: 'wf-paginate-beyond', offset: 10 },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const positions = result.data as Array<{ position: number; taskId: string }>;
    expect(positions).toHaveLength(0);
  });

  it('with only offset returns remaining positions', async () => {
    // Arrange
    await seedPositions('wf-paginate-offset-only', 5);

    // Act
    const result = await handleStackStatus(
      { streamId: 'wf-paginate-offset-only', offset: 3 },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const positions = result.data as Array<{ position: number; taskId: string }>;
    expect(positions).toHaveLength(2);
    expect(positions[0].taskId).toBe('t4');
    expect(positions[1].taskId).toBe('t5');
  });
});

// ─── Task 005: StackView CQRS Rewire ─────────────────────────────────────────
// These tests intentionally duplicate scenarios from the handleStackStatus suite
// above (same assertions, different streamId). They exist as explicit regression
// documentation for the Task 005 CQRS rewire: they verify that the materializer-
// based code path produces identical results to the prior direct EventStore access
// implementation, ensuring the refactor introduced no behavioral changes.

describe('handleStackStatus CQRS rewire', () => {
  it('handleStackStatus_AfterRewire_ReturnsCorrectPositions', async () => {
    // Arrange: place positions via store (simulating the event-sourced path)
    await store.append('wf-rewire', {
      type: 'stack.position-filled',
      data: { position: 1, taskId: 't1', branch: 'feature/t1' },
    });
    await store.append('wf-rewire', {
      type: 'stack.position-filled',
      data: { position: 2, taskId: 't2', branch: 'feature/t2', prUrl: 'https://github.com/pr/2' },
    });

    // Act
    const result = await handleStackStatus({ streamId: 'wf-rewire' }, tempDir);

    // Assert: same results as before the rewire
    expect(result.success).toBe(true);
    const positions = result.data as Array<{ position: number; taskId: string; branch?: string; prUrl?: string }>;
    expect(positions).toHaveLength(2);
    expect(positions[0]).toEqual(
      expect.objectContaining({ position: 1, taskId: 't1', branch: 'feature/t1' }),
    );
    expect(positions[1]).toEqual(
      expect.objectContaining({ position: 2, taskId: 't2', branch: 'feature/t2', prUrl: 'https://github.com/pr/2' }),
    );
  });

  it('handleStackStatus_NoStreamId_ReturnsEmpty', async () => {
    const result = await handleStackStatus({}, tempDir);

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});

// ─── EventStore Consolidation ────────────────────────────────────────────────

describe('registerStackTools', () => {
  it('should accept eventStore parameter in registration', () => {
    const mockServer = { tool: vi.fn() } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    expect(() => registerStackTools(mockServer, tempDir, store)).not.toThrow();
    expect(registerStackTools.length).toBe(3);
  });

  it('should register handlers that use the provided EventStore', async () => {
    const mockServer = { tool: vi.fn() } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    registerStackTools(mockServer, tempDir, store);

    const result = await handleStackPlace(
      { streamId: 'wf-consolidation', position: 1, taskId: 't1', branch: 'feature/t1' },
      tempDir,
    );
    expect(result.success).toBe(true);

    const events = await store.query('wf-consolidation', { type: 'stack.position-filled' });
    expect(events).toHaveLength(1);
  });

  it('both handlers share the same EventStore via getOrCreateEventStore', async () => {
    // Without registration, both handlers use getOrCreateEventStore which caches
    // a singleton — events written by handleStackPlace should be visible to handleStackStatus
    const result1 = await handleStackPlace(
      { streamId: 'wf-cache-test', position: 1, taskId: 't1', branch: 'feat/t1' },
      tempDir,
    );
    expect(result1.success).toBe(true);

    const result2 = await handleStackPlace(
      { streamId: 'wf-cache-test', position: 2, taskId: 't2', branch: 'feat/t2' },
      tempDir,
    );
    expect(result2.success).toBe(true);

    // Both events should be visible via status (same cached store instance)
    const status = await handleStackStatus({ streamId: 'wf-cache-test' }, tempDir);
    expect(status.success).toBe(true);
    const positions = status.data as Array<{ position: number; taskId: string }>;
    expect(positions).toHaveLength(2);
  });
});

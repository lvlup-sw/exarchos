import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { handleEventAppend, handleEventQuery } from '../../event-store/tools.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-tools-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Event Append Tool ──────────────────────────────────────────────────────

describe('handleEventAppend', () => {
  it('should append a valid event and return success', async () => {
    const result = await handleEventAppend(
      {
        stream: 'my-workflow',
        event: {
          type: 'workflow.started',
          data: { featureId: 'test-feature' },
        },
      },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.streamId).toBe('my-workflow');
    expect(result.data!.sequence).toBe(1);
    expect(result.data!.type).toBe('workflow.started');
  });

  it('should increment sequence on multiple appends', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
    );
    const result = await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'team.formed' } },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.data!.sequence).toBe(2);
  });

  it('should return error for missing stream', async () => {
    const result = await handleEventAppend(
      { stream: '', event: { type: 'task.assigned' } },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return error for missing event type', async () => {
    const result = await handleEventAppend(
      { stream: 'my-workflow', event: {} },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should support optimistic concurrency via expectedSequence', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
    );

    // Correct expected sequence
    const result = await handleEventAppend(
      {
        stream: 'my-workflow',
        event: { type: 'team.formed' },
        expectedSequence: 1,
      },
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.data!.sequence).toBe(2);
  });

  it('should return conflict error for stale expectedSequence', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'team.formed' } },
      tempDir,
    );

    // Expected 1, but actual is 2
    const result = await handleEventAppend(
      {
        stream: 'my-workflow',
        event: { type: 'phase.transitioned' },
        expectedSequence: 1,
      },
      tempDir,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SEQUENCE_CONFLICT');
  });
});

// ─── Event Query Tool ───────────────────────────────────────────────────────

describe('handleEventQuery', () => {
  it('should return all events for a stream', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'team.formed' } },
      tempDir,
    );

    const result = await handleEventQuery({ stream: 'my-workflow' }, tempDir);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('should filter by type', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'task.assigned' } },
      tempDir,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
    );

    const result = await handleEventQuery(
      { stream: 'my-workflow', filter: { type: 'workflow.started' } },
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('should filter by sinceSequence', async () => {
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'workflow.started' } },
      tempDir,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'team.formed' } },
      tempDir,
    );
    await handleEventAppend(
      { stream: 'my-workflow', event: { type: 'phase.transitioned' } },
      tempDir,
    );

    const result = await handleEventQuery(
      { stream: 'my-workflow', filter: { sinceSequence: 2 } },
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.data![0].sequence).toBe(3);
  });

  it('should return empty for nonexistent stream', async () => {
    const result = await handleEventQuery({ stream: 'nonexistent' }, tempDir);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('should return error when stream is missing', async () => {
    const result = await handleEventQuery({}, tempDir);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ─── handleEventQuery Pagination ─────────────────────────────────────────────

describe('handleEventQuery Pagination', () => {
  it('handleEventQuery_WithLimit_PassesToStore', async () => {
    for (let i = 0; i < 5; i++) {
      await handleEventAppend(
        { stream: 'my-workflow', event: { type: 'task.assigned' } },
        tempDir,
      );
    }

    const result = await handleEventQuery(
      { stream: 'my-workflow', limit: 2 },
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('handleEventQuery_WithOffset_PassesToStore', async () => {
    for (let i = 0; i < 5; i++) {
      await handleEventAppend(
        { stream: 'my-workflow', event: { type: 'task.assigned' } },
        tempDir,
      );
    }

    const result = await handleEventQuery(
      { stream: 'my-workflow', offset: 3 },
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('handleEventQuery_WithLimitAndOffset_Combined', async () => {
    for (let i = 0; i < 10; i++) {
      await handleEventAppend(
        { stream: 'my-workflow', event: { type: 'task.assigned' } },
        tempDir,
      );
    }

    const result = await handleEventQuery(
      { stream: 'my-workflow', limit: 3, offset: 2 },
      tempDir,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
  });
});

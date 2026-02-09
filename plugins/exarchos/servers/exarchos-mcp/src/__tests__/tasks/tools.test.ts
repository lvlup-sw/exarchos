import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-store/store.js';
import {
  handleTaskClaim,
  handleTaskComplete,
  handleTaskFail,
} from '../../tasks/tools.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'task-tools-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ─── A17: Task MCP Tools ────────────────────────────────────────────────────

describe('handleTaskClaim', () => {
  it('valid task emits claimed event', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'task.claimed' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        taskId: 't1',
        agentId: 'agent-1',
      }),
    );
    expect((events[0].data as Record<string, unknown>).claimedAt).toBeDefined();
  });

  it('missing taskId returns error', async () => {
    const result = await handleTaskClaim(
      { taskId: '', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('missing streamId returns error', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: '' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('missing agentId returns error', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: '', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('agentId is required');
  });

  it('store.append() failure returns CLAIM_FAILED error', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      '/nonexistent/path/claim-test',
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CLAIM_FAILED');
  });
});

describe('handleTaskComplete', () => {
  it('with artifacts emits completed event', async () => {
    const result = await handleTaskComplete(
      {
        taskId: 't1',
        result: { artifacts: ['login.ts', 'login.test.ts'], duration: 120 },
        streamId: 'wf-001',
      },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'task.completed' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        taskId: 't1',
        artifacts: ['login.ts', 'login.test.ts'],
        duration: 120,
      }),
    );
  });

  it('without result still emits completed event', async () => {
    const result = await handleTaskComplete(
      { taskId: 't1', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'task.completed' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({ taskId: 't1' }),
    );
  });

  it('missing streamId returns error', async () => {
    const result = await handleTaskComplete(
      { taskId: 't1', streamId: '' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('streamId is required');
  });

  it('with artifacts but no duration only includes artifacts in event data', async () => {
    const result = await handleTaskComplete(
      {
        taskId: 't1',
        result: { artifacts: ['auth.ts', 'auth.test.ts'] },
        streamId: 'wf-002',
      },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-002', { type: 'task.completed' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        taskId: 't1',
        artifacts: ['auth.ts', 'auth.test.ts'],
      }),
    );
    expect((events[0].data as Record<string, unknown>).duration).toBeUndefined();
  });

  it('store.append() failure returns COMPLETE_FAILED error', async () => {
    const result = await handleTaskComplete(
      { taskId: 't1', streamId: 'wf-001' },
      '/nonexistent/path/complete-test',
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('COMPLETE_FAILED');
  });
});

describe('handleTaskFail', () => {
  it('with diagnostics emits failed event', async () => {
    const result = await handleTaskFail(
      {
        taskId: 't1',
        error: 'Compilation error',
        diagnostics: { file: 'login.ts', line: 42 },
        streamId: 'wf-001',
      },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'task.failed' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        taskId: 't1',
        error: 'Compilation error',
        diagnostics: { file: 'login.ts', line: 42 },
      }),
    );
  });

  it('without diagnostics still emits failed event', async () => {
    const result = await handleTaskFail(
      { taskId: 't1', error: 'Unknown error', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);

    const events = await store.query('wf-001', { type: 'task.failed' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual(
      expect.objectContaining({
        taskId: 't1',
        error: 'Unknown error',
      }),
    );
  });

  it('missing error returns error', async () => {
    const result = await handleTaskFail(
      { taskId: 't1', error: '', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('missing streamId returns error', async () => {
    const result = await handleTaskFail(
      { taskId: 't1', error: 'some error', streamId: '' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('streamId is required');
  });

  it('store.append() failure returns FAIL_FAILED error', async () => {
    const result = await handleTaskFail(
      { taskId: 't1', error: 'some error', streamId: 'wf-001' },
      '/nonexistent/path/fail-test',
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FAIL_FAILED');
  });
});

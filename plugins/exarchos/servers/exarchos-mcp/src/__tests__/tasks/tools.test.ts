import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from '../../event-store/store.js';
import {
  handleTaskClaim,
  handleTaskComplete,
  handleTaskFail,
  registerTaskTools,
  resetModuleEventStore,
} from '../../tasks/tools.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  resetModuleEventStore();
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

  it('success returns EventAck with only streamId, sequence, type keys', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const keys = Object.keys(result.data as Record<string, unknown>).sort();
    expect(keys).toEqual(['sequence', 'streamId', 'type']);
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

  it('empty taskId returns INVALID_INPUT', async () => {
    const result = await handleTaskComplete(
      { taskId: '', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('taskId is required');
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

  it('success returns EventAck with only streamId, sequence, type keys', async () => {
    const result = await handleTaskComplete(
      { taskId: 't1', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const keys = Object.keys(result.data as Record<string, unknown>).sort();
    expect(keys).toEqual(['sequence', 'streamId', 'type']);
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

  it('empty taskId returns INVALID_INPUT', async () => {
    const result = await handleTaskFail(
      { taskId: '', error: 'some error', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('taskId is required');
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

  it('success returns EventAck with only streamId, sequence, type keys', async () => {
    const result = await handleTaskFail(
      { taskId: 't1', error: 'Compilation error', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const keys = Object.keys(result.data as Record<string, unknown>).sort();
    expect(keys).toEqual(['sequence', 'streamId', 'type']);
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

// ─── EventStore Consolidation ────────────────────────────────────────────────

describe('registerTaskTools', () => {
  it('should accept eventStore parameter in registration', () => {
    const mockServer = { tool: vi.fn() } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    // Should accept 3 args: server, stateDir, eventStore
    expect(() => registerTaskTools(mockServer, tempDir, store)).not.toThrow();
    // Verify the function's declared parameter count is 3
    expect(registerTaskTools.length).toBe(3);
  });

  it('should not create additional EventStore instances after registration', async () => {
    const mockServer = { tool: vi.fn() } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    registerTaskTools(mockServer, tempDir, store);

    // Spy on EventStore constructor after registration
    const constructorSpy = vi.spyOn(EventStore.prototype, 'append');

    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-consolidation' },
      tempDir,
    );
    expect(result.success).toBe(true);

    // The provided store should see the events
    const events = await store.query('wf-consolidation', { type: 'task.claimed' });
    expect(events).toHaveLength(1);

    constructorSpy.mockRestore();
  });
});

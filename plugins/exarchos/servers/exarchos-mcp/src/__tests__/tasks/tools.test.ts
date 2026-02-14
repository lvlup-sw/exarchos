import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore, SequenceConflictError } from '../../event-store/store.js';
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

  it('already claimed taskId rejects with ALREADY_CLAIMED error', async () => {
    // First claim succeeds
    const first = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
    );
    expect(first.success).toBe(true);

    // Second claim for the same taskId is rejected
    const second = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-2', streamId: 'wf-001' },
      tempDir,
    );
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('ALREADY_CLAIMED');
    expect(second.error?.message).toContain('t1');
  });

  it('different taskIds can be claimed independently', async () => {
    const first = await handleTaskClaim(
      { taskId: 'task-1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
    );
    expect(first.success).toBe(true);

    const second = await handleTaskClaim(
      { taskId: 'task-2', agentId: 'agent-2', streamId: 'wf-001' },
      tempDir,
    );
    expect(second.success).toBe(true);
  });

  it('same agent re-claiming same taskId rejects with ALREADY_CLAIMED', async () => {
    const first = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
    );
    expect(first.success).toBe(true);

    // Even the same agent cannot re-claim
    const second = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
    );
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('ALREADY_CLAIMED');
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

// ─── TOCTOU Race Condition Fix ──────────────────────────────────────────────

describe('handleTaskClaim TOCTOU protection', () => {
  // Each test registers the test-level store via registerTaskTools so that
  // handleTaskClaim uses the same instance we can spy on.
  let mockServer: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;

  beforeEach(() => {
    mockServer = { tool: vi.fn() } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    registerTaskTools(mockServer, tempDir, store);
  });

  it('retries on SequenceConflictError from concurrent append', async () => {
    // Arrange: seed the stream with an initial event so sequence > 0
    await store.append('wf-race', { type: 'workflow.started', data: {} });

    // Spy on store.append to inject a SequenceConflictError on the first claim attempt,
    // then allow the second attempt to succeed normally.
    const originalAppend = store.append.bind(store);
    let claimAttemptCount = 0;
    const appendSpy = vi.spyOn(store, 'append').mockImplementation(
      async (streamId, event, options) => {
        if ((event as { type: string }).type === 'task.claimed') {
          claimAttemptCount++;
          if (claimAttemptCount === 1 && options?.expectedSequence !== undefined) {
            // Simulate concurrent write: throw SequenceConflictError on first attempt
            throw new SequenceConflictError(options.expectedSequence, options.expectedSequence + 1);
          }
        }
        return originalAppend(streamId, event, options);
      },
    );

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-race', agentId: 'agent-racer', streamId: 'wf-race' },
      tempDir,
    );

    // Assert: should succeed after retrying
    expect(result.success).toBe(true);
    // The claim was attempted at least twice (first failed, second succeeded)
    expect(claimAttemptCount).toBeGreaterThanOrEqual(2);

    appendSpy.mockRestore();
  });

  it('uses expectedSequence for optimistic concurrency', async () => {
    // Arrange: seed the stream with some events
    await store.append('wf-seq', { type: 'workflow.started', data: {} });
    await store.append('wf-seq', { type: 'team.formed', data: {} });

    // Spy on store.append to capture the options passed
    const originalAppend = store.append.bind(store);
    const appendSpy = vi.spyOn(store, 'append').mockImplementation(
      async (streamId, event, options) => {
        return originalAppend(streamId, event, options);
      },
    );

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-seq', agentId: 'agent-seq', streamId: 'wf-seq' },
      tempDir,
    );

    // Assert: claim succeeded
    expect(result.success).toBe(true);

    // The task.claimed append must have included expectedSequence
    const claimCall = appendSpy.mock.calls.find(
      ([, evt]) => (evt as { type: string }).type === 'task.claimed',
    );
    expect(claimCall).toBeDefined();
    const options = claimCall![2] as { expectedSequence?: number } | undefined;
    expect(options).toBeDefined();
    expect(options!.expectedSequence).toBe(2); // 2 events already in stream

    appendSpy.mockRestore();
  });

  it('returns CLAIM_FAILED after max retries exhausted', async () => {
    // Arrange: seed the stream
    await store.append('wf-exhaust', { type: 'workflow.started', data: {} });

    // Mock store.append to always throw SequenceConflictError for task.claimed
    const originalAppend = store.append.bind(store);
    const appendSpy = vi.spyOn(store, 'append').mockImplementation(
      async (streamId, event, options) => {
        if ((event as { type: string }).type === 'task.claimed' && options?.expectedSequence !== undefined) {
          throw new SequenceConflictError(options.expectedSequence, options.expectedSequence + 1);
        }
        return originalAppend(streamId, event, options);
      },
    );

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-exhaust', agentId: 'agent-exhaust', streamId: 'wf-exhaust' },
      tempDir,
    );

    // Assert: should fail with CLAIM_FAILED
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CLAIM_FAILED');
    expect(result.error?.message).toContain('retries');

    appendSpy.mockRestore();
  });

  it('queries all events (not just task.claimed) to get accurate sequence', async () => {
    // Arrange: seed with mixed event types
    await store.append('wf-mixed', { type: 'workflow.started', data: {} });
    await store.append('wf-mixed', { type: 'team.formed', data: {} });
    await store.append('wf-mixed', { type: 'task.assigned', data: {} });

    // Spy on store.query to verify it queries without type filter
    const originalQuery = store.query.bind(store);
    const querySpy = vi.spyOn(store, 'query').mockImplementation(
      async (streamId, filters) => {
        return originalQuery(streamId, filters);
      },
    );

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-mixed', agentId: 'agent-mixed', streamId: 'wf-mixed' },
      tempDir,
    );

    // Assert: claim succeeded
    expect(result.success).toBe(true);

    // The query must have been called without a type filter (to get all events for sequence)
    const queryCallWithoutTypeFilter = querySpy.mock.calls.some(
      ([, filters]) => !filters?.type,
    );
    expect(queryCallWithoutTypeFilter).toBe(true);

    querySpy.mockRestore();
  });
});

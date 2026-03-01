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
import {
  getOrCreateEventStore,
  resetMaterializerCache,
} from '../../views/tools.js';

let tempDir: string;
let store: EventStore;

beforeEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  tempDir = await mkdtemp(path.join(tmpdir(), 'task-tools-test-'));
  store = new EventStore(tempDir);
});

afterEach(async () => {
  resetMaterializerCache();
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
    // Seed passing TDD compliance + static analysis gates for this task
    await store.append('wf-001', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't1' } },
    });
    await store.append('wf-001', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't1' } },
    });

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
    // Seed passing TDD compliance + static analysis gates for this task
    await store.append('wf-001', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't1' } },
    });
    await store.append('wf-001', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't1' } },
    });

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
    // Seed passing TDD compliance + static analysis gates for this task
    await store.append('wf-002', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't1' } },
    });
    await store.append('wf-002', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't1' } },
    });

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
    // Seed passing TDD compliance + static analysis gates for this task
    await store.append('wf-001', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't1' } },
    });
    await store.append('wf-001', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't1' } },
    });

    const result = await handleTaskComplete(
      { taskId: 't1', streamId: 'wf-001' },
      tempDir,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const keys = Object.keys(result.data as Record<string, unknown>).sort();
    expect(keys).toEqual(['sequence', 'streamId', 'type']);
  });

  it('store.append() failure returns GATE_NOT_PASSED when no gate event exists', async () => {
    // With a nonexistent path, the gate query returns empty results,
    // so the gate check fails before reaching the append
    const result = await handleTaskComplete(
      { taskId: 't1', streamId: 'wf-001' },
      '/nonexistent/path/complete-test',
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
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

  it('should use shared EventStore singleton after registration', async () => {
    const mockServer = { tool: vi.fn() } as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer;
    registerTaskTools(mockServer, tempDir, store);

    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-consolidation' },
      tempDir,
    );
    expect(result.success).toBe(true);

    // The events should be readable from the JSONL file via any EventStore instance
    const events = await store.query('wf-consolidation', { type: 'task.claimed' });
    expect(events).toHaveLength(1);
  });
});

// ─── TOCTOU Race Condition Fix ──────────────────────────────────────────────

describe('handleTaskClaim TOCTOU protection', () => {
  // Get the shared singleton store that handleTaskClaim actually uses
  let sharedStore: EventStore;

  beforeEach(() => {
    // Trigger singleton creation so we can spy on the correct instance
    sharedStore = getOrCreateEventStore(tempDir);
  });

  it('retries on SequenceConflictError from concurrent append', async () => {
    // Arrange: seed the stream with an initial event so sequence > 0
    await sharedStore.append('wf-race', { type: 'workflow.started', data: {} });

    // Spy on sharedStore.append to inject a SequenceConflictError on the first claim attempt,
    // then allow the second attempt to succeed normally.
    const originalAppend = sharedStore.append.bind(sharedStore);
    let claimAttemptCount = 0;
    const appendSpy = vi.spyOn(sharedStore, 'append').mockImplementation(
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
    await sharedStore.append('wf-seq', { type: 'workflow.started', data: {} });
    await sharedStore.append('wf-seq', { type: 'task.assigned', data: {} });

    // Spy on sharedStore.append to capture the options passed
    const originalAppend = sharedStore.append.bind(sharedStore);
    const appendSpy = vi.spyOn(sharedStore, 'append').mockImplementation(
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
    await sharedStore.append('wf-exhaust', { type: 'workflow.started', data: {} });

    // Mock sharedStore.append to always throw SequenceConflictError for task.claimed
    const originalAppend = sharedStore.append.bind(sharedStore);
    const appendSpy = vi.spyOn(sharedStore, 'append').mockImplementation(
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
    await sharedStore.append('wf-mixed', { type: 'workflow.started', data: {} });
    await sharedStore.append('wf-mixed', { type: 'workflow.transition', data: {} });
    await sharedStore.append('wf-mixed', { type: 'task.assigned', data: {} });

    // Spy on sharedStore.query to verify it queries without type filter
    const originalQuery = sharedStore.query.bind(sharedStore);
    const querySpy = vi.spyOn(sharedStore, 'query').mockImplementation(
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

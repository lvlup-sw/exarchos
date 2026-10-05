import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore, SequenceConflictError } from '../../../src/events/store.js';
import {
  handleTaskClaim,
  handleTaskComplete,
  handleTaskFail,
  resetModuleEventStore,
} from '../../../src/verbs/tasks/tools.js';
import {
  resetMaterializerCache,
} from '../../../src/projections/views/tools.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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
  await rmrfAsync(tempDir);
});

describe('handleTaskClaim', () => {
  it('valid task emits claimed event', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
      store,
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
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('missing streamId returns error', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: '' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('missing agentId returns error', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: '', streamId: 'wf-001' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('agentId is required');
  });

  it('success returns EventAck with only streamId, sequence, type keys', async () => {
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
      store,
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
    const first = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
      store,
    );
    expect(first.success).toBe(true);

    const second = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-2', streamId: 'wf-001' },
      tempDir,
      store,
    );
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('ALREADY_CLAIMED');
    expect(second.error?.message).toContain('t1');
  });

  it('different taskIds can be claimed independently', async () => {
    const first = await handleTaskClaim(
      { taskId: 'task-1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
      store,
    );
    expect(first.success).toBe(true);

    const second = await handleTaskClaim(
      { taskId: 'task-2', agentId: 'agent-2', streamId: 'wf-001' },
      tempDir,
      store,
    );
    expect(second.success).toBe(true);
  });

  it('same agent re-claiming same taskId rejects with ALREADY_CLAIMED', async () => {
    const first = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
      store,
    );
    expect(first.success).toBe(true);

    const second = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-1', streamId: 'wf-001' },
      tempDir,
      store,
    );
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('ALREADY_CLAIMED');
  });
});

/** `handleTaskComplete` needs a passing `static-analysis` gate event, so each success test seeds one. */
describe('handleTaskComplete', () => {
  it('with artifacts emits completed event', async () => {
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
      store,
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
      store,
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
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('taskId is required');
  });

  /** The message names `streamId` and the `featureId` alias. The test does not pin the full text. */
  it('missing streamId returns error', async () => {
    const result = await handleTaskComplete(
      { taskId: 't1', streamId: '' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('streamId is required');
    expect(result.error?.message).toContain('featureId');
  });

  it('with artifacts but no duration only includes artifacts in event data', async () => {
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
      store,
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
      store,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const keys = Object.keys(result.data as Record<string, unknown>).sort();
    expect(keys).toEqual(['sequence', 'streamId', 'type']);
  });

  /** The store holds no gate event, so the gate check fails before the handler appends. */
  it('store.append() failure returns GATE_NOT_PASSED when no gate event exists', async () => {
    const result = await handleTaskComplete(
      { taskId: 't1', streamId: 'wf-001' },
      '/nonexistent/path/complete-test',
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });
});

/**
 * `static-analysis` is a blocking gate, so no caller evidence replaces its `gate.executed` event.
 * The evidence type, the `passed` flag and the output do not change that result.
 */
describe('handleTaskComplete evidence cannot satisfy a blocking gate (DR-2)', () => {
  /** The handler also writes no `task.completed` event. */
  it('handleTaskComplete_ManualEvidencePassed_DoesNotBypassGates', async () => {
    const result = await handleTaskComplete(
      {
        taskId: 't-manual',
        evidence: { type: 'manual', output: 'docs-only task', passed: true },
        streamId: 'wf-manual',
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');

    const events = await store.query('wf-manual', { type: 'task.completed' });
    expect(events).toHaveLength(0);
  });

  it('handleTaskComplete_ManualEvidenceFailed_StillRequiresGates', async () => {
    const result = await handleTaskComplete(
      {
        taskId: 't-manual-fail',
        evidence: { type: 'manual', output: 'did not pass', passed: false },
        streamId: 'wf-manual-fail',
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  it('handleTaskComplete_NonManualEvidenceWithPassedAndOutput_DoesNotBypassGates', async () => {
    const result = await handleTaskComplete(
      {
        taskId: 't-test-type',
        evidence: { type: 'test', output: 'all passed', passed: true },
        streamId: 'wf-test-type',
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  it('handleTaskComplete_NonManualEvidenceWithEmptyOutput_StillRequiresGates', async () => {
    const result = await handleTaskComplete(
      {
        taskId: 't-test-empty',
        evidence: { type: 'test', output: '', passed: true },
        streamId: 'wf-test-empty',
      },
      tempDir,
      store,
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
      store,
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
      store,
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
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toBe('taskId is required');
  });

  it('missing error returns error', async () => {
    const result = await handleTaskFail(
      { taskId: 't1', error: '', streamId: 'wf-001' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  /** The message names `streamId` and the `featureId` alias. The test does not pin the full text. */
  it('missing streamId returns error', async () => {
    const result = await handleTaskFail(
      { taskId: 't1', error: 'some error', streamId: '' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('streamId is required');
    expect(result.error?.message).toContain('featureId');
  });

  it('success returns EventAck with only streamId, sequence, type keys', async () => {
    const result = await handleTaskFail(
      { taskId: 't1', error: 'Compilation error', streamId: 'wf-001' },
      tempDir,
      store,
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

/**
 * Each spy wraps the `store` instance that the test passes to `handleTaskClaim`, so the spy sees
 * the real write path.
 */
describe('handleTaskClaim TOCTOU protection', () => {
  let sharedStore: EventStore;

  beforeEach(() => {
    sharedStore = store;
  });

  /**
   * The spy throws `SequenceConflictError` on the first `task.claimed` append, as a concurrent
   * write does. It passes each later append to the store.
   */
  it('retries on SequenceConflictError from concurrent append', async () => {
    await sharedStore.append('wf-race', { type: 'workflow.started', data: {} });

    const originalAppend = sharedStore.append.bind(sharedStore);
    let claimAttemptCount = 0;
    const appendSpy = vi.spyOn(sharedStore, 'append').mockImplementation(
      async (streamId, event, options) => {
        if ((event as { type: string }).type === 'task.claimed') {
          claimAttemptCount++;
          if (claimAttemptCount === 1 && options?.expectedSequence !== undefined) {
            throw new SequenceConflictError(options.expectedSequence, options.expectedSequence + 1);
          }
        }
        return originalAppend(streamId, event, options);
      },
    );

    const result = await handleTaskClaim(
      { taskId: 't-race', agentId: 'agent-racer', streamId: 'wf-race' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    expect(claimAttemptCount).toBeGreaterThanOrEqual(2);

    appendSpy.mockRestore();
  });

  /** The stream holds two events before the claim, so the claim pins `expectedSequence` to 2. */
  it('uses expectedSequence for optimistic concurrency', async () => {
    await sharedStore.append('wf-seq', { type: 'workflow.started', data: {} });
    await sharedStore.append('wf-seq', { type: 'task.assigned', data: {} });

    const originalAppend = sharedStore.append.bind(sharedStore);
    const appendSpy = vi.spyOn(sharedStore, 'append').mockImplementation(
      async (streamId, event, options) => {
        return originalAppend(streamId, event, options);
      },
    );

    const result = await handleTaskClaim(
      { taskId: 't-seq', agentId: 'agent-seq', streamId: 'wf-seq' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);

    const claimCall = appendSpy.mock.calls.find(
      ([, evt]) => (evt as { type: string }).type === 'task.claimed',
    );
    expect(claimCall).toBeDefined();
    const options = claimCall![2] as { expectedSequence?: number } | undefined;
    expect(options).toBeDefined();
    expect(options!.expectedSequence).toBe(2);

    appendSpy.mockRestore();
  });

  /** The spy throws `SequenceConflictError` for every `task.claimed` append. */
  it('returns CLAIM_FAILED after max retries exhausted', async () => {
    await sharedStore.append('wf-exhaust', { type: 'workflow.started', data: {} });

    const originalAppend = sharedStore.append.bind(sharedStore);
    const appendSpy = vi.spyOn(sharedStore, 'append').mockImplementation(
      async (streamId, event, options) => {
        if ((event as { type: string }).type === 'task.claimed' && options?.expectedSequence !== undefined) {
          throw new SequenceConflictError(options.expectedSequence, options.expectedSequence + 1);
        }
        return originalAppend(streamId, event, options);
      },
    );

    const result = await handleTaskClaim(
      { taskId: 't-exhaust', agentId: 'agent-exhaust', streamId: 'wf-exhaust' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CLAIM_FAILED');
    expect(result.error?.message).toContain('retries');

    appendSpy.mockRestore();
  });

  /**
   * `attemptTaskClaim` takes the sequence pin from `foldToTail`. The assertion passes when one
   * `store.query` call or more has no `type` filter.
   */
  it('queries all events (not just task.claimed) to get accurate sequence', async () => {
    await sharedStore.append('wf-mixed', { type: 'workflow.started', data: {} });
    await sharedStore.append('wf-mixed', { type: 'workflow.transition', data: {} });
    await sharedStore.append('wf-mixed', { type: 'task.assigned', data: {} });

    const originalQuery = sharedStore.query.bind(sharedStore);
    const querySpy = vi.spyOn(sharedStore, 'query').mockImplementation(
      async (streamId, filters) => {
        return originalQuery(streamId, filters);
      },
    );

    const result = await handleTaskClaim(
      { taskId: 't-mixed', agentId: 'agent-mixed', streamId: 'wf-mixed' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);

    const queryCallWithoutTypeFilter = querySpy.mock.calls.some(
      ([, filters]) => !filters?.type,
    );
    expect(queryCallWithoutTypeFilter).toBe(true);

    querySpy.mockRestore();
  });
});

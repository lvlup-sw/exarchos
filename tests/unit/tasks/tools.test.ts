import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore, SequenceConflictError } from '../../../src/events/store.js';
import { TaskCompletedData } from '../../../src/events/schemas.js';
import { handleTaskClaim, handleTaskComplete, handleTaskFail, resetModuleEventStore } from '../../../src/verbs/tasks/tools.js';
import { resetMaterializerCache } from '../../../src/projections/views/tools.js';
import { initStateFile, readStateFile } from '../../../src/workflow/state-store.js';
import { guards } from '../../../src/workflow/guards.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let tempDir: string;

beforeEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  tempDir = await mkdtemp(path.join(tmpdir(), 'task-tools-unit-'));
});

afterEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  await rmrfAsync(tempDir);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('handleTaskClaim (materialized view)', () => {
  it('should return ALREADY_CLAIMED when task-detail view shows task is claimed', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-mat', {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Test task', assignee: 'agent-1' },
    });
    await store.append('wf-mat', {
      type: 'task.claimed',
      data: { taskId: 't1', agentId: 'agent-1', claimedAt: new Date().toISOString() },
      agentId: 'agent-1',
    });

    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-2', streamId: 'wf-mat' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
    expect(result.error?.message).toContain('t1');
  });

  it('should return ALREADY_CLAIMED when task-detail view shows task is completed', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-comp', {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Completed task', assignee: 'agent-1' },
    });
    await store.append('wf-comp', {
      type: 'task.claimed',
      data: { taskId: 't2', agentId: 'agent-1', claimedAt: new Date().toISOString() },
      agentId: 'agent-1',
    });
    await store.append('wf-comp', {
      type: 'task.completed',
      data: { taskId: 't2' },
    });

    const result = await handleTaskClaim(
      { taskId: 't2', agentId: 'agent-2', streamId: 'wf-comp' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
  });

  it('should return ALREADY_CLAIMED when task-detail view shows task is failed', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-fail', {
      type: 'task.assigned',
      data: { taskId: 't3', title: 'Failed task', assignee: 'agent-1' },
    });
    await store.append('wf-fail', {
      type: 'task.claimed',
      data: { taskId: 't3', agentId: 'agent-1', claimedAt: new Date().toISOString() },
      agentId: 'agent-1',
    });
    await store.append('wf-fail', {
      type: 'task.failed',
      data: { taskId: 't3', error: 'something broke' },
    });

    const result = await handleTaskClaim(
      { taskId: 't3', agentId: 'agent-2', streamId: 'wf-fail' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
  });

  /** The view holds no entry for a task with no `task.assigned` event, so the handler scans the raw events. */
  it('should return ALREADY_CLAIMED via fallback when task.completed exists without task.assigned', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-fb-comp', {
      type: 'task.completed',
      data: { taskId: 't5' },
    });

    const result = await handleTaskClaim(
      { taskId: 't5', agentId: 'agent-1', streamId: 'wf-fb-comp' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
  });

  /** The view holds no entry for a task with no `task.assigned` event, so the handler scans the raw events. */
  it('should return ALREADY_CLAIMED via fallback when task.failed exists without task.assigned', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-fb-fail', {
      type: 'task.failed',
      data: { taskId: 't6', error: 'something broke' },
    });

    const result = await handleTaskClaim(
      { taskId: 't6', agentId: 'agent-1', streamId: 'wf-fb-fail' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
  });

  it('should allow claim when task exists but is only assigned (not yet claimed)', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-open', {
      type: 'task.assigned',
      data: { taskId: 't4', title: 'Open task', assignee: 'agent-1' },
    });

    const result = await handleTaskClaim(
      { taskId: 't4', agentId: 'agent-1', streamId: 'wf-open' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
  });
});

/**
 * `Math.random` returns 0, so the jitter is zero and each delay is exact. Each test replaces
 * `setTimeout` with a spy that calls the callback at once, so `sleep` does not wait. Each test
 * seeds the stream before it installs the spy.
 */
describe('handleTaskClaim Exponential Backoff', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Every append throws `SequenceConflictError`, so the claim makes three attempts and appends
   * once in each. The delays are 50 ms, 100 ms and 200 ms, which is `50 * 2^attempt`.
   */
  it('HandleTaskClaim_Retries_WithExponentialBackoff', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-backoff', {
      type: 'task.assigned',
      data: { taskId: 't-bo', title: 'Backoff task', assignee: 'agent-1' },
    });

    const capturedDelays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void, ms?: number) => {
      capturedDelays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    let appendCallCount = 0;
    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function () {
      appendCallCount++;
      throw new SequenceConflictError(0, 1);
    });

    const result = await handleTaskClaim(
      { taskId: 't-bo', agentId: 'agent-1', streamId: 'wf-backoff' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CLAIM_FAILED');

    expect(appendCallCount).toBe(3);

    expect(capturedDelays).toHaveLength(3);
    expect(capturedDelays[0]).toBe(50);
    expect(capturedDelays[1]).toBe(100);
    expect(capturedDelays[2]).toBe(200);
  });

  it('HandleTaskClaim_StillReturnsClaimFailed_AfterRetries', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-retry-fail', {
      type: 'task.assigned',
      data: { taskId: 't-rf', title: 'Retry fail task', assignee: 'agent-1' },
    });

    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function () {
      throw new SequenceConflictError(0, 1);
    });

    const result = await handleTaskClaim(
      { taskId: 't-rf', agentId: 'agent-1', streamId: 'wf-retry-fail' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CLAIM_FAILED');
    expect(result.error?.message).toContain('retries');
  });

  /**
   * The three delays sum to 350 ms (50 + 100 + 200). The handler applies no cap, so this sum is
   * the only bound that the test checks.
   */
  it('HandleTaskClaim_BackoffCapped_AtReasonableMax', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-cap', {
      type: 'task.assigned',
      data: { taskId: 't-cap', title: 'Capped task', assignee: 'agent-1' },
    });

    const capturedDelays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void, ms?: number) => {
      capturedDelays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function () {
      throw new SequenceConflictError(0, 1);
    });

    const result = await handleTaskClaim(
      { taskId: 't-cap', agentId: 'agent-1', streamId: 'wf-cap' },
      tempDir,
      store,
    );

    const totalRequestedDelay = capturedDelays.reduce((sum, d) => sum + d, 0);
    expect(totalRequestedDelay).toBe(350);
    expect(result.success).toBe(false);
  });
});

describe('Task event idempotency keys', () => {
  it('handleTaskComplete_EventAppend_HasIdempotencyKey', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-idem-comp', {
      type: 'task.assigned',
      data: { taskId: 't-idem-1', title: 'Idem test', assignee: 'agent-1' },
    });
    await store.append('wf-idem-comp', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-idem-1' } },
    });
    await store.append('wf-idem-comp', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-idem-1' } },
    });

    const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
    const originalAppend = store.append.bind(store);
    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function (
      this: EventStore,
      streamId: string,
      event: Parameters<EventStore['append']>[1],
      options?: Parameters<EventStore['append']>[2],
    ) {
      appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
      return originalAppend(streamId, event, options);
    });

    const result = await handleTaskComplete(
      { taskId: 't-idem-1', streamId: 'wf-idem-comp' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const completedCalls = appendCalls.filter((c) => c.type === 'task.completed');
    expect(completedCalls.length).toBe(1);
    expect(completedCalls[0].idempotencyKey).toBe('wf-idem-comp:task.completed:t-idem-1');
  });

  it('handleTaskFail_EventAppend_HasIdempotencyKey', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-idem-fail', {
      type: 'task.assigned',
      data: { taskId: 't-idem-2', title: 'Idem fail test', assignee: 'agent-1' },
    });

    const appendCalls: Array<{ type: string; idempotencyKey?: string }> = [];
    const originalAppend = store.append.bind(store);
    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function (
      this: EventStore,
      streamId: string,
      event: Parameters<EventStore['append']>[1],
      options?: Parameters<EventStore['append']>[2],
    ) {
      appendCalls.push({ type: event.type, idempotencyKey: options?.idempotencyKey });
      return originalAppend(streamId, event, options);
    });

    const result = await handleTaskFail(
      { taskId: 't-idem-2', error: 'Something broke', streamId: 'wf-idem-fail' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const failedCalls = appendCalls.filter((c) => c.type === 'task.failed');
    expect(failedCalls.length).toBe(1);
    expect(failedCalls[0].idempotencyKey).toBe('wf-idem-fail:task.failed:t-idem-2');
  });
});

describe('task_complete evidence field', () => {
  it('TaskComplete_WithEvidence_StoresInEventData', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-ev-1', {
      type: 'task.assigned',
      data: { taskId: 't-ev-1', title: 'Evidence test', assignee: 'agent-1' },
    });
    await store.append('wf-ev-1', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-ev-1' } },
    });
    await store.append('wf-ev-1', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-ev-1' } },
    });

    const evidence = {
      type: 'test' as const,
      output: 'PASS src/foo.test.ts (5 tests)',
      passed: true,
    };

    const result = await handleTaskComplete(
      { taskId: 't-ev-1', streamId: 'wf-ev-1', evidence },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = await store.query('wf-ev-1');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    expect(completedEvent).toBeDefined();
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.evidence).toEqual(evidence);
    expect(data.verified).toBe(true);
  });

  it('TaskComplete_WithoutEvidence_MarksUnverified', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-ev-2', {
      type: 'task.assigned',
      data: { taskId: 't-ev-2', title: 'No evidence test', assignee: 'agent-1' },
    });
    await store.append('wf-ev-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-ev-2' } },
    });
    await store.append('wf-ev-2', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-ev-2' } },
    });

    const result = await handleTaskComplete(
      { taskId: 't-ev-2', streamId: 'wf-ev-2' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = await store.query('wf-ev-2');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    expect(completedEvent).toBeDefined();
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.evidence).toBeUndefined();
    expect(data.verified).toBe(false);
  });

  it('TaskComplete_EvidenceContainsTestOutput_Stored', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-ev-3', {
      type: 'task.assigned',
      data: { taskId: 't-ev-3', title: 'Test output evidence', assignee: 'agent-1' },
    });
    await store.append('wf-ev-3', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-ev-3' } },
    });
    await store.append('wf-ev-3', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-ev-3' } },
    });

    const evidence = {
      type: 'test' as const,
      output: 'Tests: 42 passed, 0 failed\nTime: 3.2s',
      passed: true,
    };

    const result = await handleTaskComplete(
      { taskId: 't-ev-3', streamId: 'wf-ev-3', evidence },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = await store.query('wf-ev-3');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.evidence).toEqual(evidence);
    expect((data.evidence as Record<string, unknown>).type).toBe('test');
    expect(data.verified).toBe(true);
  });

  it('TaskComplete_EvidenceContainsBuildOutput_Stored', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-ev-4', {
      type: 'task.assigned',
      data: { taskId: 't-ev-4', title: 'Build output evidence', assignee: 'agent-1' },
    });
    await store.append('wf-ev-4', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-ev-4' } },
    });
    await store.append('wf-ev-4', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-ev-4' } },
    });

    const evidence = {
      type: 'build' as const,
      output: 'Build completed successfully in 12.5s',
      passed: true,
    };

    const result = await handleTaskComplete(
      { taskId: 't-ev-4', streamId: 'wf-ev-4', evidence },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = await store.query('wf-ev-4');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.evidence).toEqual(evidence);
    expect((data.evidence as Record<string, unknown>).type).toBe('build');
    expect(data.verified).toBe(true);
  });

  it('handleTaskComplete_WithProvenanceInResult_IncludesFieldsInEvent', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-prov-1', {
      type: 'task.assigned',
      data: { taskId: 't-prov-1', title: 'Provenance test', assignee: 'agent-1' },
    });
    await store.append('wf-prov-1', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-prov-1' } },
    });
    await store.append('wf-prov-1', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-prov-1' } },
    });

    const provenanceResult = {
      implements: ['DR-1', 'DR-3'],
      tests: [{ name: 'test1', file: 'src/foo.test.ts' }],
      files: ['src/foo.ts', 'src/foo.test.ts'],
    };

    const result = await handleTaskComplete(
      { taskId: 't-prov-1', streamId: 'wf-prov-1', result: provenanceResult },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = await store.query('wf-prov-1');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    expect(completedEvent).toBeDefined();
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.implements).toEqual(['DR-1', 'DR-3']);
    expect(data.tests).toEqual([{ name: 'test1', file: 'src/foo.test.ts' }]);
    expect(data.files).toEqual(['src/foo.ts', 'src/foo.test.ts']);
  });

  /**
   * A `task.completed` event with `worktree` or `worktreePath` starts the `merge-pending` detour,
   * and the `mergePendingEntry` guard reads the same fields. Thus the handler must forward them
   * from `args.result`.
   */
  it('handleTaskComplete_WithWorktreeInResult_ForwardsToEventData', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-wt-1', {
      type: 'task.assigned',
      data: { taskId: 't-wt-1', title: 'Worktree task', assignee: 'agent-1' },
    });
    await store.append('wf-wt-1', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-wt-1' } },
    });
    await store.append('wf-wt-1', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-wt-1' } },
    });

    const result = await handleTaskComplete(
      {
        taskId: 't-wt-1',
        streamId: 'wf-wt-1',
        result: {
          worktree: '.worktrees/t-wt-1',
          worktreePath: '/tmp/wt/t-wt-1',
        },
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = await store.query('wf-wt-1');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    expect(completedEvent).toBeDefined();
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.worktree).toBe('.worktrees/t-wt-1');
    expect(data.worktreePath).toBe('/tmp/wt/t-wt-1');
  });

  /**
   * An empty worktree string names no worktree. The handler omits it, so an empty CLI argument
   * cannot start the `merge-pending` detour.
   */
  it('handleTaskComplete_WithEmptyWorktreeStrings_OmitsFromEventData', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-wt-2', {
      type: 'task.assigned',
      data: { taskId: 't-wt-2', title: 'Empty wt task', assignee: 'agent-1' },
    });
    await store.append('wf-wt-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-wt-2' } },
    });
    await store.append('wf-wt-2', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-wt-2' } },
    });

    const result = await handleTaskComplete(
      {
        taskId: 't-wt-2',
        streamId: 'wf-wt-2',
        result: { worktree: '', worktreePath: '' },
      },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = await store.query('wf-wt-2');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data).not.toHaveProperty('worktree');
    expect(data).not.toHaveProperty('worktreePath');
  });

  it('handleTaskComplete_WithoutProvenance_OmitsFields', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-prov-2', {
      type: 'task.assigned',
      data: { taskId: 't-prov-2', title: 'No provenance test', assignee: 'agent-1' },
    });
    await store.append('wf-prov-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-prov-2' } },
    });
    await store.append('wf-prov-2', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 't-prov-2' } },
    });

    const result = await handleTaskComplete(
      { taskId: 't-prov-2', streamId: 'wf-prov-2', result: { artifacts: ['artifact1'] } },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
    const events = await store.query('wf-prov-2');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    expect(completedEvent).toBeDefined();
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.artifacts).toEqual(['artifact1']);
    expect(data).not.toHaveProperty('implements');
    expect(data).not.toHaveProperty('tests');
    expect(data).not.toHaveProperty('files');
  });

  it('TaskComplete_EvidenceSchema_ValidatesCorrectly', () => {
    const validData = {
      taskId: 't1',
      evidence: { type: 'test', output: 'PASS', passed: true },
      verified: true,
    };
    expect(TaskCompletedData.parse(validData)).toEqual(validData);

    const noEvidence = { taskId: 't2', verified: false };
    expect(TaskCompletedData.parse(noEvidence)).toEqual(noEvidence);

    for (const evidenceType of ['test', 'build', 'typecheck', 'manual']) {
      const data = {
        taskId: 't3',
        evidence: { type: evidenceType, output: 'output', passed: true },
        verified: true,
      };
      expect(() => TaskCompletedData.parse(data)).not.toThrow();
    }

    const invalidType = {
      taskId: 't4',
      evidence: { type: 'invalid', output: 'output', passed: true },
      verified: true,
    };
    expect(() => TaskCompletedData.parse(invalidType)).toThrow();

    const missingOutput = {
      taskId: 't5',
      evidence: { type: 'test', passed: true },
      verified: true,
    };
    expect(() => TaskCompletedData.parse(missingOutput)).toThrow();

    const missingPassed = {
      taskId: 't6',
      evidence: { type: 'test', output: 'PASS' },
      verified: true,
    };
    expect(() => TaskCompletedData.parse(missingPassed)).toThrow();
  });
});

/**
 * `static-analysis` is the only gate that `task_complete` enforces. A `tdd-compliance` event
 * does not count for or against the completion. The task-completion runbook runs the
 * per-task adequacy gate before this step.
 */
describe('handleTaskComplete gate enforcement', () => {
  /** The stream holds no gate event, so the absent `static-analysis` gate rejects the call. */
  it('HandleTaskComplete_NoTddGate_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-1', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'Gate test', assignee: 'agent-1' },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-1', result: { summary: 'done' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  it('HandleTaskComplete_BothGatesPassing_AllowsCompletion', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-2', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'Gate test', assignee: 'agent-1' },
    });
    await store.append('wf-gate-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 'T-01' } },
    });
    await store.append('wf-gate-2', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 'T-01' } },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-2' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
  });

  it('HandleTaskComplete_NoStaticAnalysis_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-d2-1', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'D2 gate test', assignee: 'agent-1' },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-d2-1', result: { summary: 'done' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.message).toContain('static');
  });

  it('HandleTaskComplete_BothGatesPassed_AllowsCompletion', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-d2-2', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'D2 gate test', assignee: 'agent-1' },
    });
    await store.append('wf-gate-d2-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 'T-01' } },
    });
    await store.append('wf-gate-d2-2', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 'T-01' } },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-d2-2' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
  });

  it('HandleTaskComplete_FailingStaticAnalysis_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-d2-3', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'D2 gate test', assignee: 'agent-1' },
    });
    await store.append('wf-gate-d2-3', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 'T-01' } },
    });
    await store.append('wf-gate-d2-3', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: false, details: { taskId: 'T-01' } },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-d2-3' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /** A `static-analysis` event whose `details` holds no `taskId` is a project-wide gate. It counts for each task. */
  it('HandleTaskComplete_ProjectWideStaticAnalysis_AcceptsNoTaskId', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-pw-1', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'Project-wide gate test', assignee: 'agent-1' },
    });
    await store.append('wf-gate-pw-1', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 'T-01' } },
    });
    await store.append('wf-gate-pw-1', {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: {} },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-pw-1' },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);
  });

  /**
   * The schema permits a `gate.executed` event with no `data`. The handler must reject the call
   * with `GATE_NOT_PASSED` and must not throw.
   */
  it('HandleTaskComplete_GateEventWithUndefinedData_DoesNotCrash', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-undef', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'Undef data gate test', assignee: 'agent-1' },
    });
    await store.append('wf-gate-undef', {
      type: 'gate.executed',
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-undef', result: { summary: 'done' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * The only gate event is `tdd-compliance` with no `details` field. The stream holds no
   * `static-analysis` event, so the handler rejects the call.
   */
  it('HandleTaskComplete_GateEventWithNoDetails_DoesNotCrash', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-nodetails', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'No details gate test', assignee: 'agent-1' },
    });
    await store.append('wf-gate-nodetails', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-nodetails', result: { summary: 'done' } },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  describe('#1189 — gate consultation tolerates alt shapes', () => {
    /**
     * A `gate.executed` event can hold `taskId` at the top level of `data`, or at
     * `data.details.taskId`. The handler accepts the two shapes.
     */
    it('HandleTaskComplete_GateWithTopLevelTaskId_RecognizedAsPassing', async () => {
      const store = new EventStore(tempDir);
      await store.append('wf-gate-tlid', {
        type: 'task.assigned',
        data: { taskId: 'T-01', title: 'Top-level taskId test', assignee: 'agent-1' },
      });
      await store.append('wf-gate-tlid', {
        type: 'gate.executed',
        data: { gateName: 'tdd-compliance', layer: 'delegate', passed: true, taskId: 'T-01' },
      });
      await store.append('wf-gate-tlid', {
        type: 'gate.executed',
        data: { gateName: 'static-analysis', layer: 'quality', passed: true, taskId: 'T-01' },
      });

      const result = await handleTaskComplete(
        { taskId: 'T-01', streamId: 'wf-gate-tlid' },
        tempDir,
        store,
      );

      expect(result.success).toBe(true);
    });

    /**
     * A top-level `taskId` must equal the id of the completed task. The fixture holds only a
     * `tdd-compliance` event, and that event names another task.
     */
    it('HandleTaskComplete_GateWithTopLevelTaskIdMismatch_RejectsCompletion', async () => {
      const store = new EventStore(tempDir);
      await store.append('wf-gate-tlid-mm', {
        type: 'task.assigned',
        data: { taskId: 'T-01', title: 'Mismatch test', assignee: 'agent-1' },
      });
      await store.append('wf-gate-tlid-mm', {
        type: 'gate.executed',
        data: { gateName: 'tdd-compliance', layer: 'delegate', passed: true, taskId: 'T-99' },
      });

      const result = await handleTaskComplete(
        { taskId: 'T-01', streamId: 'wf-gate-tlid-mm' },
        tempDir,
        store,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_NOT_PASSED');
    });

    /** The registry declares `static-analysis` as blocking, so caller evidence does not satisfy it. */
    it('HandleTaskComplete_NonManualEvidenceWithPassedTrue_DoesNotSatisfyBlockingGate', async () => {
      const store = new EventStore(tempDir);
      await store.append('wf-evbypass', {
        type: 'task.assigned',
        data: { taskId: 'T-01', title: 'Evidence bypass', assignee: 'agent-1' },
      });

      const result = await handleTaskComplete(
        {
          taskId: 'T-01',
          streamId: 'wf-evbypass',
          evidence: { type: 'test', output: '5727 tests passed', passed: true },
        },
        tempDir,
        store,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_NOT_PASSED');
      expect(result.error?.unmetGates).toContain('static-analysis');
    });

    /** Evidence is substantive only when `passed` is `true` and the output is not empty. */
    it('HandleTaskComplete_EvidenceWithEmptyOutput_DoesNotBypass', async () => {
      const store = new EventStore(tempDir);
      await store.append('wf-evempty', {
        type: 'task.assigned',
        data: { taskId: 'T-01', title: 'Empty evidence', assignee: 'agent-1' },
      });

      const result = await handleTaskComplete(
        {
          taskId: 'T-01',
          streamId: 'wf-evempty',
          evidence: { type: 'test', output: '', passed: true },
        },
        tempDir,
        store,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_NOT_PASSED');
    });

    /** The handler trims the output before the length check, so whitespace is not evidence. */
    it('HandleTaskComplete_EvidenceWithWhitespaceOnlyOutput_DoesNotBypass', async () => {
      const store = new EventStore(tempDir);
      await store.append('wf-evws', {
        type: 'task.assigned',
        data: { taskId: 'T-01', title: 'Whitespace evidence', assignee: 'agent-1' },
      });

      const result = await handleTaskComplete(
        {
          taskId: 'T-01',
          streamId: 'wf-evws',
          evidence: { type: 'test', output: '   \t\n  ', passed: true },
        },
        tempDir,
        store,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_NOT_PASSED');
    });

    /** The `manual` type is a provenance tag on the recorded evidence. It satisfies no blocking gate. */
    it('HandleTaskComplete_ManualEvidenceBypass_NoLongerSatisfiesBlockingGate', async () => {
      const store = new EventStore(tempDir);
      await store.append('wf-manual', {
        type: 'task.assigned',
        data: { taskId: 'T-01', title: 'Manual evidence', assignee: 'agent-1' },
      });

      const result = await handleTaskComplete(
        {
          taskId: 'T-01',
          streamId: 'wf-manual',
          evidence: { type: 'manual', output: 'docs-only task — no gates run', passed: true },
        },
        tempDir,
        store,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_NOT_PASSED');
      expect(result.error?.unmetGates).toContain('static-analysis');
    });
  });
});

describe('handleTaskComplete batch gate failures', () => {
  /**
   * The stream holds no gate event. `unmetGates` holds only `static-analysis`, because
   * `tdd-compliance` is not a `task_complete` gate.
   */
  it('handleTaskComplete_WhenHardGateFails_ReturnsUnmetGates', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-batch-1', {
      type: 'task.assigned',
      data: { taskId: 'T-B1', title: 'Batch gate test', assignee: 'agent-1' },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-B1', streamId: 'wf-batch-1' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.unmetGates).toContain('static-analysis');
    expect(result.error?.unmetGates).not.toContain('tdd-compliance');
    expect(result.error?.unmetGates).toHaveLength(1);
    expect(result.error?.message).toContain('static-analysis');
  });

  /** A passing `tdd-compliance` event does not satisfy `static-analysis`. */
  it('handleTaskComplete_WhenSingleGateFails_ReturnsArrayOfOne', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-batch-2', {
      type: 'task.assigned',
      data: { taskId: 'T-B2', title: 'Single gate fail', assignee: 'agent-1' },
    });
    await store.append('wf-batch-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 'T-B2' } },
    });

    const result = await handleTaskComplete(
      { taskId: 'T-B2', streamId: 'wf-batch-2' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.unmetGates).toEqual(['static-analysis']);
  });
});

describe('handleTaskComplete workflow state sync', () => {
  it('handleTaskComplete_WhenGatesPass_UpdatesTaskStatusInWorkflowState', async () => {
    const featureId = 'wf-sync-1';
    await initStateFile(tempDir, featureId, 'feature', {
      tasks: [{ id: 'task-1', title: 'Test task', status: 'in_progress' }],
    });

    const store = new EventStore(tempDir);
    await store.append(featureId, {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 'task-1' } },
    });
    await store.append(featureId, {
      type: 'gate.executed',
      data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId: 'task-1' } },
    });

    const result = await handleTaskComplete(
      { taskId: 'task-1', streamId: featureId },
      tempDir,
      store,
    );

    expect(result.success).toBe(true);

    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    const tasks = state.tasks as Array<{ id: string; status: string }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('complete');
  });

  it('handleTaskComplete_WhenGatesPass_AllTasksCompleteGuardPasses', async () => {
    const featureId = 'wf-sync-2';
    await initStateFile(tempDir, featureId, 'feature', {
      tasks: [
        { id: 'task-1', title: 'First task', status: 'in_progress' },
        { id: 'task-2', title: 'Second task', status: 'in_progress' },
      ],
    });

    const store = new EventStore(tempDir);
    for (const taskId of ['task-1', 'task-2']) {
      await store.append(featureId, {
        type: 'gate.executed',
        data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId } },
      });
      await store.append(featureId, {
        type: 'gate.executed',
        data: { gateName: 'static-analysis', layer: 'quality', passed: true, details: { taskId } },
      });
    }

    const result1 = await handleTaskComplete(
      { taskId: 'task-1', streamId: featureId },
      tempDir,
      store,
    );
    const result2 = await handleTaskComplete(
      { taskId: 'task-2', streamId: featureId },
      tempDir,
      store,
    );

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    const guardResult = guards.allTasksComplete.evaluate(state as unknown as Record<string, unknown>);
    expect(guardResult).toBe(true);
  });

  /**
   * The `task.completed` event lands before the sync and stays. The state document is corrupt,
   * so the handler reports `STATE_SYNC_FAILED` with the event ack beside it. A retry repairs the
   * document, because the task-keyed idempotency key returns the stored event and the sync runs
   * again. The two gate events hold sequences 1 and 2, so the ack holds sequence 3.
   */
  it('handleTaskComplete_WhenTheDocumentCannotBeWritten_ReportsTheFailureBesideTheDurableFact', async () => {
    const featureId = 'wf-sync-3';
    await initStateFile(tempDir, featureId, 'feature', {
      tasks: [{ id: 'task-1', title: 'Test task', status: 'in_progress' }],
    });
    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const intact = await readFile(stateFile, 'utf-8');
    await writeFile(stateFile, '{ not a document', 'utf-8');

    const store = new EventStore(tempDir);
    for (const gateName of ['tdd-compliance', 'static-analysis']) {
      await store.append(featureId, {
        type: 'gate.executed',
        data: { gateName, layer: gateName === 'static-analysis' ? 'quality' : 'task', passed: true, details: { taskId: 'task-1' } },
      });
    }

    const ack = { streamId: featureId, sequence: 3, type: 'task.completed' };
    const failed = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);
    expect(failed.success).toBe(false);
    expect(failed.error?.code).toBe('STATE_SYNC_FAILED');
    expect(failed.data).toEqual(ack);
    expect(await store.query(featureId, { type: 'task.completed' })).toHaveLength(1);

    await writeFile(stateFile, intact, 'utf-8');
    const retried = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);
    expect(retried.success).toBe(true);
    expect(retried.data).toEqual(ack);
    expect(await store.query(featureId, { type: 'task.completed' })).toHaveLength(1);
    const state = await readStateFile(stateFile);
    expect((state.tasks as { status: string }[]).map((t) => t.status)).toEqual(['complete']);
  });

  /** A tracked workflow can have no state document, and then the handler has nothing to sync. */
  it('handleTaskComplete_WithNoStateDocument_CompletesTheTask', async () => {
    const featureId = 'wf-sync-4';
    const store = new EventStore(tempDir);
    for (const gateName of ['tdd-compliance', 'static-analysis']) {
      await store.append(featureId, {
        type: 'gate.executed',
        data: { gateName, layer: gateName === 'static-analysis' ? 'quality' : 'task', passed: true, details: { taskId: 'task-1' } },
      });
    }

    const result = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);
    expect(result.success, JSON.stringify(result)).toBe(true);
    await expect(stat(path.join(tempDir, `${featureId}.state.json`))).rejects.toThrow();
  });
});

/**
 * The stream id is the bare feature id, so each task verb accepts `featureId` in place of
 * `streamId`. The tests assert the stream that receives the append, not only `success`. A
 * resolver that accepts `featureId` and writes to another stream passes a success-only check.
 */
describe('streamId ⇄ featureId alias on the task verbs', () => {
  /**
   * The claim and the completion pass only `featureId`. The seeded `static-analysis` gate keeps
   * the completion from a `GATE_NOT_PASSED` failure, which proves nothing about the alias.
   */
  it('TaskVerbs_FeatureIdOnly_ResolveToTheSameStreamAsStreamId', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const claimed = await handleTaskClaim(
      { taskId: 't-alias', agentId: 'agent-1', featureId: 'alias-feature' },
      tempDir,
      store,
    );
    expect(claimed.success, JSON.stringify(claimed.error)).toBe(true);

    await store.append('alias-feature', {
      type: 'gate.executed',
      data: {
        gateName: 'static-analysis',
        layer: 'quality',
        passed: true,
        details: { taskId: 't-alias' },
      },
    });

    const completed = await handleTaskComplete(
      { taskId: 't-alias', featureId: 'alias-feature' },
      tempDir,
      store,
    );
    expect(completed.success, JSON.stringify(completed.error)).toBe(true);

    const types = (await store.query('alias-feature')).map((e) => e.type);
    expect(types).toContain('task.claimed');
    expect(types).toContain('task.completed');
  });

  /**
   * A caller that passes `streamId` gets the same result when `featureId` is also present. The
   * handler writes nothing to the `featureId` stream.
   */
  it('TaskVerbs_StreamIdWins_WhenBothSpellingsDisagree', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const result = await handleTaskFail(
      {
        taskId: 't-both',
        error: 'boom',
        streamId: 'explicit-stream',
        featureId: 'ignored-feature',
      },
      tempDir,
      store,
    );
    expect(result.success, JSON.stringify(result.error)).toBe(true);

    expect((await store.query('explicit-stream')).map((e) => e.type)).toContain('task.failed');
    expect(await store.query('ignored-feature')).toHaveLength(0);
  });

  /**
   * A call with neither spelling must still fail. The message must name the alias, because a
   * message that names only `streamId` sends the agent to the operator for the value.
   */
  it('TaskVerbs_NeitherSpelling_StillRejectsAndNamesBoth', async () => {
    const store = new EventStore(tempDir);
    await store.initialize();

    const result = await handleTaskComplete({ taskId: 't-none' }, tempDir, store);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('featureId');
  });
});

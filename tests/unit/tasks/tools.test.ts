import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore, SequenceConflictError } from '../../../src/events/store.js';
import { TaskCompletedData, type WorkflowEvent } from '../../../src/events/schemas.js';
import { handleTaskClaim, handleTaskComplete, handleTaskFail, resetModuleEventStore } from '../../../src/verbs/tasks/tools.js';
import { resetMaterializerCache } from '../../../src/projections/views/tools.js';
import { initStateFile, readStateFile } from '../../../src/workflow/state-store.js';
import { guards } from '../../../src/workflow/guards.js';
import { getPlaybook } from '../../../src/workflow/playbooks.js';
import { getReservedEventAppendRegistration } from '../../../src/registry/gate-metadata.js';
import { STATIC_ANALYSIS_STEP_PARAMS } from '../../../src/runbooks/definitions.js';
import { runStaticAnalysis, type StaticAnalysisResult } from '../../../src/verbs/pure/static-analysis.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { seedStaticAnalysisVerdict } from '../../helpers/static-analysis-verdict.js';

let tempDir: string;

/**
 * Runs a real seed on a scratch stream and returns the two rows that the runner wrote there.
 * A test copies the rows, changed or not, onto the stream under test.
 */
async function seededRunnerRows(
  store: EventStore,
  taskId: string,
  verdict: 'pass' | 'fail' = 'pass',
): Promise<{ readonly evidence: WorkflowEvent; readonly signal: WorkflowEvent }> {
  const scratch = `scratch-${taskId}-${randomUUID()}`;
  await seedStaticAnalysisVerdict(store, { streamId: scratch, taskId, stateDir: tempDir, verdict });
  const [evidence] = await store.query(scratch, { type: 'admission.evidence-recorded' });
  const [signal] = await store.query(scratch, { type: 'gate.executed' });
  expect(evidence).toBeDefined();
  expect(signal).toBeDefined();
  return { evidence: evidence!, signal: signal! };
}

/**
 * The runner idempotency key of a seeded signal row. A copy that keeps the key is a runner-shaped row on another
 * stream, so each copy fixture below varies one other fact of the row.
 */
function runnerKeyOf(signal: WorkflowEvent): { readonly idempotencyKey: string } {
  if (signal.idempotencyKey === undefined) throw new Error('the seeded signal row has no idempotency key');
  return { idempotencyKey: signal.idempotencyKey };
}

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

  /**
   * The task-detail view holds an entry for this task, although the stream holds no
   * `task.assigned` event. Thus the view check refuses the claim, and the raw-event scan of the
   * handler does not run.
   */
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

  /**
   * The task-detail view holds an entry for this task, although the stream holds no
   * `task.assigned` event. Thus the view check refuses the claim, and the raw-event scan of the
   * handler does not run.
   */
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
 * seeds the stream before it installs the spies, because the `append` spy rejects every append.
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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-idem-comp', taskId: 't-idem-1', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-ev-1', taskId: 't-ev-1', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-ev-2', taskId: 't-ev-2', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-ev-3', taskId: 't-ev-3', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-ev-4', taskId: 't-ev-4', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-prov-1', taskId: 't-prov-1', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-wt-1', taskId: 't-wt-1', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-wt-2', taskId: 't-wt-2', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-prov-2', taskId: 't-prov-2', stateDir: tempDir });

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
  /**
   * The stream holds no gate event. The handler rejects the call because `static-analysis` is
   * unmet, not because a `tdd-compliance` event is absent.
   */
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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-2', taskId: 'T-01', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-d2-2', taskId: 'T-01', stateDir: tempDir });

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
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-d2-3', taskId: 'T-01', stateDir: tempDir, verdict: 'fail' });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-d2-3' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * A passing runner row that names no task satisfies no task. The fixture is a real run with no
   * task, so its subject is not a task, and its evidence record. The handler once read such a row
   * as a project-wide gate, so one run completed every task. This test pins the reverse.
   */
  it('HandleTaskComplete_RunnerRowWithNoTaskId_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    await store.append('wf-gate-pw-1', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'Project-wide gate test', assignee: 'agent-1' },
    });
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-pw-1', stateDir: tempDir });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-pw-1' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(await store.query('wf-gate-pw-1', { type: 'task.completed' })).toHaveLength(0);
  });

  /** A passing runner row for another task does not complete this task. */
  it('HandleTaskComplete_RunnerRowOfAnotherTask_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-other', taskId: 'T-02', stateDir: tempDir });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-other' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * The latest runner row for the task decides. A failing run after a pass refuses the
   * completion, so an old pass does not hide a later failure.
   */
  it('HandleTaskComplete_LatestRunnerRowFailedAfterAPass_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-stale', taskId: 'T-01', stateDir: tempDir });
    await seedStaticAnalysisVerdict(store, {
      streamId: 'wf-gate-stale',
      taskId: 'T-01',
      stateDir: tempDir,
      verdict: 'fail',
    });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-stale' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /** A later pass after a failing run completes the task, because the latest runner row decides. */
  it('HandleTaskComplete_LatestRunnerRowPassedAfterAFailure_AllowsCompletion', async () => {
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, {
      streamId: 'wf-gate-rerun',
      taskId: 'T-01',
      stateDir: tempDir,
      verdict: 'fail',
    });
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-rerun', taskId: 'T-01', stateDir: tempDir });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-rerun' },
      tempDir,
      store,
    );

    expect(result.success, JSON.stringify(result.error)).toBe(true);
  });

  /**
   * A row with the runner source and the runner shape proves nothing without its evidence record.
   * The fixture copies a real runner row onto a stream that holds no evidence record.
   */
  it('HandleTaskComplete_RunnerRowWithNoEvidenceRecord_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const { signal } = await seededRunnerRows(store, 'T-01');
    await store.append('wf-gate-noev', { type: 'gate.executed', source: signal.source, data: signal.data }, runnerKeyOf(signal));

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-noev' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * Only the gate runner source counts. The fixture copies a real evidence record and a real
   * runner row, and it gives the row another source.
   */
  it('HandleTaskComplete_RunnerShapeWithOtherSource_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const { evidence, signal } = await seededRunnerRows(store, 'T-01');
    await store.append('wf-gate-src', {
      type: 'admission.evidence-recorded',
      source: evidence.source,
      data: evidence.data,
    });
    await store.append('wf-gate-src', { type: 'gate.executed', source: 'exarchos-mcp', data: signal.data }, runnerKeyOf(signal));

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-src' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * The cited evidence record must name this task. The fixture copies the rows of a run for
   * another task and moves only the runner row to this task.
   */
  it('HandleTaskComplete_EvidenceRecordOfAnotherTask_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const { evidence, signal } = await seededRunnerRows(store, 'T-02');
    const data = signal.data as { details: Record<string, unknown> };
    await store.append('wf-gate-evtask', {
      type: 'admission.evidence-recorded',
      source: evidence.source,
      data: evidence.data,
    });
    await store.append('wf-gate-evtask', {
      type: 'gate.executed',
      source: signal.source,
      data: { ...signal.data, details: { ...data.details, taskId: 'T-01' } },
    }, runnerKeyOf(signal));

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-evtask' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /** The cited evidence record must be of the static-analysis ladder requirement. */
  it('HandleTaskComplete_EvidenceRecordOfAnotherRequirement_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const { evidence, signal } = await seededRunnerRows(store, 'T-01');
    const record = evidence.data as { evidence: Record<string, unknown> };
    await store.append('wf-gate-evreq', {
      type: 'admission.evidence-recorded',
      source: evidence.source,
      data: { ...record, evidence: { ...record.evidence, requirementId: 'verification-ladder:test-adequacy' } },
    });
    await store.append('wf-gate-evreq', { type: 'gate.executed', source: signal.source, data: signal.data }, runnerKeyOf(signal));

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-evreq' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /** A passing runner row that cites a failing evidence record does not complete the task. */
  it('HandleTaskComplete_PassingRowCitingAFailedRecord_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const { evidence, signal } = await seededRunnerRows(store, 'T-01', 'fail');
    await store.append('wf-gate-evfail', {
      type: 'admission.evidence-recorded',
      source: evidence.source,
      data: evidence.data,
    });
    await store.append('wf-gate-evfail', {
      type: 'gate.executed',
      source: signal.source,
      data: { ...signal.data, passed: true },
    }, runnerKeyOf(signal));

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-evfail' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * The control of the copy fixtures: the copied evidence record and runner row, unchanged and with the runner key,
   * complete the task. Thus each copy fixture above refuses for the one fact that it changes.
   */
  it('HandleTaskComplete_CopiedRunnerRowsWithTheRunnerKey_AllowCompletion', async () => {
    const store = new EventStore(tempDir);
    const { evidence, signal } = await seededRunnerRows(store, 'T-01');
    await store.append('wf-gate-copy', {
      type: 'admission.evidence-recorded',
      source: evidence.source,
      data: evidence.data,
    });
    await store.append('wf-gate-copy', { type: 'gate.executed', source: signal.source, data: signal.data }, runnerKeyOf(signal));

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-copy' },
      tempDir,
      store,
    );

    expect(result.success, JSON.stringify(result.error)).toBe(true);
  });

  /**
   * A runner row counts only under the runner key of the evidence id that it cites. The fixture is the control
   * above with no key on the copied row, as a writer outside the gate runner appends it.
   */
  it('HandleTaskComplete_RunnerRowCopiedWithoutItsKey_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const { evidence, signal } = await seededRunnerRows(store, 'T-01');
    await store.append('wf-gate-nokey', {
      type: 'admission.evidence-recorded',
      source: evidence.source,
      data: evidence.data,
    });
    await store.append('wf-gate-nokey', { type: 'gate.executed', source: signal.source, data: signal.data });

    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-nokey' },
      tempDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * An older writer re-asserts an earlier pass after a later failure, by a copy of the passing runner row with no key.
   * The copy is the latest runner-sourced row, and it does not complete the task.
   */
  it('HandleTaskComplete_KeylessCopyOfAnEarlierPassAfterAFailure_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-replay', taskId: 'T-01', stateDir: tempDir });
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-replay', taskId: 'T-01', stateDir: tempDir, verdict: 'fail' });
    const [passing] = await store.query('wf-gate-replay', { type: 'gate.executed' });
    expect(passing?.data?.passed).toBe(true);
    await store.append('wf-gate-replay', { type: 'gate.executed', source: passing!.source, data: passing!.data });

    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-gate-replay' }, tempDir, store);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * A copy of the earlier passing row that keeps the runner key collapses onto the stored row, so it is not a later
   * signal. The store returns the stored row, the stream keeps two signal rows, and the later failure still refuses.
   */
  it('HandleTaskComplete_KeyedCopyOfAnEarlierPass_CollapsesOntoTheStoredRow', async () => {
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-keyed', taskId: 'T-01', stateDir: tempDir });
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-gate-keyed', taskId: 'T-01', stateDir: tempDir, verdict: 'fail' });
    const [passing] = await store.query('wf-gate-keyed', { type: 'gate.executed' });
    expect(passing?.data?.passed).toBe(true);

    const copied = await store.append(
      'wf-gate-keyed',
      { type: 'gate.executed', source: passing!.source, data: passing!.data },
      runnerKeyOf(passing!),
    );

    expect(copied.sequence).toBe(passing!.sequence);
    expect(await store.query('wf-gate-keyed', { type: 'gate.executed' })).toHaveLength(2);
    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-gate-keyed' }, tempDir, store);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
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
   * static-analysis runner row, so the handler rejects the call. The handler matches the runner
   * source first, so it does not read the absent `details`.
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

  describe('gate consultation reads only the runner shape', () => {
    /**
     * The handler does not read a top-level `data.taskId`, because the gate runner writes the task
     * only at `details.taskId`. An earlier fix accepted the top-level shape, and this test pins the
     * reverse. The fixture is a real runner row and its evidence record, with the task moved to
     * the top level.
     */
    it('HandleTaskComplete_GateWithTopLevelTaskId_RejectsCompletion', async () => {
      const store = new EventStore(tempDir);
      const { evidence, signal } = await seededRunnerRows(store, 'T-01');
      const { taskId: _taskId, ...details } = (signal.data as { details: Record<string, unknown> }).details;
      await store.append('wf-gate-tlid', {
        type: 'admission.evidence-recorded',
        source: evidence.source,
        data: evidence.data,
      });
      await store.append('wf-gate-tlid', {
        type: 'gate.executed',
        source: signal.source,
        data: { ...signal.data, taskId: 'T-01', details },
      }, runnerKeyOf(signal));

      const result = await handleTaskComplete(
        { taskId: 'T-01', streamId: 'wf-gate-tlid' },
        tempDir,
        store,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('GATE_NOT_PASSED');
    });

    /**
     * The fixture holds only a `tdd-compliance` event that names another task at the top level.
     * With no `static-analysis` runner row, the handler rejects the call for any task id, so the
     * test does not isolate a rule.
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

    /**
     * Evidence is substantive only when `passed` is `true` and the output is not empty. No caller
     * evidence satisfies the blocking `static-analysis` gate, so the test does not isolate that rule.
     */
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

    /**
     * The handler trims the output before the length check, so whitespace is not evidence. No
     * caller evidence satisfies the blocking `static-analysis` gate, so the test does not isolate
     * the trim.
     */
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

/** A step param value that is a template variable, for example `<worktreePath>`. */
const STEP_TEMPLATE_VARIABLE = /^<[A-Za-z]+>$/;

/**
 * The params of the static-analysis step that a recovery text does not name.
 * A rerun names each param with its value, and the task id fills its variable.
 * A guidance text names each variable by its param name, and each literal param with its value.
 */
function unnamedStepParams(text: string, form: { readonly rerunFor: string } | 'guidance'): readonly string[] {
  return Object.entries(STATIC_ANALYSIS_STEP_PARAMS)
    .map(([name, value]) => {
      if (form !== 'guidance') return `${name} '${value.replaceAll('<taskId>', form.rerunFor)}'`;
      return STEP_TEMPLATE_VARIABLE.test(value) ? name : `${name} '${value}'`;
    })
    .filter((named) => !text.includes(named));
}

/** A run outcome of the real `runStaticAnalysis` on a scratch project. Each command that it runs exits 0. */
async function realRunOutcome(files: Readonly<Record<string, string>>): Promise<StaticAnalysisResult> {
  const repoRoot = path.join(tempDir, `project-${randomUUID()}`);
  await mkdir(repoRoot, { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(path.join(repoRoot, name), content);
  return runStaticAnalysis({ repoRoot, runCommand: () => ({ exitCode: 0, stdout: '', stderr: '' }) });
}

/**
 * The refusal names its cause and the recovery of that cause. Each fixture is a run of the gate runner, so the row is
 * the row of production. The rerun of each recovery comes from the params of the static-analysis step of the runbooks.
 */
describe('handleTaskComplete names the cause and the recovery of a refusal', () => {
  /** With no runner row for the task, the refusal says so and names the rerun of the runbook step for this task. */
  it('HandleTaskComplete_NoRunnerVerdict_NamesTheRerunOfTheStep', async () => {
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-cause-none', taskId: 'T-02', stateDir: tempDir });

    const result = await handleTaskComplete({ taskId: 'T-07', streamId: 'wf-cause-none' }, tempDir, store);

    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.unmetGates).toEqual(['static-analysis']);
    const message = result.error?.message ?? '';
    expect(message).toContain("The gate runner recorded no static-analysis verdict for task 'T-07'.");
    expect(unnamedStepParams(message, { rerunFor: 'T-07' })).toEqual([]);
    expect(message).toContain('then call task_complete again');
    expect(message).toContain('settle the claim under a new batch id');
  });

  /** A failing latest run names the fail, the report and the rerun. */
  it('HandleTaskComplete_LatestRunFailed_NamesTheFailAndTheRerun', async () => {
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-cause-fail', taskId: 'T-01', stateDir: tempDir, verdict: 'fail' });

    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-cause-fail' }, tempDir, store);

    const message = result.error?.message ?? '';
    expect(message).toContain("The latest static-analysis verdict for task 'T-01' is a fail.");
    expect(message).toContain('Fix the failing checks that the check_static_analysis report names.');
    expect(unnamedStepParams(message, { rerunFor: 'T-01' })).toEqual([]);
  });

  /**
   * A run with a missing script is a skip. The runner row names the skipped check, and the refusal names it and the
   * fix. The fixture is a real run on a project with no `quality-check` script.
   */
  it('HandleTaskComplete_LatestRunSkippedACheck_NamesTheCheckAndTheMissingScript', async () => {
    const store = new EventStore(tempDir);
    const outcome = await realRunOutcome({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }),
    });
    expect(outcome).toMatchObject({ status: 'skip', skipReason: 'constituent-skipped' });
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-cause-skip', taskId: 'T-01', stateDir: tempDir, outcome });
    const [signal] = await store.query('wf-cause-skip', { type: 'gate.executed' });
    expect(signal?.data?.details).toMatchObject({
      skipped: true,
      discriminant: 'constituent-skipped',
      reason: "Quality check did not run (no 'quality-check' script in package.json)",
    });

    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-cause-skip' }, tempDir, store);

    const message = result.error?.message ?? '';
    expect(message).toContain(
      "The latest static-analysis run for task 'T-01' skipped a check, so it is not a pass: " +
        "Quality check did not run (no 'quality-check' script in package.json).",
    );
    expect(message).toContain('Add the missing scripts, or do not set the skip flags.');
    expect(unnamedStepParams(message, { rerunFor: 'T-01' })).toEqual([]);
  });

  /**
   * A run with no supported toolchain is a skip that no rerun fixes. The refusal says so and names the later change
   * that lets static analysis run configured commands. The fixture is a real run on an empty project.
   */
  it('HandleTaskComplete_LatestRunHadNoToolchain_SaysThatNoRerunHelps', async () => {
    const store = new EventStore(tempDir);
    const outcome = await realRunOutcome({ 'README.md': '# no toolchain' });
    expect(outcome).toMatchObject({ status: 'skip', skipReason: 'no-toolchain' });
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-cause-tool', taskId: 'T-01', stateDir: tempDir, outcome });

    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-cause-tool' }, tempDir, store);

    const message = result.error?.message ?? '';
    expect(message).toContain('the repository has no supported static-analysis toolchain');
    expect(message).toContain('A task cannot complete in this repository until static analysis can run configured commands (#1540).');
    expect(message).not.toContain('check_static_analysis with');
    expect(message).not.toContain('Add the missing scripts');
  });

  /** Each cause gets its own text, so no two causes share a refusal. */
  it('HandleTaskComplete_EachCause_GetsItsOwnText', async () => {
    const store = new EventStore(tempDir);
    const skipped = await realRunOutcome({ 'package.json': JSON.stringify({ scripts: { lint: 'x', typecheck: 'y' } }) });
    const noToolchain = await realRunOutcome({});
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-each', taskId: 'fail', stateDir: tempDir, verdict: 'fail' });
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-each', taskId: 'skip', stateDir: tempDir, outcome: skipped });
    await seedStaticAnalysisVerdict(store, { streamId: 'wf-each', taskId: 'tool', stateDir: tempDir, outcome: noToolchain });

    const messages = await Promise.all(
      ['none', 'fail', 'skip', 'tool'].map(async (taskId) => {
        const result = await handleTaskComplete({ taskId, streamId: 'wf-each' }, tempDir, store);
        return (result.error?.message ?? '').replaceAll(`'${taskId}'`, "'<task>'");
      }),
    );

    expect(new Set(messages).size).toBe(4);
  });

  /**
   * Every recovery text that names the static-analysis call names the params of the runbook step. The texts are the
   * refusal, the guidance of a refused `gate.executed` append, and the two delegation playbooks.
   */
  it('RecoveryTexts_NameTheParamsOfTheStaticAnalysisStep', async () => {
    const store = new EventStore(tempDir);
    const refusal = await handleTaskComplete({ taskId: 'T-07', streamId: 'wf-gate-msg' }, tempDir, store);
    const guidance = getReservedEventAppendRegistration('gate.executed')?.guidance ?? '';
    const playbooks = [getPlaybook('feature', 'delegate'), getPlaybook('refactor', 'overhaul-delegate')].map(
      (playbook) => playbook?.compactGuidance ?? '',
    );

    expect(Object.keys(STATIC_ANALYSIS_STEP_PARAMS)).toEqual(['repoRoot', 'worktreePath', 'taskId']);
    expect(unnamedStepParams(refusal.error?.message ?? '', { rerunFor: 'T-07' })).toEqual([]);
    expect(guidance).toContain('check_static_analysis');
    expect(unnamedStepParams(guidance, 'guidance')).toEqual([]);
    for (const text of playbooks) {
      expect(text).toContain('check_static_analysis');
      expect(unnamedStepParams(text, 'guidance')).toEqual([]);
    }
  });
});

/** A view of the store whose `gate.executed` append throws, as a store fault between the two appends of the runner. */
function signalLosingStore(store: EventStore): Pick<EventStore, 'append' | 'query'> {
  return {
    query: (streamId, filters) => store.query(streamId, filters),
    append: async (streamId, event, options) => {
      if (event.type === 'gate.executed') throw new Error('the signal append failed');
      return store.append(streamId, event, options);
    },
  };
}

/** The evidence records of the stream in append order: the id, the verdict and the record that each supersedes. */
async function recordsOf(
  store: EventStore,
  streamId: string,
): Promise<ReadonlyArray<{ readonly evidenceId: string; readonly verdict: string; readonly supersedes?: string }>> {
  const rows = await store.query(streamId, { type: 'admission.evidence-recorded' });
  return rows.map((row) => {
    const data = row.data as { evidence: { evidenceId: string; verdict: string }; supersedesEvidenceId?: string };
    return {
      evidenceId: data.evidence.evidenceId,
      verdict: data.evidence.verdict,
      ...(data.supersedesEvidenceId === undefined ? {} : { supersedes: data.supersedesEvidenceId }),
    };
  });
}

/** The evidence ids that the `gate.executed` rows of the stream cite, in sequence order. */
async function signalsOf(store: EventStore, streamId: string): Promise<readonly unknown[]> {
  const rows = await store.query(streamId, { type: 'gate.executed' });
  return rows.map((row) => (row.data as { details?: { evidenceId?: unknown } }).details?.evidenceId);
}

/** A promise and the function that resolves it. */
function latch(): { readonly reached: Promise<void>; readonly release: () => void } {
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

/**
 * The completion reads the active evidence record of the task, not only the latest signal row. The scope is the task
 * and the static-analysis requirement. A superseded record is not active. The latest runner signal must cite an
 * active passing record, and any other active record of the task that does not pass refuses. Each fixture is a
 * production-shaped run of the gate runner, and each signal row carries the runner key.
 */
describe('handleTaskComplete reads the active record of the task', () => {
  /**
   * A later failing run persists its record, and its signal append fails. The earlier passing signal is still the
   * latest row, and it cites a superseded record.
   */
  it('HandleTaskComplete_LaterFailingRunWithALostSignal_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const passId = await seedStaticAnalysisVerdict(store, { streamId: 'wf-lost', taskId: 'T-01', stateDir: tempDir });
    await expect(
      seedStaticAnalysisVerdict(signalLosingStore(store), {
        streamId: 'wf-lost',
        taskId: 'T-01',
        stateDir: tempDir,
        verdict: 'fail',
      }),
    ).rejects.toThrow(/EVIDENCE_APPEND_FAILED/);

    const records = await recordsOf(store, 'wf-lost');
    expect(records.map((record) => [record.verdict, record.supersedes])).toEqual([
      ['pass', undefined],
      ['fail', passId],
    ]);
    expect(await signalsOf(store, 'wf-lost')).toEqual([passId]);
    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-lost' }, tempDir, store);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.message).toContain("The latest static-analysis verdict for task 'T-01' is a fail.");
  });

  /**
   * A retry of an older operation re-derives the lost signal of its passing record above the signal of a later
   * failing run. The re-derived row carries the runner key, and it cites a superseded record.
   */
  it('HandleTaskComplete_RetryOfAnOlderOperationAfterALaterFailure_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const olderOperation = randomUUID();
    const seed = { streamId: 'wf-retry-op', taskId: 'T-01', stateDir: tempDir } as const;
    await expect(
      seedStaticAnalysisVerdict(signalLosingStore(store), { ...seed, operationId: olderOperation }),
    ).rejects.toThrow(/EVIDENCE_APPEND_FAILED/);
    const [older] = await recordsOf(store, 'wf-retry-op');
    const failId = await seedStaticAnalysisVerdict(store, { ...seed, verdict: 'fail', operationId: randomUUID() });

    const retried = await seedStaticAnalysisVerdict(store, { ...seed, verdict: 'fail', operationId: olderOperation });

    expect(retried).toBe(older?.evidenceId);
    expect((await recordsOf(store, 'wf-retry-op')).map((record) => record.supersedes)).toEqual([undefined, older?.evidenceId]);
    expect(await signalsOf(store, 'wf-retry-op')).toEqual([failId, older?.evidenceId]);
    const signals = await store.query('wf-retry-op', { type: 'gate.executed' });
    expect(signals.at(-1)?.data?.passed).toBe(true);
    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-retry-op' }, tempDir, store);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * Two writers run the gate for one task. The failing run reads the passing record and supersedes it, and the
   * passing signal lands after the failing signal.
   */
  it('HandleTaskComplete_TwoWritersWhosePassSignalLandsLast_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const passRecorded = latch();
    const failSignalled = latch();
    const holdingPass: Pick<EventStore, 'append' | 'query'> = {
      query: (streamId, filters) => store.query(streamId, filters),
      append: async (streamId, event, options) => {
        if (event.type === 'gate.executed') {
          passRecorded.release();
          await failSignalled.reached;
        }
        return store.append(streamId, event, options);
      },
    };
    const releasingFail: Pick<EventStore, 'append' | 'query'> = {
      query: (streamId, filters) => store.query(streamId, filters),
      append: async (streamId, event, options) => {
        const row = await store.append(streamId, event, options);
        if (event.type === 'gate.executed') failSignalled.release();
        return row;
      },
    };
    const seed = { streamId: 'wf-writers', taskId: 'T-01', stateDir: tempDir } as const;

    const pass = seedStaticAnalysisVerdict(holdingPass, seed);
    await passRecorded.reached;
    const fail = seedStaticAnalysisVerdict(releasingFail, { ...seed, verdict: 'fail' });
    const [passId, failId] = await Promise.all([pass, fail]);

    expect((await recordsOf(store, 'wf-writers')).map((record) => record.supersedes)).toEqual([undefined, passId]);
    expect(await signalsOf(store, 'wf-writers')).toEqual([failId, passId]);
    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-writers' }, tempDir, store);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  /**
   * Two writers run the gate for one task, and neither reads the record of the other. Both records are active, the
   * passing signal is the latest row, and the active failing record refuses.
   */
  it('HandleTaskComplete_TwoActiveRecordsThatDisagree_RejectsCompletion', async () => {
    const store = new EventStore(tempDir);
    const passQueried = latch();
    const failQueried = latch();
    const failSignalled = latch();
    const holdingPass: Pick<EventStore, 'append' | 'query'> = {
      query: async (streamId, filters) => {
        const rows = await store.query(streamId, filters);
        if (filters?.type === 'admission.evidence-recorded') passQueried.release();
        return rows;
      },
      append: async (streamId, event, options) => {
        if (event.type === 'admission.evidence-recorded') await failQueried.reached;
        if (event.type === 'gate.executed') await failSignalled.reached;
        return store.append(streamId, event, options);
      },
    };
    const releasingFail: Pick<EventStore, 'append' | 'query'> = {
      query: async (streamId, filters) => {
        const rows = await store.query(streamId, filters);
        if (filters?.type === 'admission.evidence-recorded') failQueried.release();
        return rows;
      },
      append: async (streamId, event, options) => {
        if (event.type === 'admission.evidence-recorded') await passQueried.reached;
        const row = await store.append(streamId, event, options);
        if (event.type === 'gate.executed') failSignalled.release();
        return row;
      },
    };
    const seed = { streamId: 'wf-fork', taskId: 'T-01', stateDir: tempDir } as const;

    const [passId, failId] = await Promise.all([
      seedStaticAnalysisVerdict(holdingPass, seed),
      seedStaticAnalysisVerdict(releasingFail, { ...seed, verdict: 'fail' }),
    ]);

    expect((await recordsOf(store, 'wf-fork')).map((record) => record.supersedes)).toEqual([undefined, undefined]);
    expect(await signalsOf(store, 'wf-fork')).toEqual([failId, passId]);
    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-fork' }, tempDir, store);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.message).toContain("The latest static-analysis verdict for task 'T-01' is a fail.");
  });

  /**
   * The scope is the task, across bases. A failing run on another base is a second chain, so it refuses until a run
   * on that base passes and supersedes it.
   */
  it('HandleTaskComplete_FailingRecordOnAnotherBase_RefusesUntilThatBasePasses', async () => {
    const store = new EventStore(tempDir);
    const seed = { streamId: 'wf-bases', taskId: 'T-01', stateDir: tempDir } as const;
    await seedStaticAnalysisVerdict(store, { ...seed, verdict: 'fail', baseBranch: 'develop' });
    await seedStaticAnalysisVerdict(store, seed);

    const refused = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-bases' }, tempDir, store);
    expect(refused.error?.code).toBe('GATE_NOT_PASSED');

    await seedStaticAnalysisVerdict(store, { ...seed, baseBranch: 'develop' });
    const admitted = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-bases' }, tempDir, store);
    expect(admitted.success, JSON.stringify(admitted.error)).toBe(true);
  });

  /**
   * A skipped run on another base refuses under a later pass on the main base. The refusal takes its cause from the
   * runner row of the skipped record, so it names the skipped check.
   */
  it('HandleTaskComplete_SkippedRecordOnAnotherBase_NamesTheSkippedCheck', async () => {
    const store = new EventStore(tempDir);
    const seed = { streamId: 'wf-skip-base', taskId: 'T-01', stateDir: tempDir } as const;
    await seedStaticAnalysisVerdict(store, {
      ...seed,
      baseBranch: 'develop',
      outcome: {
        status: 'skip',
        skipReason: 'constituent-skipped',
        skippedChecks: [{ name: 'Lint', detail: '--skip-lint' }],
      },
    });
    await seedStaticAnalysisVerdict(store, seed);

    const result = await handleTaskComplete({ taskId: 'T-01', streamId: 'wf-skip-base' }, tempDir, store);

    expect(result.error?.code).toBe('GATE_NOT_PASSED');
    expect(result.error?.message).toContain('so it is not a pass: Lint did not run (--skip-lint).');
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
    await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: 'task-1', stateDir: tempDir });

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
      await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: taskId, stateDir: tempDir });
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
   * and the transition guards read that document. Thus the handler reports `STATE_SYNC_FAILED`
   * with the event ack beside it. The refusal names `reconcile`, then the retry, then a stop rule.
   * After the test restores the document, a retry syncs it: the task-keyed idempotency key returns
   * the stored event, and the sync runs again. The two gate events hold sequences 1 and 2, so the
   * ack holds sequence 3.
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
    await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: 'task-1', stateDir: tempDir });

    const seeded = await store.query(featureId);
    const ack = { streamId: featureId, sequence: seeded.length + 1, type: 'task.completed' };
    const failed = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);
    expect(failed.success).toBe(false);
    expect(failed.error?.code).toBe('STATE_SYNC_FAILED');
    expect(failed.error?.message).toContain('Run `exarchos_workflow reconcile`, then retry task_complete');
    expect(failed.error?.message).toContain('stop and report it to a person');
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

  /**
   * A failing run after a completion whose sync failed does not refuse the retry. The document still lists the task
   * in progress, so the handler syncs it before the gate check and returns the stored row. It writes no second row.
   */
  it('handleTaskComplete_RetryAfterAFailedSyncAndALaterFailingRun_ReturnsTheStoredCompletion', async () => {
    const featureId = 'wf-sync-5';
    await initStateFile(tempDir, featureId, 'feature', {
      tasks: [{ id: 'task-1', title: 'Test task', status: 'in_progress' }],
    });
    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const intact = await readFile(stateFile, 'utf-8');
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: 'task-1', stateDir: tempDir });
    await writeFile(stateFile, '{ not a document', 'utf-8');

    const failed = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);
    expect(failed.error?.code).toBe('STATE_SYNC_FAILED');
    await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: 'task-1', stateDir: tempDir, verdict: 'fail' });
    await writeFile(stateFile, intact, 'utf-8');

    const retried = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);

    expect(retried.success, JSON.stringify(retried.error)).toBe(true);
    const [stored] = await store.query(featureId, { type: 'task.completed' });
    expect(failed.data).toEqual({ streamId: featureId, sequence: stored?.sequence, type: 'task.completed' });
    expect(retried.data).toEqual({ streamId: featureId, sequence: stored?.sequence, type: 'task.completed' });
    expect(await store.query(featureId, { type: 'task.completed' })).toHaveLength(1);
    const state = await readStateFile(stateFile);
    expect((state.tasks as { status: string }[]).map((t) => t.status)).toEqual(['complete']);
  });

  /**
   * A fix of a completed task calls `task_complete` again, as the task-fix runbook does. The document lists the task
   * complete, so the stored row does not skip the gate. A later failing run refuses. A later pass returns the stored row.
   */
  it('handleTaskComplete_CompletedTaskAndALaterFailingRun_RefusesTheFixUntilARunPasses', async () => {
    const featureId = 'wf-sync-6';
    await initStateFile(tempDir, featureId, 'feature', {
      tasks: [{ id: 'task-1', title: 'Test task', status: 'in_progress' }],
    });
    const stateFile = path.join(tempDir, `${featureId}.state.json`);
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: 'task-1', stateDir: tempDir });
    const completed = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);
    expect(completed.success, JSON.stringify(completed.error)).toBe(true);

    await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: 'task-1', stateDir: tempDir, verdict: 'fail' });
    const refused = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);

    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('GATE_NOT_PASSED');

    await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: 'task-1', stateDir: tempDir });
    const fixed = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);

    expect(fixed.success, JSON.stringify(fixed.error)).toBe(true);
    const [stored] = await store.query(featureId, { type: 'task.completed' });
    expect(completed.data).toEqual({ streamId: featureId, sequence: stored?.sequence, type: 'task.completed' });
    expect(fixed.data).toEqual({ streamId: featureId, sequence: stored?.sequence, type: 'task.completed' });
    expect(await store.query(featureId, { type: 'task.completed' })).toHaveLength(1);
    const state = await readStateFile(stateFile);
    expect((state.tasks as { status: string }[]).map((t) => t.status)).toEqual(['complete']);
  });

  /** A tracked workflow can have no state document, and then the handler has nothing to sync. */
  it('handleTaskComplete_WithNoStateDocument_CompletesTheTask', async () => {
    const featureId = 'wf-sync-4';
    const store = new EventStore(tempDir);
    await seedStaticAnalysisVerdict(store, { streamId: featureId, taskId: 'task-1', stateDir: tempDir });

    const result = await handleTaskComplete({ taskId: 'task-1', streamId: featureId }, tempDir, store);
    expect(result.success, JSON.stringify(result)).toBe(true);
    await expect(stat(path.join(tempDir, `${featureId}.state.json`))).rejects.toThrow();
  });
});

/**
 * The stream id is the bare feature id, so each task verb accepts `featureId` in place of
 * `streamId`. The first two tests assert the stream that receives the append, not only `success`.
 * A resolver that accepts `featureId` and writes to another stream passes a success-only check.
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

    await seedStaticAnalysisVerdict(store, { streamId: 'alias-feature', taskId: 't-alias', stateDir: tempDir });

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

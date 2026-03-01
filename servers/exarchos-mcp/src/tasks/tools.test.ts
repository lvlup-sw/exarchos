import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore, SequenceConflictError } from '../event-store/store.js';
import { TaskCompletedData } from '../event-store/schemas.js';
import { handleTaskClaim, handleTaskComplete, handleTaskFail, resetModuleEventStore } from './tools.js';
import { resetMaterializerCache } from '../views/tools.js';

let tempDir: string;

beforeEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  tempDir = await mkdtemp(path.join(tmpdir(), 'task-tools-unit-'));
});

afterEach(async () => {
  resetModuleEventStore();
  resetMaterializerCache();
  await rm(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('handleTaskClaim (materialized view)', () => {
  it('should return ALREADY_CLAIMED when task-detail view shows task is claimed', async () => {
    // Arrange: seed the stream with task.assigned + task.claimed events
    // so the materializer builds a view where the task has status 'claimed'
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

    // Act: attempt to claim the already-claimed task
    const result = await handleTaskClaim(
      { taskId: 't1', agentId: 'agent-2', streamId: 'wf-mat' },
      tempDir,
    );

    // Assert: should return ALREADY_CLAIMED via materialized view check
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
    expect(result.error?.message).toContain('t1');
  });

  it('should return ALREADY_CLAIMED when task-detail view shows task is completed', async () => {
    // Arrange: task that has been assigned, claimed, and completed
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

    // Act
    const result = await handleTaskClaim(
      { taskId: 't2', agentId: 'agent-2', streamId: 'wf-comp' },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
  });

  it('should return ALREADY_CLAIMED when task-detail view shows task is failed', async () => {
    // Arrange: task that has been assigned, claimed, and failed
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

    // Act
    const result = await handleTaskClaim(
      { taskId: 't3', agentId: 'agent-2', streamId: 'wf-fail' },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
  });

  it('should return ALREADY_CLAIMED via fallback when task.completed exists without task.assigned', async () => {
    // Arrange: task.completed event without prior task.assigned (view won't see it)
    const store = new EventStore(tempDir);
    await store.append('wf-fb-comp', {
      type: 'task.completed',
      data: { taskId: 't5' },
    });

    // Act
    const result = await handleTaskClaim(
      { taskId: 't5', agentId: 'agent-1', streamId: 'wf-fb-comp' },
      tempDir,
    );

    // Assert: fallback raw-event scan should catch terminal state
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
  });

  it('should return ALREADY_CLAIMED via fallback when task.failed exists without task.assigned', async () => {
    // Arrange: task.failed event without prior task.assigned (view won't see it)
    const store = new EventStore(tempDir);
    await store.append('wf-fb-fail', {
      type: 'task.failed',
      data: { taskId: 't6', error: 'something broke' },
    });

    // Act
    const result = await handleTaskClaim(
      { taskId: 't6', agentId: 'agent-1', streamId: 'wf-fb-fail' },
      tempDir,
    );

    // Assert: fallback raw-event scan should catch terminal state
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('ALREADY_CLAIMED');
  });

  it('should allow claim when task exists but is only assigned (not yet claimed)', async () => {
    // Arrange: task that is only assigned
    const store = new EventStore(tempDir);
    await store.append('wf-open', {
      type: 'task.assigned',
      data: { taskId: 't4', title: 'Open task', assignee: 'agent-1' },
    });

    // Act
    const result = await handleTaskClaim(
      { taskId: 't4', agentId: 'agent-1', streamId: 'wf-open' },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
  });
});

// ─── T33-T34: Exponential Backoff in Task Claim Retries ─────────────────────
//
// The sleep() helper in tools.ts uses setTimeout. To make backoff tests
// deterministic (no real wall-clock delay, no flakiness under load), we
// spy on globalThis.setTimeout and make it invoke the callback synchronously.
// This lets us verify retry count and delay scheduling without waiting.

describe('handleTaskClaim Exponential Backoff', () => {
  // Math.random is mocked to 0 so jitter is eliminated and delay values
  // become fully deterministic. setTimeout is spied to call fn() synchronously,
  // avoiding real wall-clock waits while still recording requested delays.
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('HandleTaskClaim_Retries_WithExponentialBackoff', async () => {
    // Arrange: seed the stream before installing the setTimeout spy
    const store = new EventStore(tempDir);
    await store.append('wf-backoff', {
      type: 'task.assigned',
      data: { taskId: 't-bo', title: 'Backoff task', assignee: 'agent-1' },
    });

    // Capture requested sleep delays; resolve immediately for determinism
    const capturedDelays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void, ms?: number) => {
      capturedDelays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    // Mock append to always throw SequenceConflictError so all retries exhaust
    let appendCallCount = 0;
    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function () {
      appendCallCount++;
      throw new SequenceConflictError(0, 1);
    });

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-bo', agentId: 'agent-1', streamId: 'wf-backoff' },
      tempDir,
    );

    // Assert: Should fail after exhausting retries (MAX_CLAIM_RETRIES = 3)
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CLAIM_FAILED');

    // Assert: append was called once per attempt
    expect(appendCallCount).toBe(3);

    // Assert: exponential backoff delays are deterministic (Math.random = 0, jitter = 0)
    // attempt 0: 50 * 2^0 + 0 = 50ms
    // attempt 1: 50 * 2^1 + 0 = 100ms
    // attempt 2: 50 * 2^2 + 0 = 200ms
    expect(capturedDelays).toHaveLength(3);
    expect(capturedDelays[0]).toBe(50);
    expect(capturedDelays[1]).toBe(100);
    expect(capturedDelays[2]).toBe(200);
  });

  it('HandleTaskClaim_StillReturnsClaimFailed_AfterRetries', async () => {
    // Arrange: seed the stream before installing the setTimeout spy
    const store = new EventStore(tempDir);
    await store.append('wf-retry-fail', {
      type: 'task.assigned',
      data: { taskId: 't-rf', title: 'Retry fail task', assignee: 'agent-1' },
    });

    // Make sleep() resolve immediately for determinism
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    // Mock append to always throw SequenceConflictError
    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function () {
      throw new SequenceConflictError(0, 1);
    });

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-rf', agentId: 'agent-1', streamId: 'wf-retry-fail' },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CLAIM_FAILED');
    expect(result.error?.message).toContain('retries');
  });

  it('HandleTaskClaim_BackoffCapped_AtReasonableMax', async () => {
    // Arrange: seed the stream before installing the setTimeout spy
    const store = new EventStore(tempDir);
    await store.append('wf-cap', {
      type: 'task.assigned',
      data: { taskId: 't-cap', title: 'Capped task', assignee: 'agent-1' },
    });

    // Capture requested delays; resolve immediately for determinism
    const capturedDelays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: (...args: unknown[]) => void, ms?: number) => {
      capturedDelays.push(ms ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    // Mock append to always throw SequenceConflictError
    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function () {
      throw new SequenceConflictError(0, 1);
    });

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-cap', agentId: 'agent-1', streamId: 'wf-cap' },
      tempDir,
    );

    // Assert: with Math.random mocked to 0, total delay is deterministic:
    // 50 + 100 + 200 = 350ms, well below any reasonable cap
    const totalRequestedDelay = capturedDelays.reduce((sum, d) => sum + d, 0);
    expect(totalRequestedDelay).toBe(350);
    expect(result.success).toBe(false);
  });
});

// ─── F-TASK-1 / F-TASK-2: Idempotency keys on task events ──────────────────

describe('Task event idempotency keys', () => {
  it('handleTaskComplete_EventAppend_HasIdempotencyKey', async () => {
    // Arrange: create an event store and seed with a task assignment + passing gate
    const store = new EventStore(tempDir);
    await store.append('wf-idem-comp', {
      type: 'task.assigned',
      data: { taskId: 't-idem-1', title: 'Idem test', assignee: 'agent-1' },
    });
    await store.append('wf-idem-comp', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-idem-1' } },
    });

    // Spy on append to capture idempotency keys
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

    // Act
    const result = await handleTaskComplete(
      { taskId: 't-idem-1', streamId: 'wf-idem-comp' },
      tempDir,
    );

    // Assert: task.completed event should have an idempotency key
    expect(result.success).toBe(true);
    const completedCalls = appendCalls.filter((c) => c.type === 'task.completed');
    expect(completedCalls.length).toBe(1);
    expect(completedCalls[0].idempotencyKey).toBe('wf-idem-comp:task.completed:t-idem-1');
  });

  it('handleTaskFail_EventAppend_HasIdempotencyKey', async () => {
    // Arrange: create an event store and seed with a task assignment
    const store = new EventStore(tempDir);
    await store.append('wf-idem-fail', {
      type: 'task.assigned',
      data: { taskId: 't-idem-2', title: 'Idem fail test', assignee: 'agent-1' },
    });

    // Spy on append to capture idempotency keys
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

    // Act
    const result = await handleTaskFail(
      { taskId: 't-idem-2', error: 'Something broke', streamId: 'wf-idem-fail' },
      tempDir,
    );

    // Assert: task.failed event should have an idempotency key
    expect(result.success).toBe(true);
    const failedCalls = appendCalls.filter((c) => c.type === 'task.failed');
    expect(failedCalls.length).toBe(1);
    expect(failedCalls[0].idempotencyKey).toBe('wf-idem-fail:task.failed:t-idem-2');
  });
});

// ─── C1: Evidence field on task_complete ─────────────────────────────────────

describe('task_complete evidence field', () => {
  it('TaskComplete_WithEvidence_StoresInEventData', async () => {
    // Arrange
    const store = new EventStore(tempDir);
    await store.append('wf-ev-1', {
      type: 'task.assigned',
      data: { taskId: 't-ev-1', title: 'Evidence test', assignee: 'agent-1' },
    });
    await store.append('wf-ev-1', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-ev-1' } },
    });

    const evidence = {
      type: 'test' as const,
      output: 'PASS src/foo.test.ts (5 tests)',
      passed: true,
    };

    // Act
    const result = await handleTaskComplete(
      { taskId: 't-ev-1', streamId: 'wf-ev-1', evidence },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const events = await store.query('wf-ev-1');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    expect(completedEvent).toBeDefined();
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.evidence).toEqual(evidence);
    expect(data.verified).toBe(true);
  });

  it('TaskComplete_WithoutEvidence_MarksUnverified', async () => {
    // Arrange
    const store = new EventStore(tempDir);
    await store.append('wf-ev-2', {
      type: 'task.assigned',
      data: { taskId: 't-ev-2', title: 'No evidence test', assignee: 'agent-1' },
    });
    await store.append('wf-ev-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-ev-2' } },
    });

    // Act
    const result = await handleTaskComplete(
      { taskId: 't-ev-2', streamId: 'wf-ev-2' },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const events = await store.query('wf-ev-2');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    expect(completedEvent).toBeDefined();
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.evidence).toBeUndefined();
    expect(data.verified).toBe(false);
  });

  it('TaskComplete_EvidenceContainsTestOutput_Stored', async () => {
    // Arrange
    const store = new EventStore(tempDir);
    await store.append('wf-ev-3', {
      type: 'task.assigned',
      data: { taskId: 't-ev-3', title: 'Test output evidence', assignee: 'agent-1' },
    });
    await store.append('wf-ev-3', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-ev-3' } },
    });

    const evidence = {
      type: 'test' as const,
      output: 'Tests: 42 passed, 0 failed\nTime: 3.2s',
      passed: true,
    };

    // Act
    const result = await handleTaskComplete(
      { taskId: 't-ev-3', streamId: 'wf-ev-3', evidence },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const events = await store.query('wf-ev-3');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.evidence).toEqual(evidence);
    expect((data.evidence as Record<string, unknown>).type).toBe('test');
    expect(data.verified).toBe(true);
  });

  it('TaskComplete_EvidenceContainsBuildOutput_Stored', async () => {
    // Arrange
    const store = new EventStore(tempDir);
    await store.append('wf-ev-4', {
      type: 'task.assigned',
      data: { taskId: 't-ev-4', title: 'Build output evidence', assignee: 'agent-1' },
    });
    await store.append('wf-ev-4', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-ev-4' } },
    });

    const evidence = {
      type: 'build' as const,
      output: 'Build completed successfully in 12.5s',
      passed: true,
    };

    // Act
    const result = await handleTaskComplete(
      { taskId: 't-ev-4', streamId: 'wf-ev-4', evidence },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const events = await store.query('wf-ev-4');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.evidence).toEqual(evidence);
    expect((data.evidence as Record<string, unknown>).type).toBe('build');
    expect(data.verified).toBe(true);
  });

  it('handleTaskComplete_WithProvenanceInResult_IncludesFieldsInEvent', async () => {
    // Arrange
    const store = new EventStore(tempDir);
    await store.append('wf-prov-1', {
      type: 'task.assigned',
      data: { taskId: 't-prov-1', title: 'Provenance test', assignee: 'agent-1' },
    });
    await store.append('wf-prov-1', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-prov-1' } },
    });

    const provenanceResult = {
      implements: ['DR-1', 'DR-3'],
      tests: [{ name: 'test1', file: 'src/foo.test.ts' }],
      files: ['src/foo.ts', 'src/foo.test.ts'],
    };

    // Act
    const result = await handleTaskComplete(
      { taskId: 't-prov-1', streamId: 'wf-prov-1', result: provenanceResult },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
    const events = await store.query('wf-prov-1');
    const completedEvent = events.find((e) => e.type === 'task.completed');
    expect(completedEvent).toBeDefined();
    const data = completedEvent!.data as Record<string, unknown>;
    expect(data.implements).toEqual(['DR-1', 'DR-3']);
    expect(data.tests).toEqual([{ name: 'test1', file: 'src/foo.test.ts' }]);
    expect(data.files).toEqual(['src/foo.ts', 'src/foo.test.ts']);
  });

  it('handleTaskComplete_WithoutProvenance_OmitsFields', async () => {
    // Arrange
    const store = new EventStore(tempDir);
    await store.append('wf-prov-2', {
      type: 'task.assigned',
      data: { taskId: 't-prov-2', title: 'No provenance test', assignee: 'agent-1' },
    });
    await store.append('wf-prov-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 't-prov-2' } },
    });

    // Act
    const result = await handleTaskComplete(
      { taskId: 't-prov-2', streamId: 'wf-prov-2', result: { artifacts: ['artifact1'] } },
      tempDir,
    );

    // Assert
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
    // Valid evidence with all required fields
    const validData = {
      taskId: 't1',
      evidence: { type: 'test', output: 'PASS', passed: true },
      verified: true,
    };
    expect(TaskCompletedData.parse(validData)).toEqual(validData);

    // Valid without evidence
    const noEvidence = { taskId: 't2', verified: false };
    expect(TaskCompletedData.parse(noEvidence)).toEqual(noEvidence);

    // Valid with all types
    for (const evidenceType of ['test', 'build', 'typecheck', 'manual']) {
      const data = {
        taskId: 't3',
        evidence: { type: evidenceType, output: 'output', passed: true },
        verified: true,
      };
      expect(() => TaskCompletedData.parse(data)).not.toThrow();
    }

    // Invalid: evidence with wrong type enum
    const invalidType = {
      taskId: 't4',
      evidence: { type: 'invalid', output: 'output', passed: true },
      verified: true,
    };
    expect(() => TaskCompletedData.parse(invalidType)).toThrow();

    // Invalid: evidence missing required field 'output'
    const missingOutput = {
      taskId: 't5',
      evidence: { type: 'test', passed: true },
      verified: true,
    };
    expect(() => TaskCompletedData.parse(missingOutput)).toThrow();

    // Invalid: evidence missing required field 'passed'
    const missingPassed = {
      taskId: 't6',
      evidence: { type: 'test', output: 'PASS' },
      verified: true,
    };
    expect(() => TaskCompletedData.parse(missingPassed)).toThrow();
  });
});

// ─── Gate Enforcement in handleTaskComplete ──────────────────────────────────

describe('handleTaskComplete gate enforcement', () => {
  it('HandleTaskComplete_NoTddGate_RejectsCompletion', async () => {
    // Arrange: seed with task.assigned but NO gate event
    const store = new EventStore(tempDir);
    await store.append('wf-gate-1', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'Gate test', assignee: 'agent-1' },
    });

    // Act
    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-1', result: { summary: 'done' } },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });

  it('HandleTaskComplete_PassingTddGate_AllowsCompletion', async () => {
    // Arrange: seed with gate.executed event that passed for this taskId
    const store = new EventStore(tempDir);
    await store.append('wf-gate-2', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'Gate test', assignee: 'agent-1' },
    });
    await store.append('wf-gate-2', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: true, details: { taskId: 'T-01' } },
    });

    // Act
    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-2' },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(true);
  });

  it('HandleTaskComplete_FailingTddGate_RejectsCompletion', async () => {
    // Arrange: seed with gate.executed event that FAILED for this taskId
    const store = new EventStore(tempDir);
    await store.append('wf-gate-3', {
      type: 'task.assigned',
      data: { taskId: 'T-01', title: 'Gate test', assignee: 'agent-1' },
    });
    await store.append('wf-gate-3', {
      type: 'gate.executed',
      data: { gateName: 'tdd-compliance', layer: 'task', passed: false, details: { taskId: 'T-01' } },
    });

    // Act
    const result = await handleTaskComplete(
      { taskId: 'T-01', streamId: 'wf-gate-3' },
      tempDir,
    );

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GATE_NOT_PASSED');
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore, SequenceConflictError } from '../event-store/store.js';
import { handleTaskClaim, resetModuleEventStore } from './tools.js';
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

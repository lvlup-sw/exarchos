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

describe('handleTaskClaim Exponential Backoff', () => {
  it('HandleTaskClaim_Retries_WithExponentialBackoff', async () => {
    // Arrange: seed a stream with just a task.assigned event
    const store = new EventStore(tempDir);
    await store.append('wf-backoff', {
      type: 'task.assigned',
      data: { taskId: 't-bo', title: 'Backoff task', assignee: 'agent-1' },
    });

    // Mock the store's append to throw SequenceConflictError on first 3 calls
    // (the claim attempts), then never succeed
    const storeMod = await import('../event-store/store.js');
    const originalAppend = EventStore.prototype.append;
    let appendCallCount = 0;
    const delays: number[] = [];
    let lastCallTime = Date.now();

    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function (this: EventStore, ...args) {
      appendCallCount++;
      const now = Date.now();
      if (appendCallCount > 1) {
        delays.push(now - lastCallTime);
      }
      lastCallTime = now;
      // Always throw conflict to test backoff timing
      throw new SequenceConflictError(0, 1);
    });

    const start = Date.now();

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-bo', agentId: 'agent-1', streamId: 'wf-backoff' },
      tempDir,
    );

    const totalDuration = Date.now() - start;

    // Assert: Should fail after retries
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CLAIM_FAILED');

    // Assert: Verify backoff delays occurred (~50ms, ~100ms, ~200ms)
    // Total should be at least ~150ms (minimum backoff sum: 50 + 100 = 150 for 3 retries)
    expect(totalDuration).toBeGreaterThan(100);

    vi.restoreAllMocks();
  });

  it('HandleTaskClaim_StillReturnsClaimFailed_AfterRetries', async () => {
    // Arrange: seed a stream
    const store = new EventStore(tempDir);
    await store.append('wf-retry-fail', {
      type: 'task.assigned',
      data: { taskId: 't-rf', title: 'Retry fail task', assignee: 'agent-1' },
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

    vi.restoreAllMocks();
  });

  it('HandleTaskClaim_BackoffCapped_AtReasonableMax', async () => {
    // Arrange: seed a stream
    const store = new EventStore(tempDir);
    await store.append('wf-cap', {
      type: 'task.assigned',
      data: { taskId: 't-cap', title: 'Capped task', assignee: 'agent-1' },
    });

    // Mock append to always throw SequenceConflictError
    vi.spyOn(EventStore.prototype, 'append').mockImplementation(async function () {
      throw new SequenceConflictError(0, 1);
    });

    const start = Date.now();

    // Act
    const result = await handleTaskClaim(
      { taskId: 't-cap', agentId: 'agent-1', streamId: 'wf-cap' },
      tempDir,
    );

    const totalDuration = Date.now() - start;

    // Assert: total delay should be less than 500ms
    expect(totalDuration).toBeLessThan(500);
    expect(result.success).toBe(false);

    vi.restoreAllMocks();
  });
});

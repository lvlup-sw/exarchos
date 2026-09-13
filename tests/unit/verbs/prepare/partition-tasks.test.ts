// Partitioning a plan's tasks into the batch still to be delegated.

import { describe, it, expect } from 'vitest';

import {
  BATCH_JOIN_ID,
  DELEGATION_STEP_ID,
  partitionDelegationBatch,
  type DelegationBatch,
} from '../../../../src/verbs/prepare/partition-tasks.js';

function task(id: string, status: string, blockedBy: readonly string[] = []): Record<string, unknown> {
  return { id, title: `title of ${id}`, status, blockedBy };
}

function batchOf(tasks: readonly unknown[]): DelegationBatch {
  const outcome = partitionDelegationBatch(tasks);
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.batch;
}

describe('delegation batch partition', () => {
  it('Partition_CompletedTasks_AreNotInTheBatch', () => {
    const batch = batchOf([task('T-1', 'complete'), task('T-2', 'pending'), task('T-3', 'in_progress')]);
    expect(batch.tasks.map((t) => t.taskId)).toEqual(['T-2', 'T-3']);
    expect(batch.requiredResults).toEqual(['T-2', 'T-3']);
    expect(batch.tasks.every((t) => t.stepId === DELEGATION_STEP_ID)).toBe(true);
  });

  it('Partition_ABlockerInTheBatch_BecomesAnEdge', () => {
    const batch = batchOf([task('T-1', 'pending'), task('T-2', 'pending', ['T-1'])]);
    expect(batch.dependencies).toEqual([{ from: 'T-1', to: 'T-2' }]);
  });

  it('Partition_ACompletedBlocker_IsSatisfiedAndLeavesNoEdge', () => {
    const batch = batchOf([task('T-1', 'completed'), task('T-2', 'pending', ['T-1'])]);
    expect(batch.dependencies).toEqual([]);
  });

  it('Partition_ABlockerThePlanDoesNotContain_IsRefused', () => {
    const outcome = partitionDelegationBatch([task('T-2', 'pending', ['T-ghost'])]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('UNKNOWN_DEPENDENCY');
      expect(outcome.refusal.message).toContain('T-ghost');
    }
  });

  it('Partition_TwoOrMoreSinks_RejoinAtOneJoin', () => {
    // T-1 feeds T-2; T-2 and T-3 are the sinks.
    const batch = batchOf([task('T-1', 'pending'), task('T-2', 'pending', ['T-1']), task('T-3', 'pending')]);
    expect(batch.joins).toEqual([{ joinId: BATCH_JOIN_ID, waitsFor: ['T-2', 'T-3'] }]);
  });

  it('Partition_OneSink_NeedsNoJoin', () => {
    const batch = batchOf([task('T-1', 'pending'), task('T-2', 'pending', ['T-1'])]);
    expect(batch.joins).toEqual([]);
  });

  it('Partition_NoPendingTasks_IsRefused', () => {
    for (const tasks of [[], [task('T-1', 'complete')]]) {
      const outcome = partitionDelegationBatch(tasks);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.refusal.code).toBe('NOTHING_TO_PREPARE');
    }
  });

  it('Partition_ATaskIdACapsuleCannotName_IsRefused', () => {
    const outcome = partitionDelegationBatch([task('has spaces', 'pending')]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.code).toBe('INVALID_TASK_ID');
  });

  it('Partition_AMissingTitle_FallsBackToTheTaskId', () => {
    const batch = batchOf([{ id: 'T-1', status: 'pending' }]);
    expect(batch.tasks[0]?.title).toBe('T-1');
  });
});

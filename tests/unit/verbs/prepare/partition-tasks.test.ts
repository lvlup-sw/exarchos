// Partitioning a plan's tasks into the batch still to be delegated.
//
// @oracle-sources: ../../../../src/verbs/prepare/partition-tasks.ts, the ready frontier and joins worked out by hand from each small plan written in the case

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

  it('Partition_ATaskWaitingOnPendingWork_IsLeftForALaterPreparation', () => {
    const batch = batchOf([
      task('T-1', 'pending'),
      task('T-2', 'pending', ['T-1']),
      task('T-3', 'complete'),
      task('T-4', 'pending', ['T-3']),
    ]);
    expect(batch.tasks.map((t) => t.taskId)).toEqual(['T-1', 'T-4']);
    expect(batch.requiredResults).toEqual(['T-1', 'T-4']);
    expect(batch.dependencies).toEqual([]);
  });

  it('Partition_PendingTasksWithNoneReady_AreRefusedNamingWhatTheyWaitOn', () => {
    const outcome = partitionDelegationBatch([
      task('T-1', 'pending', ['T-2']),
      task('T-2', 'pending', ['T-1']),
      task('T-3', 'complete'),
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('NO_READY_TASKS');
      expect(outcome.refusal.message).toContain('"T-1" waits on "T-2"');
      expect(outcome.refusal.message).toContain('"T-2" waits on "T-1"');
      expect(outcome.refusal.message).not.toContain('T-3');
    }
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

  it('Partition_TwoOrMoreReadyTasks_RejoinAtOneJoin', () => {
    const batch = batchOf([task('T-1', 'pending'), task('T-2', 'pending', ['T-1']), task('T-3', 'pending')]);
    expect(batch.joins).toEqual([{ joinId: BATCH_JOIN_ID, waitsFor: ['T-1', 'T-3'] }]);
  });

  /**
   * A planner stamp wins, the heuristic decides otherwise, and a task with no
   * signal is medium and not boundary-touching.
   */
  it('Partition_EveryTask_CarriesItsVerificationTerms', () => {
    const batch = batchOf([
      { ...task('T-1', 'pending'), riskTier: 'low', boundaryTouching: true },
      task('T-2', 'pending'),
      { ...task('T-3', 'pending'), files: ['src/adapters/http.ts'] },
    ]);
    expect(batch.tasks.map((t) => [t.taskId, t.verification])).toEqual([
      ['T-1', { riskTier: 'low', boundaryTouching: true }],
      ['T-2', { riskTier: 'medium', boundaryTouching: false }],
      ['T-3', { riskTier: 'medium', boundaryTouching: true }],
    ]);
  });

  /**
   * The partition refuses a stamp outside the vocabulary and does not ignore it.
   * A derived tier in its place can judge a high-risk task as medium.
   */
  it('Partition_APlannerStampOutsideItsVocabulary_IsRefused', () => {
    const outcome = partitionDelegationBatch([{ ...task('T-1', 'pending'), riskTier: 'extreme' }]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('INVALID_TASK_STAMP');
      expect(outcome.refusal.message).toContain('extreme');
    }
    const flag = partitionDelegationBatch([{ ...task('T-1', 'pending'), boundaryTouching: 'yes' }]);
    expect(flag.ok).toBe(false);
    if (!flag.ok) expect(flag.refusal.code).toBe('INVALID_TASK_STAMP');
  });

  it('Partition_OneReadyTask_NeedsNoJoin', () => {
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

  it('Partition_ATaskIdThePlanNamesTwice_IsRefusedEvenWhenOnlyOneCopyIsReady', () => {
    const outcome = partitionDelegationBatch([
      task('A', 'pending'),
      task('A', 'pending', ['B']),
      task('B', 'pending', ['A']),
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe('INVALID_TASK_ID');
      expect(outcome.refusal.message).toContain('"A" appears more than once');
    }
  });

  it('Partition_AMissingTitle_FallsBackToTheTaskId', () => {
    const batch = batchOf([{ id: 'T-1', status: 'pending' }]);
    expect(batch.tasks[0]?.title).toBe('T-1');
  });
});

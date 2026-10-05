/**
 * Tests for the `merge-orchestrator@v1` reducer.
 * Each test folds events over an explicit state and asserts one transition of the phase machine in `types.ts`.
 * `merge.recovered` is the recovery event. The reducer also folds the retired `merge.rollback`, and most recovery tests use it.
 */
import { describe, it, expect } from 'vitest';
import { mergeOrchestratorReducer } from '../../../../src/projections/merge-orchestrator/reducer.js';
import {
  initialMergeOrchestratorState,
  type MergeOrchestratorState,
} from '../../../../src/projections/merge-orchestrator/types.js';
import { assertReducerImmutable } from '../../../../src/projections/testing.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

/**
 * Builds an event for the reducer tests. The reducer reads only `type` and `data`.
 * The tests do not parse the event through the schema, so the cast accepts any `type` and `data`.
 */
function makeEvent<T extends Record<string, unknown>>(
  type: string,
  data: T,
  sequence: number,
): WorkflowEvent {
  return {
    streamId: 'wf-test',
    sequence,
    timestamp: '2026-05-10T00:00:00.000Z',
    type,
    schemaVersion: '1.0',
    data,
  } as unknown as WorkflowEvent;
}

describe('mergeOrchestratorReducer — identity (Wave 2B.2, DR-1)', () => {
  it('MergeOrchestratorReducer_IdentityIsCanonical', () => {
    expect(mergeOrchestratorReducer.id).toBe('merge-orchestrator@v1');
    expect(mergeOrchestratorReducer.version).toBe(1);
    expect(mergeOrchestratorReducer.scope).toBe('stream');
  });

  it('MergeOrchestratorReducer_NoEvents_ReturnsInitialState', () => {
    expect(mergeOrchestratorReducer.initial).toEqual(initialMergeOrchestratorState);
    expect(mergeOrchestratorReducer.initial.phase).toBe('idle');
    expect(mergeOrchestratorReducer.initial.projectionSequence).toBe(0);
  });
});

describe('mergeOrchestratorReducer.apply — phase transitions (Wave 2B.2)', () => {
  it('Apply_MergePreflight_TransitionsToPreflight', () => {
    const state = mergeOrchestratorReducer.initial;
    const event = makeEvent(
      'merge.preflight',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        passed: true,
      },
      1,
    );
    const next = mergeOrchestratorReducer.apply(state, event);
    expect(next.phase).toBe('preflight');
    expect(next.preflight?.passed).toBe(true);
    expect(next.projectionSequence).toBe(1);
  });

  /** The reducer joins the `failureReasons` array into one reason string for the operator. */
  it('Apply_MergePreflight_CapturesFailureReason', () => {
    const state = mergeOrchestratorReducer.initial;
    const event = makeEvent(
      'merge.preflight',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        passed: false,
        failureReasons: ['ancestry-violation', 'worktree-dirty'],
      },
      1,
    );
    const next = mergeOrchestratorReducer.apply(state, event);
    expect(next.phase).toBe('preflight');
    expect(next.preflight?.passed).toBe(false);
    expect(next.preflight?.reason).toBeDefined();
    expect(next.preflight?.reason).toContain('ancestry-violation');
  });

  /**
   * `requested` sits between `preflight` and `executed`.
   * It records the durable intent before the merge side effect, which is not idempotent.
   * The preflight metadata stays across the transition.
   */
  it('Apply_MergeRequested_TransitionsToRequested', () => {
    const after_preflight = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      makeEvent(
        'merge.preflight',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          passed: true,
        },
        1,
      ),
    );
    const event = makeEvent(
      'merge.requested',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        strategy: 'squash',
        prNumber: 42,
      },
      2,
    );
    const next = mergeOrchestratorReducer.apply(after_preflight, event);
    expect(next.phase).toBe('requested');
    expect(next.merge?.taskId).toBe('task-1');
    expect(next.merge?.sourceBranch).toBe('feature/x');
    expect(next.merge?.targetBranch).toBe('main');
    expect(next.merge?.strategy).toBe('squash');
    expect(next.merge?.prNumber).toBe(42);
    expect(next.preflight?.passed).toBe(true);
    expect(next.projectionSequence).toBe(2);
  });

  /** `merge.executed` adds `mergeSha` and `rollbackSha` and keeps the earlier merge fields. */
  it('Apply_MergeExecuted_TransitionsToExecuted', () => {
    let state: MergeOrchestratorState = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      makeEvent(
        'merge.preflight',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          passed: true,
        },
        1,
      ),
    );
    state = mergeOrchestratorReducer.apply(
      state,
      makeEvent(
        'merge.requested',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          strategy: 'squash',
        },
        2,
      ),
    );
    const event = makeEvent(
      'merge.executed',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        strategy: 'squash',
        mergeSha: 'abc1234',
        rollbackSha: 'def5678',
      },
      3,
    );
    const next = mergeOrchestratorReducer.apply(state, event);
    expect(next.phase).toBe('executed');
    expect(next.merge?.mergeSha).toBe('abc1234');
    expect(next.merge?.rollbackSha).toBe('def5678');
    expect(next.merge?.taskId).toBe('task-1');
    expect(next.merge?.strategy).toBe('squash');
    expect(next.projectionSequence).toBe(3);
  });

  /** A recovery event from `executed` models a merge that landed and then failed verification. */
  it('Apply_MergeRollback_TransitionsToRecovering', () => {
    let state: MergeOrchestratorState = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      makeEvent(
        'merge.executed',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          mergeSha: 'abc1234',
          rollbackSha: 'def5678',
        },
        1,
      ),
    );
    const event = makeEvent(
      'merge.rollback',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        rollbackSha: 'def5678',
        reason: 'verification-failed',
      },
      2,
    );
    const next = mergeOrchestratorReducer.apply(state, event);
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.reason).toBe('verification-failed');
    expect(next.projectionSequence).toBe(2);
  });

  /**
   * A stream can hold `merge.recovered` with no `merge.rollback` after it.
   * The reducer must move to `recovering` from `merge.recovered` alone.
   */
  it('Apply_MergeRecovered_AdvancesToRecovering_WithoutLegacyRollback', () => {
    const state: MergeOrchestratorState = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      makeEvent(
        'merge.executed',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          mergeSha: 'abc1234',
          recoveryPointSha: 'def5678',
        },
        1,
      ),
    );
    const event = makeEvent(
      'merge.recovered',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        recoveryPointSha: 'def5678',
        reason: 'verification-failed',
      },
      2,
    );
    const next = mergeOrchestratorReducer.apply(state, event);
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.reason).toBe('verification-failed');
    expect(next.projectionSequence).toBe(2);
  });

  /**
   * A rollback that fails leaves the worktree in an unknown state.
   * The closed `recoveryError` enum must report that failure, and not hide it as a success.
   */
  it('Apply_MergeRollback_FoldsRecoveryErrorDiscriminator', () => {
    const state: MergeOrchestratorState = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      makeEvent(
        'merge.executed',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          mergeSha: 'abc1234',
          rollbackSha: 'def5678',
        },
        1,
      ),
    );
    const event = makeEvent(
      'merge.rollback',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        rollbackSha: 'def5678',
        reason: 'verification-failed',
        rollbackError: 'git reset --hard def5678 exited 128',
        recoveryError: 'reset-failed',
      },
      2,
    );
    const next = mergeOrchestratorReducer.apply(state, event);
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.recoveryError).toBe('reset-failed');
    expect(next.recovery?.reason).toBe('verification-failed');
    expect(next.recovery?.error).toBe('git reset --hard def5678 exited 128');
  });

  /** The projection drops a `recoveryError` value that is outside the closed enum. */
  it('Apply_MergeRollback_RejectsUnrecognisedRecoveryError', () => {
    const event = makeEvent(
      'merge.rollback',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        rollbackSha: 'def5678',
        reason: 'merge-failed',
        recoveryError: 'some-future-value-not-in-enum',
      },
      1,
    );
    const next = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      event,
    );
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.recoveryError).toBeUndefined();
    expect(next.recovery?.reason).toBe('merge-failed');
  });

  /** A rollback from `requested`, before the merge side effect runs, also moves to `recovering`. */
  it('Apply_MergeRollback_AnyPhaseTransitionsToRecovering', () => {
    let state: MergeOrchestratorState = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      makeEvent(
        'merge.preflight',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          passed: true,
        },
        1,
      ),
    );
    state = mergeOrchestratorReducer.apply(
      state,
      makeEvent(
        'merge.requested',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          strategy: 'squash',
        },
        2,
      ),
    );
    expect(state.phase).toBe('requested');
    const event = makeEvent(
      'merge.rollback',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        rollbackSha: 'aaa1111',
        reason: 'merge-failed',
      },
      3,
    );
    const next = mergeOrchestratorReducer.apply(state, event);
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.reason).toBe('merge-failed');
  });

  /** `completed` is the terminal phase, and it keeps the merge metadata. */
  it('Apply_MergeCompleted_TransitionsToCompleted', () => {
    let state: MergeOrchestratorState = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      makeEvent(
        'merge.executed',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          mergeSha: 'abc1234',
          rollbackSha: 'def5678',
        },
        1,
      ),
    );
    expect(state.phase).toBe('executed');
    const event = makeEvent('merge.completed', { taskId: 'task-1' }, 2);
    const next = mergeOrchestratorReducer.apply(state, event);
    expect(next.phase).toBe('completed');
    expect(next.merge?.mergeSha).toBe('abc1234');
    expect(next.projectionSequence).toBe(2);
  });

  /**
   * `assertReducerImmutable` freezes each state of the fold, so a mutation in `apply` throws a `TypeError`.
   * The last event has an unhandled type, so the identity-return path also gets a frozen state.
   */
  it('MergeOrchestratorReducer_IsImmutable', () => {
    const events: readonly WorkflowEvent[] = [
      makeEvent(
        'merge.preflight',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          passed: true,
        },
        1,
      ),
      makeEvent(
        'merge.requested',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          strategy: 'squash',
          prNumber: 42,
        },
        2,
      ),
      makeEvent(
        'merge.executed',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          strategy: 'squash',
          mergeSha: 'abc1234',
          rollbackSha: 'def5678',
        },
        3,
      ),
      makeEvent(
        'merge.rollback',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          rollbackSha: 'def5678',
          reason: 'verification-failed',
          rollbackError: 'reset failed',
        },
        4,
      ),
      makeEvent('merge.completed', { taskId: 'task-1' }, 5),
      makeEvent('task.completed', { taskId: 'task-1' }, 6),
    ];
    expect(() =>
      assertReducerImmutable(mergeOrchestratorReducer, events),
    ).not.toThrow();
  });

  /** An unhandled event returns the same state object, so `projectionSequence` advances only for handled events. */
  it('Apply_UnknownEvent_ReturnsStateUnchanged', () => {
    const seeded = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      makeEvent(
        'merge.preflight',
        {
          taskId: 'task-1',
          sourceBranch: 'feature/x',
          targetBranch: 'main',
          passed: true,
        },
        1,
      ),
    );
    const unknown = makeEvent(
      'task.completed',
      { taskId: 'task-1' },
      2,
    );
    const next = mergeOrchestratorReducer.apply(seeded, unknown);
    expect(next).toBe(seeded);
    expect(next.projectionSequence).toBe(seeded.projectionSequence);
  });
});

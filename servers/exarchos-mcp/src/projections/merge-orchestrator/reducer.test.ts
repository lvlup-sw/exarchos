/**
 * Tests for `merge-orchestrator@v1` reducer (Wave 2B.2 / #1304).
 *
 * GWT — Given/When/Then per `docs/architecture/projections.md` §2. Each test
 * folds one event over an explicit initial state and asserts a transition on
 * the phase machine documented in `types.ts`.
 *
 * Naming note: `merge.recovered` (#1306) is the canonical recovery event and
 * `merge.rollback` is retired (read-tolerant-not-emittable). DR-18 completed
 * the wire rename: live `merge.executed` rows carry `recoveryPointSha`; the
 * legacy `rollbackSha` / `rollbackError` names survive only in historical
 * rows, which the reducer folds via its legacy read-arms (INV-1). Tests below
 * exercise BOTH the canonical names and the historical fixtures.
 */
import { describe, it, expect } from 'vitest';
import { mergeOrchestratorReducer } from './reducer.js';
import {
  initialMergeOrchestratorState,
  type MergeOrchestratorState,
} from './types.js';
import { assertReducerImmutable } from '../testing.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

/**
 * Helper — build a minimal, schema-shaped WorkflowEvent. Only `type` and
 * `data` are load-bearing for the reducer; the rest satisfies the
 * `WorkflowEventBase` shape so tests read naturally.
 *
 * NOTE: we deliberately cast — the reducer's unit tests do NOT run events
 * through `WorkflowEventBase.parse`, so an event whose `type` isn't yet
 * registered in `event-store/schemas.ts` (e.g. `merge.completed`,
 * `merge.requested` in preview.2) can still be folded for unit coverage.
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
    // GIVEN no events, the reducer's initial state IS the canonical seed.
    expect(mergeOrchestratorReducer.initial).toEqual(initialMergeOrchestratorState);
    expect(mergeOrchestratorReducer.initial.phase).toBe('idle');
    expect(mergeOrchestratorReducer.initial.projectionSequence).toBe(0);
  });
});

describe('mergeOrchestratorReducer.apply — phase transitions (Wave 2B.2)', () => {
  it('Apply_MergePreflight_TransitionsToPreflight', () => {
    // GIVEN an idle reducer state.
    const state = mergeOrchestratorReducer.initial;
    // WHEN we fold a merge.preflight event.
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
    // THEN phase advances to 'preflight'; preflight metadata is captured.
    expect(next.phase).toBe('preflight');
    expect(next.preflight?.passed).toBe(true);
    expect(next.projectionSequence).toBe(1);
  });

  it('Apply_MergePreflight_CapturesFailureReason', () => {
    // GIVEN an idle reducer state.
    const state = mergeOrchestratorReducer.initial;
    // WHEN we fold a failed preflight event with a failureReasons array.
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
    // THEN the operator-facing reason is captured as a flattened string.
    expect(next.phase).toBe('preflight');
    expect(next.preflight?.passed).toBe(false);
    expect(next.preflight?.reason).toBeDefined();
    expect(next.preflight?.reason).toContain('ancestry-violation');
  });

  it('Apply_MergeRequested_TransitionsToRequested', () => {
    // Audit §F1.2 — the new phase between preflight and executed. Records
    // the durable intent BEFORE the non-idempotent side effect fires.

    // GIVEN a state in `preflight` with passed=true.
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
    // WHEN we fold a merge.requested event.
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
    // THEN phase advances to 'requested'; merge metadata is captured.
    expect(next.phase).toBe('requested');
    expect(next.merge?.taskId).toBe('task-1');
    expect(next.merge?.sourceBranch).toBe('feature/x');
    expect(next.merge?.targetBranch).toBe('main');
    expect(next.merge?.strategy).toBe('squash');
    expect(next.merge?.prNumber).toBe(42);
    // Preflight metadata is preserved across the transition (observability).
    expect(next.preflight?.passed).toBe(true);
    expect(next.projectionSequence).toBe(2);
  });

  it('Apply_MergeExecuted_TransitionsToExecuted', () => {
    // GIVEN a state in `requested` (post audit §F1.2 split).
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
    // WHEN we fold a merge.executed event (canonical wire names, DR-18).
    const event = makeEvent(
      'merge.executed',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        strategy: 'squash',
        mergeSha: 'abc1234',
        recoveryPointSha: 'def5678',
      },
      3,
    );
    const next = mergeOrchestratorReducer.apply(state, event);
    // THEN phase advances to 'executed'; mergeSha + recoveryPointSha captured.
    expect(next.phase).toBe('executed');
    expect(next.merge?.mergeSha).toBe('abc1234');
    expect(next.merge?.recoveryPointSha).toBe('def5678');
    // Earlier merge fields are preserved (taskId, branches, strategy).
    expect(next.merge?.taskId).toBe('task-1');
    expect(next.merge?.strategy).toBe('squash');
    expect(next.projectionSequence).toBe(3);
  });

  it('Apply_LegacyMergeExecuted_RollbackShaFoldsAsRecoveryPoint', () => {
    // INV-1 / DR-18 fold-compatibility: historical merge.executed rows carry
    // the legacy `rollbackSha` wire name. The reducer folds them onto the
    // renamed `recoveryPointSha` state field so old streams replay to the
    // same projection shape as new ones.
    const event = makeEvent(
      'merge.executed',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        mergeSha: 'abc1234',
        rollbackSha: 'def5678',
      },
      1,
    );
    const next = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      event,
    );
    expect(next.phase).toBe('executed');
    expect(next.merge?.recoveryPointSha).toBe('def5678');
  });

  it('Apply_MergeRollback_TransitionsToRecovering', () => {
    // GIVEN a state in `executed` (rollback fires after a merge lands but a
    // verification step or post-merge gate failed).
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
    // WHEN we fold a legacy merge.rollback event (retired write path; the
    // reducer keeps this read-arm so historical logs fold — INV-1).
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
    // THEN phase advances to 'recovering'; recovery context captured.
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.reason).toBe('verification-failed');
    expect(next.projectionSequence).toBe(2);
  });

  it('Apply_MergeRecovered_AdvancesToRecovering_WithoutLegacyRollback', () => {
    // #1306 dual-emit robustness (Sentry #1571 review): the canonical
    // `merge.recovered` is emitted FIRST; if the second legacy `merge.rollback`
    // append loses a sequence race (the two appends are not atomic), the stream
    // carries `merge.recovered` alone. The projection MUST still advance to
    // `recovering` off the canonical event so it never strands at `executing`.
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
    // WHEN we fold a merge.recovered event ALONE (no merge.rollback follows).
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
    // THEN phase advances to 'recovering' off the canonical event.
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.reason).toBe('verification-failed');
    expect(next.projectionSequence).toBe(2);
  });

  it('Apply_MergeRecovered_FoldsRecoveryErrorDetail', () => {
    // DR-18: the canonical `merge.recovered` carries `recoveryErrorDetail`
    // (not the legacy `rollbackError`). Pre-rename the reducer only read the
    // legacy name, silently dropping the canonical event's detail — this pins
    // the canonical read.
    const event = makeEvent(
      'merge.recovered',
      {
        taskId: 'task-1',
        sourceBranch: 'feature/x',
        targetBranch: 'main',
        recoveryPointSha: 'def5678',
        reason: 'verification-failed',
        recoveryError: 'reset-failed',
        recoveryErrorDetail: 'git reset --keep def5678 exited 128',
      },
      1,
    );
    const next = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      event,
    );
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.recoveryError).toBe('reset-failed');
    expect(next.recovery?.error).toBe('git reset --keep def5678 exited 128');
  });

  it('Apply_MergeRollback_FoldsRecoveryErrorDiscriminator', () => {
    // INV-14: indeterminate worktree must surface explicitly via the closed
    // `recoveryError` enum, not as a silent success.

    // GIVEN a state in `executed` and a rollback that failed at the substrate.
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
    // WHEN we fold a merge.rollback event carrying the INV-14 discriminator.
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
    // THEN the recoveryError enum value lands on the projection.
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.recoveryError).toBe('reset-failed');
    expect(next.recovery?.reason).toBe('verification-failed');
    expect(next.recovery?.error).toBe('git reset --hard def5678 exited 128');
  });

  it('Apply_MergeRollback_RejectsUnrecognisedRecoveryError', () => {
    // GIVEN a rollback event carrying a recoveryError outside the closed enum.
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
    // WHEN we fold it.
    const next = mergeOrchestratorReducer.apply(
      mergeOrchestratorReducer.initial,
      event,
    );
    // THEN the projection narrows the unknown value away — never carries a
    // recoveryError the enum doesn't sanction.
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.recoveryError).toBeUndefined();
    expect(next.recovery?.reason).toBe('merge-failed');
  });

  it('Apply_MergeRollback_AnyPhaseTransitionsToRecovering', () => {
    // GIVEN state in `requested` (rollback before the side effect actually fires).
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
    // WHEN merge.rollback fires from requested.
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
    // THEN it still routes to recovering (any → recovering).
    expect(next.phase).toBe('recovering');
    expect(next.recovery?.reason).toBe('merge-failed');
  });

  it('Apply_MergeCompleted_TransitionsToCompleted', () => {
    // GIVEN a state in `executed`.
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
    // WHEN we fold a merge.completed event.
    const event = makeEvent('merge.completed', { taskId: 'task-1' }, 2);
    const next = mergeOrchestratorReducer.apply(state, event);
    // THEN phase advances to 'completed' (terminal); merge metadata preserved.
    expect(next.phase).toBe('completed');
    expect(next.merge?.mergeSha).toBe('abc1234');
    expect(next.projectionSequence).toBe(2);
  });

  it('MergeOrchestratorReducer_IsImmutable', () => {
    // DR-1 purity contract — folds a representative event sequence through
    // the reducer with each intermediate state deep-frozen. Any in-place
    // mutation of the `state` argument by `apply` would surface as a
    // TypeError under strict-mode frozen-object semantics.
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
      // An unhandled type — assert the identity-return path also respects
      // frozen input (no spread, no in-place mutation).
      makeEvent('task.completed', { taskId: 'task-1' }, 6),
    ];
    expect(() =>
      assertReducerImmutable(mergeOrchestratorReducer, events),
    ).not.toThrow();
  });

  it('Apply_UnknownEvent_ReturnsStateUnchanged', () => {
    // GIVEN a non-trivial state already produced by some merge events.
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
    // WHEN we fold a non-merge event.
    const unknown = makeEvent(
      'task.completed',
      { taskId: 'task-1' },
      2,
    );
    const next = mergeOrchestratorReducer.apply(seeded, unknown);
    // THEN state is returned by identity — projectionSequence does NOT bump,
    // mirroring the `rehydration@v1` convention that only handled events
    // advance the monotonic counter.
    expect(next).toBe(seeded);
    expect(next.projectionSequence).toBe(seeded.projectionSequence);
  });
});

import { describe, it, expect } from 'vitest';
import { computeNextActions } from './next-actions-computer.js';
import { NextAction } from './next-action.js';
import { getHSMDefinition, executeTransition } from './workflow/state-machine.js';

describe('computeNextActions (T040, DR-8)', () => {
  it('NextActions_Given_PlanPhase_Then_IncludesDelegateTransition', () => {
    // The feature HSM goes plan-review → delegate, which is the canonical
    // "plan → delegate" transition in the feature workflow topology.
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'plan-review', workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions.length).toBeGreaterThan(0);

    // Every element validates against the NextAction Zod schema.
    for (const a of actions) {
      expect(NextAction.safeParse(a).success).toBe(true);
    }

    // At least one action corresponds to the plan-review → delegate transition.
    const hasDelegate = actions.some(
      (a) =>
        a.verb === 'delegate' ||
        a.validTargets?.includes('delegate') === true,
    );
    expect(hasDelegate).toBe(true);
  });

  it('NextActions_UnknownPhase_ReturnsEmpty', () => {
    const hsm = getHSMDefinition('feature');
    const state = { phase: 'not-a-real-phase', workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions).toEqual([]);
  });

  it('NextActions_MissingPhase_ReturnsEmpty', () => {
    const hsm = getHSMDefinition('feature');
    const state = { workflowType: 'feature' };

    const actions = computeNextActions(state, hsm);

    expect(actions).toEqual([]);
  });

  // T18 (DR-MO-1): when the workflow is parked in `merge-pending` and the
  // merge orchestrator hasn't already terminated, surface a `merge_orchestrate`
  // action verb so callers can auto-trigger the subagent worktree merge.
  it('computeNextActions_MergePendingPhase_ReturnsMergeOrchestrate', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'pending', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge).toBeDefined();
    expect(merge?.validTargets).toEqual(['merge_orchestrate']);
    expect(merge?.reason).toBe('Pending subagent worktree merge');
  });

  it('computeNextActions_MergeOrchestratorPending_IncludesIdempotencyKey', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'pending', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge?.idempotencyKey).toBe('feat-x:merge_orchestrate:T11');
  });

  // T19 (DR-MO-1): when the merge orchestrator has already terminated
  // (phase ∈ EXCLUDED_MERGE_PHASES = { 'completed', 'rolled-back', 'aborted' }),
  // the `merge_orchestrate` next-action MUST be omitted so callers cannot
  // re-trigger a merge that has already resolved. The omission filter shares
  // the EXCLUDED_MERGE_PHASES constant with the HSM `merge-pending` entry
  // predicate (T17) — they MUST stay in lockstep.
  it('computeNextActions_MergeOrchestratorCompleted_OmitsMergeOrchestrate', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'completed', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge).toBeUndefined();
  });

  it('computeNextActions_MergeOrchestratorRolledBack_OmitsMergeOrchestrate', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'rolled-back', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge).toBeUndefined();
  });

  it('computeNextActions_MergeOrchestratorAborted_OmitsMergeOrchestrate', () => {
    const hsm = getHSMDefinition('feature');
    const state = {
      phase: 'merge-pending',
      workflowType: 'feature',
      mergeOrchestrator: { phase: 'aborted', taskId: 'T11' },
      featureId: 'feat-x',
    };

    const actions = computeNextActions(state, hsm);

    const merge = actions.find((a) => a.verb === 'merge_orchestrate');
    expect(merge).toBeUndefined();
  });

  // fix-001 (review #1213, T-01): verifies #1208's fix at HEAD.
  //
  // Scenario from the dogfood report: a workflow parked in `delegate` emits
  // `task.completed` with `data.worktreePath`. PR #1193 wired the
  // `delegate → merge-pending` transition (guarded by the
  // `merge-pending-entry` predicate that inspects the latest task.completed
  // for a worktree association) and the `merge_orchestrate` next-action
  // verb. This test stitches both ends together: starting from the
  // `delegate` phase, the HSM transition succeeds and `computeNextActions`
  // surfaces the `merge_orchestrate` verb. If either end regresses (the
  // guard stops recognizing `worktreePath`, or the next-action computer
  // stops surfacing `merge_orchestrate` in `merge-pending`), this test
  // fails — closing the original #1208 reproduction.
  it('mergePendingDetour_TaskCompletedWithWorktreePath_SurfacesMergeOrchestrateVerb', () => {
    const hsm = getHSMDefinition('feature');

    // Workflow parked in `delegate` with a recently-completed task that
    // carries a worktree path. Mirror the event-store stub used elsewhere
    // in this suite (`state._events` is the canonical shape for HSM guards).
    const initial = {
      phase: 'delegate',
      workflowType: 'feature',
      featureId: 'feat-x',
      _events: [
        {
          type: 'task.completed',
          data: { taskId: 'T11', worktreePath: '/tmp/.worktrees/feat-x-T11' },
        },
      ],
    };

    // Drive the HSM transition the same way prepare_synthesis / merge
    // orchestration would: this is the "detour" that #1208 originally
    // reported as missing. Should succeed at HEAD.
    const transition = executeTransition(hsm, initial, 'merge-pending');
    expect(transition.success).toBe(true);
    expect(transition.newPhase).toBe('merge-pending');

    // CodeRabbit #16 (#1213): drive computeNextActions with the phase the
    // HSM actually emitted instead of a manually-rebuilt literal. If
    // executeTransition is ever modified to land on a different phase,
    // this test will fail loudly instead of silently passing on a
    // hardcoded 'merge-pending'.
    const transitioned = {
      ...initial,
      phase: transition.newPhase!,
      // mergeOrchestrator is set by handleMergeOrchestrate; absent at this
      // step, which the surfacing filter treats as "not yet terminated".
    };

    const actions = computeNextActions(transitioned, hsm);
    const merge = actions.find((a) => a.verb === 'merge_orchestrate');

    // PASS = #1208 fixed-in-#1193 confirmed at HEAD. FAIL would surface a
    // residual regression in either the HSM detour or the next-action
    // surfacing.
    expect(merge).toBeDefined();
    expect(merge?.validTargets).toEqual(['merge_orchestrate']);
    expect(merge?.reason).toBe('Pending subagent worktree merge');
  });
});

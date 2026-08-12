import { describe, it, expect } from 'vitest';
import {
  delegationReadinessProjection,
  DELEGATION_READINESS_VIEW,
} from './delegation-readiness-view.js';
import type { DelegationReadinessState } from './delegation-readiness-view.js';
import type { WorkflowEvent } from '../../events/schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

describe('DelegationReadinessView', () => {
  it('exports the correct view name constant', () => {
    expect(DELEGATION_READINESS_VIEW).toBe('delegation-readiness');
  });

  // ─── T1: Init ───────────────────────────────────────────────────────────────

  describe('init', () => {
    it('Init_ReturnsNotReady_WithEmptyState', () => {
      const state = delegationReadinessProjection.init();

      expect(state.ready).toBe(false);
      expect(state.blockers).toContain('plan not approved');
      expect(state.blockers).toContain('no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation');
      expect(state.blockers).not.toContain('quality signals not queried');
      expect(state.plan).toEqual({ approved: false, taskCount: 0, artifactPresent: false });
      expect(state.quality).toEqual({
        queried: false,
        gatePassRate: null,
        regressions: [],
      });
      expect(state.worktrees).toEqual({
        expected: 0,
        ready: 0,
        failed: [],
        assignedTaskIds: [],
        readyTaskIds: [],
      });
    });

    it('Init_PlanArtifactMissing_BlockerPresent', () => {
      // T-02: plan-artifact presence is now tracked in the projection (DR-T-1).
      const state = delegationReadinessProjection.init();

      expect(state.plan.artifactPresent).toBe(false);
      expect(state.blockers).toContain('Plan artifact is missing');
    });
  });

  // ─── T2: workflow.transition → plan-review ────────────────────────────────

  describe('apply - workflow.transition', () => {
    it('Apply_WorkflowTransition_ToPlanReview_SetsPlanApproved', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('workflow.transition', {
        from: 'planning',
        to: 'plan-review',
        trigger: 'PLAN_COMPLETE',
        featureId: 'feat-1',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.approved).toBe(true);
      expect(next.blockers).not.toContain('plan not approved');
    });

    it('Apply_WorkflowTransition_ToOtherPhase_DoesNotSetPlanApproved', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('workflow.transition', {
        from: 'ideate',
        to: 'planning',
        trigger: 'IDEATION_COMPLETE',
        featureId: 'feat-1',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.approved).toBe(false);
      expect(next.blockers).toContain('plan not approved');
    });
  });

  // ─── T3: gate.executed (plan-coverage) ────────────────────────────────────

  describe('apply - gate.executed', () => {
    it('Apply_GateExecuted_PlanCoverage_RecordsGateResult', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'plan-coverage-check',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: {},
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.quality.queried).toBe(true);
      expect(next.quality.gatePassRate).toBe(1);
      expect(next.blockers).not.toContain('quality signals not queried');
    });

    it('Apply_GateExecuted_PlanCoverage_Failed_RecordsRegression', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'plan-coverage-check',
        layer: 'validation',
        passed: false,
        duration: 300,
        details: { reason: 'incomplete coverage' },
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.quality.queried).toBe(true);
      expect(next.quality.gatePassRate).toBe(0);
      expect(next.quality.regressions).toContain('incomplete coverage');
    });

    it('Apply_GateExecuted_NonPlanCoverage_DoesNotUpdateQuality', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 1200,
        details: {},
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.quality.queried).toBe(false);
    });
  });

  // ─── T4: task.assigned ────────────────────────────────────────────────────

  describe('apply - task.assigned', () => {
    it('Apply_TaskAssigned_IncrementsTaskCount', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement feature A',
        worktree: '/tmp/wt-1',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.taskCount).toBe(1);
      expect(next.worktrees.expected).toBe(1);
      expect(next.blockers).not.toContain('no task.assigned events found — emit task.assigned events for each task via exarchos_event before calling prepare_delegation');
    });

    it('Apply_MultipleTasksAssigned_IncrementsCorrectly', () => {
      let state = delegationReadinessProjection.init();

      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Task 1',
        worktree: '/tmp/wt-1',
      }, 1));

      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-2',
        title: 'Task 2',
        worktree: '/tmp/wt-2',
      }, 2));

      expect(state.plan.taskCount).toBe(2);
      expect(state.worktrees.expected).toBe(2);
    });

    // ─── DR-T-2 (T-04): per-task ID tracking ──────────────────────────────

    it('Apply_TaskAssigned_AccumulatesAssignedTaskIds', () => {
      let state = delegationReadinessProjection.init();
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1', title: 'A',
      }, 1));
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-2', title: 'B',
      }, 2));

      expect(state.worktrees.assignedTaskIds).toEqual(['task-1', 'task-2']);
    });

    it('Apply_DuplicateTaskAssigned_DeduplicatesByTaskId', () => {
      let state = delegationReadinessProjection.init();
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1', title: 'A',
      }, 1));
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1', title: 'A again',
      }, 2));

      // Same taskId — assignedTaskIds and counts both deduplicated.
      expect(state.worktrees.assignedTaskIds).toEqual(['task-1']);
      expect(state.worktrees.expected).toBe(1);
      expect(state.plan.taskCount).toBe(1);
    });

    it('Apply_LegacyExpectedCount_DerivedFromAssignedTaskIds', () => {
      let state = delegationReadinessProjection.init();
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1', title: 'A',
      }, 1));
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-2', title: 'B',
      }, 2));

      // expected count is now derived from assignedTaskIds.length
      expect(state.worktrees.expected).toBe(state.worktrees.assignedTaskIds.length);
    });
  });

  // ─── T5: worktree.created ─────────────────────────────────────────────────

  describe('apply - worktree.created', () => {
    it('Apply_WorktreeCreated_IncrementsWorktreeReady', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.worktrees.ready).toBe(1);
    });

    // DR-T-2 (T-04): track readyTaskIds keyed by taskId in event data.
    it('Apply_WorktreeCreatedWithTaskId_AddsToReadyTaskIds', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.worktrees.readyTaskIds).toEqual(['task-1']);
      expect(next.worktrees.ready).toBe(1);
    });

    it('Apply_DuplicateWorktreeCreated_DeduplicatesByTaskId', () => {
      let state = delegationReadinessProjection.init();
      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1', taskId: 'task-1',
      }, 1));
      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1', taskId: 'task-1',
      }, 2));

      expect(state.worktrees.readyTaskIds).toEqual(['task-1']);
      expect(state.worktrees.ready).toBe(1);
    });

    it('Apply_WorktreeCreatedWithoutTaskId_StillIncrementsReadyCount', () => {
      // Back-compat: legacy worktree.created events without taskId still
      // bump the count (using path as a fallback identity) but do not
      // contribute to per-task scoping.
      const state = delegationReadinessProjection.init();
      const event = makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        // taskId omitted
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.worktrees.ready).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── T6: worktree.baseline failed ─────────────────────────────────────────

  describe('apply - worktree.baseline', () => {
    it('Apply_WorktreeBaseline_Failed_AddsToFailedList', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('worktree.baseline', {
        worktreePath: '/tmp/wt-1',
        status: 'failed',
        reason: 'build failure',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.worktrees.failed).toContain('/tmp/wt-1');
    });

    it('Apply_WorktreeBaseline_Passed_DoesNotAddToFailedList', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('worktree.baseline', {
        worktreePath: '/tmp/wt-1',
        status: 'passed',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.worktrees.failed).toEqual([]);
    });
  });

  // ─── T7: state.patched ──────────────────────────────────────────────────

  describe('apply - state.patched', () => {
    it('Apply_StatePatched_PlanReviewApproved_SetsPlanApproved', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview'],
        patch: { planReview: { approved: true } },
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.approved).toBe(true);
      expect(next.blockers).not.toContain('plan not approved');
    });

    it('Apply_StatePatched_DotPathPlanReviewApproved_SetsPlanApproved', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview.approved'],
        patch: { 'planReview.approved': true },
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.approved).toBe(true);
      expect(next.blockers).not.toContain('plan not approved');
    });

    it('Apply_StatePatched_PlanReviewApprovedFalse_ClearsPlanApproved', () => {
      let state = delegationReadinessProjection.init();

      // First approve
      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview.approved'],
        patch: { 'planReview.approved': true },
      }, 1));
      expect(state.plan.approved).toBe(true);

      // Then revoke
      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview.approved'],
        patch: { 'planReview.approved': false },
      }, 2));

      expect(state.plan.approved).toBe(false);
      expect(state.blockers).toContain('plan not approved');
    });

    it('Apply_StatePatched_NestedPlanReviewFalse_ClearsPlanApproved', () => {
      let state = delegationReadinessProjection.init();

      // First approve via nested form
      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview'],
        patch: { planReview: { approved: true } },
      }, 1));
      expect(state.plan.approved).toBe(true);

      // Then revoke via nested form
      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview'],
        patch: { planReview: { approved: false } },
      }, 2));

      expect(state.plan.approved).toBe(false);
      expect(state.blockers).toContain('plan not approved');
    });

    it('Apply_StatePatched_UnrelatedField_DoesNotChangePlan', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['brief'],
        patch: { brief: { problem: 'some problem' } },
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.approved).toBe(false);
    });

    it('Apply_StatePatched_NoPatch_ReturnsUnchanged', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: [],
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next).toBe(state);
    });

    // ─── DR-T-1 (T-02): plan-artifact projection fold ──────────────────────

    it('Apply_StatePatched_NestedArtifactsPlan_FlipsArtifactPresent', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['artifacts'],
        patch: { artifacts: { plan: 'docs/plans/foo.md' } },
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.artifactPresent).toBe(true);
      expect(next.blockers).not.toContain('Plan artifact is missing');
    });

    it('Apply_StatePatched_DotPathArtifactsPlan_FlipsArtifactPresent', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['artifacts.plan'],
        patch: { 'artifacts.plan': 'docs/plans/foo.md' },
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.artifactPresent).toBe(true);
      expect(next.blockers).not.toContain('Plan artifact is missing');
    });

    it('Apply_StatePatched_ArtifactsPlanEmpty_DoesNotFlipArtifactPresent', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['artifacts.plan'],
        patch: { 'artifacts.plan': '' },
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.artifactPresent).toBe(false);
      expect(next.blockers).toContain('Plan artifact is missing');
    });

    it('Apply_StatePatched_WhitespaceOnlyPlan_ReportsArtifactAbsent', () => {
      // Regression (DR-5 predicate divergence): the readiness fold used to
      // judge presence with an UN-trimmed `length > 0`, while the guard
      // (`workflow/guards.ts` isTypedArtifactReference) and the admission
      // algebra both require a TRIMMED non-empty string. A whitespace-only
      // plan therefore read "present" in readiness but was denied at
      // admission. All three surfaces must agree: whitespace-only = absent.
      const state = delegationReadinessProjection.init();
      const event = makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['artifacts.plan'],
        patch: { 'artifacts.plan': '   \n\t  ' },
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.plan.artifactPresent).toBe(false);
      expect(next.blockers).toContain('Plan artifact is missing');
    });
  });

  // ─── T8: All conditions met → ready ───────────────────────────────────────

  describe('apply - readiness computation', () => {
    it('Apply_AllConditionsMet_SetsReadyTrue', () => {
      let state = delegationReadinessProjection.init();

      // Approve plan
      state = delegationReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'planning',
        to: 'plan-review',
        trigger: 'PLAN_COMPLETE',
        featureId: 'feat-1',
      }, 1));

      // DR-T-1: capture plan artifact (now required for full readiness)
      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['artifacts.plan'],
        patch: { 'artifacts.plan': 'docs/plans/feat-1.md' },
      }, 2));

      // Assign a task
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement feature A',
        worktree: '/tmp/wt-1',
      }, 3));

      // Worktree created
      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 4));

      expect(state.ready).toBe(true);
      expect(state.blockers).toEqual([]);
    });

    it('Apply_PlanApprovedViaStatePatch_WithTaskAndWorktree_SetsReady', () => {
      let state = delegationReadinessProjection.init();

      // Approve plan via state.patched (instead of workflow.transition)
      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview'],
        patch: { planReview: { approved: true } },
      }, 1));

      // DR-T-1: capture plan artifact
      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['artifacts.plan'],
        patch: { 'artifacts.plan': 'docs/plans/feat-1.md' },
      }, 2));

      // Assign a task
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement feature A',
        worktree: '/tmp/wt-1',
      }, 3));

      // Worktree created
      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 4));

      expect(state.ready).toBe(true);
      expect(state.blockers).toEqual([]);
    });

    it('Apply_MissingWorktrees_ReportsBlockers', () => {
      let state = delegationReadinessProjection.init();

      // Approve plan
      state = delegationReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'planning',
        to: 'plan-review',
        trigger: 'PLAN_COMPLETE',
        featureId: 'feat-1',
      }, 1));

      // Assign 2 tasks
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Task 1',
        worktree: '/tmp/wt-1',
      }, 2));
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-2',
        title: 'Task 2',
        worktree: '/tmp/wt-2',
      }, 3));

      // Only 1 worktree created
      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 4));

      expect(state.ready).toBe(false);
      expect(state.blockers).toContain('1 worktrees pending');
    });

    it('Apply_PlanNotApproved_ReportsBlocker', () => {
      let state = delegationReadinessProjection.init();

      // Assign a task without approving plan
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Task 1',
        worktree: '/tmp/wt-1',
      }, 1));

      expect(state.ready).toBe(false);
      expect(state.blockers).toContain('plan not approved');
    });

    // ─── #1213 / Sentry #1: isReady consistency with computeBlockers ──────
    it('Apply_PlanArtifactMissing_OtherGatesPass_SetsReadyFalse', () => {
      // Regression: isReady() previously omitted plan.artifactPresent, so a
      // workflow with approved plan + assigned task + worktree created could
      // report ready=true while computeBlockers() still listed
      // "Plan artifact is missing". This test asserts ready is gated on
      // plan.artifactPresent matching the blocker logic.
      let state = delegationReadinessProjection.init();

      // Approve plan
      state = delegationReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'planning',
        to: 'plan-review',
        trigger: 'PLAN_COMPLETE',
        featureId: 'feat-1',
      }, 1));

      // Assign a task
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Task 1',
        worktree: '/tmp/wt-1',
      }, 2));

      // Worktree created
      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 3));

      // Plan artifact never captured → still missing
      expect(state.plan.artifactPresent).toBe(false);
      expect(state.blockers).toContain('Plan artifact is missing');
      expect(state.ready).toBe(false);
    });
  });

  // ─── DR-3: Blocker message references events ──────────────────────────────

  describe('blocker message wording', () => {
    it('DelegationReadiness_NoTaskEvents_BlockerMessageReferencesEvents', () => {
      const state = delegationReadinessProjection.init();

      // With no events, the blocker should reference "no task.assigned events found"
      const taskBlocker = state.blockers.find((b) => b.includes('task'));
      expect(taskBlocker).toBeDefined();
      expect(taskBlocker).toContain('no task.assigned events found');
      expect(taskBlocker).not.toContain('no tasks found in workflow state');
    });
  });

  // ─── T10: Unknown event ───────────────────────────────────────────────────

  describe('apply - unrelated events', () => {
    it('Apply_UnknownEvent_ReturnsUnchangedState', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('tool.invoked', {
        tool: 'exarchos_view',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next).toBe(state);
    });
  });
});

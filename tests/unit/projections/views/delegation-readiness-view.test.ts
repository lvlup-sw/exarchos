import { describe, it, expect } from 'vitest';
import {
  delegationReadinessProjection,
  DELEGATION_READINESS_VIEW,
} from '../../../../src/projections/views/delegation-readiness-view.js';
import type { DelegationReadinessState } from '../../../../src/projections/views/delegation-readiness-view.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

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

  describe('init', () => {
    it('Init_ReturnsNotReady_WithEmptyState', () => {
      const state = delegationReadinessProjection.init();

      expect(state.ready).toBe(false);
      expect(state.blockers).toContain('plan not approved');
      expect(state.blockers).toContain('no task.assigned events found — prepare_delegation announces the plan\'s tasks itself; give the workflow a task list (workflow update with tasks) or pass tasks, so there is something to announce');
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
      const state = delegationReadinessProjection.init();

      expect(state.plan.artifactPresent).toBe(false);
      expect(state.blockers).toContain('Plan artifact is missing');
    });
  });

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
      expect(next.blockers).not.toContain('no task.assigned events found — prepare_delegation announces the plan\'s tasks itself; give the workflow a task list (workflow update with tasks) or pass tasks, so there is something to announce');
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

      expect(state.worktrees.expected).toBe(state.worktrees.assignedTaskIds.length);
    });
  });

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

    /** A legacy `worktree.created` event without a `taskId` still increments `ready`, but it adds no entry to `readyTaskIds`. */
    it('Apply_WorktreeCreatedWithoutTaskId_StillIncrementsReadyCount', () => {
      const state = delegationReadinessProjection.init();
      const event = makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
      });

      const next = delegationReadinessProjection.apply(state, event);

      expect(next.worktrees.ready).toBeGreaterThanOrEqual(1);
    });
  });

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

      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview.approved'],
        patch: { 'planReview.approved': true },
      }, 1));
      expect(state.plan.approved).toBe(true);

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

      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview'],
        patch: { planReview: { approved: true } },
      }, 1));
      expect(state.plan.approved).toBe(true);

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

    /**
     * Readiness judges plan presence with `isTypedArtifactReference`, the same check that the workflow guards use.
     * That check trims the string, so a whitespace-only plan is absent for the guards and for readiness.
     */
    it('Apply_StatePatched_WhitespaceOnlyPlan_ReportsArtifactAbsent', () => {
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

  describe('apply - readiness computation', () => {
    /** Readiness needs an approved plan, a plan artifact, an assigned task and the worktree of that task. */
    it('Apply_AllConditionsMet_SetsReadyTrue', () => {
      let state = delegationReadinessProjection.init();

      state = delegationReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'planning',
        to: 'plan-review',
        trigger: 'PLAN_COMPLETE',
        featureId: 'feat-1',
      }, 1));

      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['artifacts.plan'],
        patch: { 'artifacts.plan': 'docs/plans/feat-1.md' },
      }, 2));

      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement feature A',
        worktree: '/tmp/wt-1',
      }, 3));

      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 4));

      expect(state.ready).toBe(true);
      expect(state.blockers).toEqual([]);
    });

    it('Apply_PlanApprovedViaStatePatch_WithTaskAndWorktree_SetsReady', () => {
      let state = delegationReadinessProjection.init();

      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['planReview'],
        patch: { planReview: { approved: true } },
      }, 1));

      state = delegationReadinessProjection.apply(state, makeEvent('state.patched', {
        featureId: 'feat-1',
        fields: ['artifacts.plan'],
        patch: { 'artifacts.plan': 'docs/plans/feat-1.md' },
      }, 2));

      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement feature A',
        worktree: '/tmp/wt-1',
      }, 3));

      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 4));

      expect(state.ready).toBe(true);
      expect(state.blockers).toEqual([]);
    });

    it('Apply_MissingWorktrees_ReportsBlockers', () => {
      let state = delegationReadinessProjection.init();

      state = delegationReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'planning',
        to: 'plan-review',
        trigger: 'PLAN_COMPLETE',
        featureId: 'feat-1',
      }, 1));

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

      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 4));

      expect(state.ready).toBe(false);
      expect(state.blockers).toContain('1 worktrees pending');
    });

    it('Apply_PlanNotApproved_ReportsBlocker', () => {
      let state = delegationReadinessProjection.init();

      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Task 1',
        worktree: '/tmp/wt-1',
      }, 1));

      expect(state.ready).toBe(false);
      expect(state.blockers).toContain('plan not approved');
    });

    /**
     * `ready` must use the same conditions as the blockers.
     * With an approved plan, an assigned task and a worktree but no plan artifact, `ready` must be false.
     */
    it('Apply_PlanArtifactMissing_OtherGatesPass_SetsReadyFalse', () => {
      let state = delegationReadinessProjection.init();

      state = delegationReadinessProjection.apply(state, makeEvent('workflow.transition', {
        from: 'planning',
        to: 'plan-review',
        trigger: 'PLAN_COMPLETE',
        featureId: 'feat-1',
      }, 1));

      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Task 1',
        worktree: '/tmp/wt-1',
      }, 2));

      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 3));

      expect(state.plan.artifactPresent).toBe(false);
      expect(state.blockers).toContain('Plan artifact is missing');
      expect(state.ready).toBe(false);
    });
  });

  describe('blocker message wording', () => {
    it('DelegationReadiness_NoTaskEvents_BlockerMessageReferencesEvents', () => {
      const state = delegationReadinessProjection.init();

      const taskBlocker = state.blockers.find((b) => b.includes('task'));
      expect(taskBlocker).toBeDefined();
      expect(taskBlocker).toContain('no task.assigned events found');
      expect(taskBlocker).not.toContain('no tasks found in workflow state');
    });
  });

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

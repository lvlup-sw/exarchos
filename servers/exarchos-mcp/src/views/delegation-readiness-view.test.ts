import { describe, it, expect } from 'vitest';
import {
  delegationReadinessProjection,
  DELEGATION_READINESS_VIEW,
} from './delegation-readiness-view.js';
import type { DelegationReadinessState } from './delegation-readiness-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

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
      expect(state.blockers).toContain('no tasks assigned');
      expect(state.blockers).toContain('quality signals not queried');
      expect(state.plan).toEqual({ approved: false, taskCount: 0 });
      expect(state.quality).toEqual({
        queried: false,
        gatePassRate: null,
        regressions: [],
      });
      expect(state.worktrees).toEqual({
        expected: 0,
        ready: 0,
        failed: [],
      });
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
      expect(next.blockers).not.toContain('no tasks assigned');
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

  // ─── T7: All conditions met → ready ───────────────────────────────────────

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

      // Assign a task
      state = delegationReadinessProjection.apply(state, makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement feature A',
        worktree: '/tmp/wt-1',
      }, 2));

      // Worktree created
      state = delegationReadinessProjection.apply(state, makeEvent('worktree.created', {
        worktreePath: '/tmp/wt-1',
        taskId: 'task-1',
      }, 3));

      // Quality signal
      state = delegationReadinessProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'plan-coverage',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: {},
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

      // Quality signal
      state = delegationReadinessProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'plan-coverage',
        layer: 'validation',
        passed: true,
        duration: 500,
        details: {},
      }, 5));

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

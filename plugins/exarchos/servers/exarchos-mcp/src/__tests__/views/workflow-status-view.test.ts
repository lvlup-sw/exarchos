import { describe, it, expect, beforeEach } from 'vitest';
import { ViewMaterializer } from '../../views/materializer.js';
import {
  workflowStatusProjection,
  WORKFLOW_STATUS_VIEW,
} from '../../views/workflow-status-view.js';
import type { WorkflowStatusViewState } from '../../views/workflow-status-view.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

function makeEvent(
  seq: number,
  type: string,
  data?: Record<string, unknown>,
  streamId = 'wf-001',
): WorkflowEvent {
  return {
    streamId,
    sequence: seq,
    timestamp: new Date().toISOString(),
    type,
    schemaVersion: '1.0',
    data,
  };
}

describe('WorkflowStatusView', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
    materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
  });

  describe('WorkflowStarted_InitializesPhase', () => {
    it('should initialize view with featureId, phase, and startedAt from WorkflowStarted event', () => {
      const events = [
        makeEvent(1, 'workflow.started', {
          featureId: 'auth-feature',
          workflowType: 'feature',
        }),
      ];

      const view = materializer.materialize<WorkflowStatusViewState>(
        'wf-001',
        WORKFLOW_STATUS_VIEW,
        events,
      );

      expect(view.featureId).toBe('auth-feature');
      expect(view.workflowType).toBe('feature');
      expect(view.phase).toBe('started');
      expect(view.startedAt).toBeDefined();
      expect(view.tasksTotal).toBe(0);
      expect(view.tasksCompleted).toBe(0);
    });
  });

  describe('TasksCompleted_UpdatesCounts', () => {
    it('should count total assigned and completed tasks', () => {
      const events = [
        makeEvent(1, 'workflow.started', { featureId: 'f1', workflowType: 'feature' }),
        makeEvent(2, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
        makeEvent(3, 'task.assigned', { taskId: 't2', title: 'Task 2' }),
        makeEvent(4, 'task.assigned', { taskId: 't3', title: 'Task 3' }),
        makeEvent(5, 'task.assigned', { taskId: 't4', title: 'Task 4' }),
        makeEvent(6, 'task.assigned', { taskId: 't5', title: 'Task 5' }),
        makeEvent(7, 'task.completed', { taskId: 't1' }),
        makeEvent(8, 'task.completed', { taskId: 't2' }),
        makeEvent(9, 'task.completed', { taskId: 't3' }),
      ];

      const view = materializer.materialize<WorkflowStatusViewState>(
        'wf-001',
        WORKFLOW_STATUS_VIEW,
        events,
      );

      expect(view.tasksTotal).toBe(5);
      expect(view.tasksCompleted).toBe(3);
    });
  });

  describe('PhaseTransitioned_UpdatesPhase', () => {
    it('should update current phase when phase.transitioned event is processed', () => {
      const events = [
        makeEvent(1, 'workflow.started', { featureId: 'f1', workflowType: 'feature' }),
        makeEvent(2, 'phase.transitioned', { from: 'started', to: 'planning' }),
        makeEvent(3, 'phase.transitioned', { from: 'planning', to: 'delegating' }),
      ];

      const view = materializer.materialize<WorkflowStatusViewState>(
        'wf-001',
        WORKFLOW_STATUS_VIEW,
        events,
      );

      expect(view.phase).toBe('delegating');
    });
  });

  describe('TaskFailed_IncrementsFailedCount', () => {
    it('should count failed tasks separately', () => {
      const events = [
        makeEvent(1, 'workflow.started', { featureId: 'f1', workflowType: 'feature' }),
        makeEvent(2, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
        makeEvent(3, 'task.assigned', { taskId: 't2', title: 'Task 2' }),
        makeEvent(4, 'task.failed', { taskId: 't1', error: 'build error' }),
        makeEvent(5, 'task.completed', { taskId: 't2' }),
      ];

      const view = materializer.materialize<WorkflowStatusViewState>(
        'wf-001',
        WORKFLOW_STATUS_VIEW,
        events,
      );

      expect(view.tasksTotal).toBe(2);
      expect(view.tasksCompleted).toBe(1);
      expect(view.tasksFailed).toBe(1);
    });
  });

  describe('WorkflowTransition_ExtractsFeatureId', () => {
    it('should extract featureId from workflow.transition when no workflow.started exists', () => {
      const events = [
        makeEvent(1, 'workflow.transition', {
          from: 'ideate',
          to: 'plan',
          trigger: 'plan',
          featureId: 'feat-from-transition',
        }),
        makeEvent(2, 'task.assigned', { taskId: 't1', title: 'Task 1' }),
      ];

      const view = materializer.materialize<WorkflowStatusViewState>(
        'wf-003',
        WORKFLOW_STATUS_VIEW,
        events,
      );

      expect(view.featureId).toBe('feat-from-transition');
      expect(view.phase).toBe('plan');
      expect(view.tasksTotal).toBe(1);
    });

    it('should not overwrite featureId from workflow.started with workflow.transition', () => {
      const events = [
        makeEvent(1, 'workflow.started', { featureId: 'from-started', workflowType: 'feature' }),
        makeEvent(2, 'workflow.transition', {
          from: 'ideate',
          to: 'plan',
          trigger: 'plan',
          featureId: 'from-transition',
        }),
      ];

      const view = materializer.materialize<WorkflowStatusViewState>(
        'wf-004',
        WORKFLOW_STATUS_VIEW,
        events,
      );

      expect(view.featureId).toBe('from-started');
      expect(view.workflowType).toBe('feature');
      expect(view.phase).toBe('plan');
    });
  });

  describe('DefaultView', () => {
    it('should return sensible defaults when no events exist', () => {
      const view = materializer.materialize<WorkflowStatusViewState>(
        'empty',
        WORKFLOW_STATUS_VIEW,
        [],
      );

      expect(view.featureId).toBe('');
      expect(view.workflowType).toBe('');
      expect(view.phase).toBe('');
      expect(view.tasksTotal).toBe(0);
      expect(view.tasksCompleted).toBe(0);
      expect(view.tasksFailed).toBe(0);
    });
  });
});

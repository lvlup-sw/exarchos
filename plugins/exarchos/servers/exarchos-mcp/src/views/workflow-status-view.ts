import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const WORKFLOW_STATUS_VIEW = 'workflow-status';

// ─── View State ────────────────────────────────────────────────────────────

export interface WorkflowStatusViewState {
  featureId: string;
  workflowType: string;
  phase: string;
  startedAt: string;
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
}

// ─── Projection ────────────────────────────────────────────────────────────

export const workflowStatusProjection: ViewProjection<WorkflowStatusViewState> = {
  init: () => ({
    featureId: '',
    workflowType: '',
    phase: '',
    startedAt: '',
    tasksTotal: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
  }),

  apply: (view, event) => {
    switch (event.type) {
      case 'workflow.started': {
        const data = event.data as { featureId?: string; workflowType?: string } | undefined;
        return {
          ...view,
          featureId: data?.featureId ?? view.featureId,
          workflowType: data?.workflowType ?? view.workflowType,
          phase: 'started',
          startedAt: event.timestamp,
        };
      }

      case 'phase.transitioned': {
        const data = event.data as { to?: string } | undefined;
        return {
          ...view,
          phase: data?.to ?? view.phase,
        };
      }

      case 'task.assigned':
        return {
          ...view,
          tasksTotal: view.tasksTotal + 1,
        };

      case 'task.completed':
        return {
          ...view,
          tasksCompleted: view.tasksCompleted + 1,
        };

      case 'task.failed':
        return {
          ...view,
          tasksFailed: view.tasksFailed + 1,
        };

      default:
        return view;
    }
  },
};

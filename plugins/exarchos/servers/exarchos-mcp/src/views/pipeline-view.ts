import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const PIPELINE_VIEW = 'pipeline';

// ─── Stack Position ────────────────────────────────────────────────────────

export interface StackPosition {
  position: number;
  taskId: string;
  branch?: string;
  prUrl?: string;
}

// ─── View State ────────────────────────────────────────────────────────────

export interface PipelineViewState {
  featureId: string;
  workflowType: string;
  phase: string;
  taskCount: number;
  completedCount: number;
  failedCount: number;
  stackPositions: StackPosition[];
}

// ─── Projection ────────────────────────────────────────────────────────────

export const pipelineProjection: ViewProjection<PipelineViewState> = {
  init: () => ({
    featureId: '',
    workflowType: '',
    phase: '',
    taskCount: 0,
    completedCount: 0,
    failedCount: 0,
    stackPositions: [],
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
          taskCount: view.taskCount + 1,
        };

      case 'task.completed':
        return {
          ...view,
          completedCount: view.completedCount + 1,
        };

      case 'task.failed':
        return {
          ...view,
          failedCount: view.failedCount + 1,
        };

      case 'stack.position-filled': {
        const data = event.data as {
          position?: number;
          taskId?: string;
          branch?: string;
          prUrl?: string;
        } | undefined;
        if (data?.position === undefined || !data?.taskId) return view;
        return {
          ...view,
          stackPositions: [
            ...view.stackPositions,
            {
              position: data.position,
              taskId: data.taskId,
              branch: data.branch,
              prUrl: data.prUrl,
            },
          ],
        };
      }

      default:
        return view;
    }
  },
};

import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const PIPELINE_VIEW = 'pipeline';

// ─── Bounds ─────────────────────────────────────────────────────────────────

export const MAX_STACK_POSITIONS = 100;

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
  hasMore: boolean;
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
    hasMore: false,
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

      case 'workflow.transition': {
        const data = event.data as {
          featureId?: string;
          from?: string;
          to?: string;
        } | undefined;
        return {
          ...view,
          // Only set featureId if not already populated by workflow.started
          featureId: view.featureId || data?.featureId || view.featureId,
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
        const newPositions = [
          ...view.stackPositions,
          {
            position: data.position,
            taskId: data.taskId,
            branch: data.branch,
            prUrl: data.prUrl,
          },
        ];
        const evicted = newPositions.length > MAX_STACK_POSITIONS;
        const boundedPositions = evicted
          ? newPositions.slice(newPositions.length - MAX_STACK_POSITIONS)
          : newPositions;

        return {
          ...view,
          stackPositions: boundedPositions,
          hasMore: view.hasMore || evicted,
        };
      }

      default:
        return view;
    }
  },
};

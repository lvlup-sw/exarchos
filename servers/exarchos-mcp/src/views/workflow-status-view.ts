import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const WORKFLOW_STATUS_VIEW = 'workflow-status';

// ─── View State ────────────────────────────────────────────────────────────

/**
 * Public view shape returned to callers.
 *
 * The `_seenAssignedTaskIds` / `_seenCompletedTaskIds` arrays are projection
 * bookkeeping for taskId dedup (#1226). They are arrays (not `Set`s) so that
 * snapshot serialization through `JSON.stringify` round-trips losslessly. The
 * leading underscore signals that callers should not inspect them.
 */
export interface WorkflowStatusViewState {
  featureId: string;
  workflowType: string;
  phase: string;
  startedAt: string;
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  /** Internal: taskIds already counted toward tasksTotal. */
  _seenAssignedTaskIds: string[];
  /** Internal: taskIds already counted toward tasksCompleted. */
  _seenCompletedTaskIds: string[];
}

// ─── Projection ────────────────────────────────────────────────────────────

/** Pull a string `taskId` from `event.data` if present, else undefined. */
function extractTaskId(event: WorkflowEvent): string | undefined {
  const data = event.data as { taskId?: unknown } | undefined;
  if (!data) return undefined;
  return typeof data.taskId === 'string' ? data.taskId : undefined;
}

export const workflowStatusProjection: ViewProjection<WorkflowStatusViewState> = {
  init: () => ({
    featureId: '',
    workflowType: '',
    phase: '',
    startedAt: '',
    tasksTotal: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    _seenAssignedTaskIds: [],
    _seenCompletedTaskIds: [],
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

      case 'task.assigned': {
        const taskId = extractTaskId(event);
        // Missing taskId: legacy/malformed event — count it (preserves
        // pre-dedup behavior for events that can't be deduped).
        if (taskId === undefined) {
          return { ...view, tasksTotal: view.tasksTotal + 1 };
        }
        if (view._seenAssignedTaskIds.includes(taskId)) {
          return view;
        }
        return {
          ...view,
          tasksTotal: view.tasksTotal + 1,
          _seenAssignedTaskIds: [...view._seenAssignedTaskIds, taskId],
        };
      }

      case 'task.completed': {
        const taskId = extractTaskId(event);
        if (taskId === undefined) {
          return { ...view, tasksCompleted: view.tasksCompleted + 1 };
        }
        if (view._seenCompletedTaskIds.includes(taskId)) {
          return view;
        }
        return {
          ...view,
          tasksCompleted: view.tasksCompleted + 1,
          _seenCompletedTaskIds: [...view._seenCompletedTaskIds, taskId],
        };
      }

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

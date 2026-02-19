import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const UNIFIED_TASK_VIEW = 'unified-task';

// ─── Unified Task Entry ────────────────────────────────────────────────────

export interface UnifiedTask {
  readonly taskId: string;
  readonly title: string;
  readonly streamId: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly assignee?: string;
  readonly status: 'assigned' | 'claimed' | 'in-progress' | 'completed' | 'failed';
  readonly tddPhase?: string;
  readonly error?: string;
}

// ─── View State ────────────────────────────────────────────────────────────

export interface UnifiedTaskViewState {
  readonly tasks: readonly UnifiedTask[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function findTaskIndex(tasks: readonly UnifiedTask[], taskId: string): number {
  return tasks.findIndex((t) => t.taskId === taskId);
}

function updateTask(
  tasks: readonly UnifiedTask[],
  taskId: string,
  updater: (task: UnifiedTask) => UnifiedTask,
): UnifiedTask[] {
  const idx = findTaskIndex(tasks, taskId);
  if (idx === -1) return [...tasks];
  const updated = [...tasks];
  updated[idx] = updater(updated[idx]);
  return updated;
}

// ─── Projection ────────────────────────────────────────────────────────────

export const unifiedTaskProjection: ViewProjection<UnifiedTaskViewState> = {
  init: () => ({ tasks: [] }),

  apply: (view, event) => {
    switch (event.type) {
      case 'task.assigned': {
        const data = event.data as {
          taskId?: string;
          title?: string;
          branch?: string;
          worktree?: string;
          assignee?: string;
        } | undefined;
        if (!data?.taskId) return view;
        return {
          tasks: [
            ...view.tasks,
            {
              taskId: data.taskId,
              title: data.title ?? '',
              streamId: event.streamId,
              branch: data.branch,
              worktree: data.worktree,
              assignee: data.assignee,
              status: 'assigned',
            },
          ],
        };
      }

      case 'task.claimed': {
        const data = event.data as { taskId?: string; agentId?: string } | undefined;
        if (!data?.taskId) return view;
        return {
          tasks: updateTask(view.tasks, data.taskId, (task) => ({
            ...task,
            status: 'claimed',
            assignee: data.agentId ?? task.assignee,
          })),
        };
      }

      case 'task.progressed': {
        const data = event.data as { taskId?: string; tddPhase?: string } | undefined;
        if (!data?.taskId) return view;
        return {
          tasks: updateTask(view.tasks, data.taskId, (task) => ({
            ...task,
            status: 'in-progress',
            tddPhase: data.tddPhase,
          })),
        };
      }

      case 'task.completed': {
        const data = event.data as { taskId?: string } | undefined;
        if (!data?.taskId) return view;
        return {
          tasks: updateTask(view.tasks, data.taskId, (task) => ({
            ...task,
            status: 'completed',
          })),
        };
      }

      case 'task.failed': {
        const data = event.data as { taskId?: string; error?: string } | undefined;
        if (!data?.taskId) return view;
        return {
          tasks: updateTask(view.tasks, data.taskId, (task) => ({
            ...task,
            status: 'failed',
            error: data.error,
          })),
        };
      }

      default:
        return view;
    }
  },
};

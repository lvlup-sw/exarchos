import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const TASK_DETAIL_VIEW = 'task-detail';

// ─── Task Detail ───────────────────────────────────────────────────────────

export interface TaskDetail {
  taskId: string;
  title: string;
  branch?: string;
  worktree?: string;
  assignee?: string;
  status: 'assigned' | 'claimed' | 'in-progress' | 'completed' | 'failed';
  tddPhase?: string;
  artifacts?: string[];
  duration?: number;
  error?: string;
}

// ─── View State ────────────────────────────────────────────────────────────

export interface TaskDetailViewState {
  tasks: Record<string, TaskDetail>;
}

// ─── Projection ────────────────────────────────────────────────────────────

export const taskDetailProjection: ViewProjection<TaskDetailViewState> = {
  init: () => ({ tasks: {} }),

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
          tasks: {
            ...view.tasks,
            [data.taskId]: {
              taskId: data.taskId,
              title: data.title ?? '',
              branch: data.branch,
              worktree: data.worktree,
              assignee: data.assignee,
              status: 'assigned',
            },
          },
        };
      }

      case 'task.claimed': {
        const data = event.data as { taskId?: string; agentId?: string } | undefined;
        if (!data?.taskId || !view.tasks[data.taskId]) return view;
        return {
          tasks: {
            ...view.tasks,
            [data.taskId]: {
              ...view.tasks[data.taskId],
              status: 'claimed',
              assignee: data.agentId ?? view.tasks[data.taskId].assignee,
            },
          },
        };
      }

      case 'task.progressed': {
        const data = event.data as { taskId?: string; tddPhase?: string } | undefined;
        if (!data?.taskId || !view.tasks[data.taskId]) return view;
        return {
          tasks: {
            ...view.tasks,
            [data.taskId]: {
              ...view.tasks[data.taskId],
              status: 'in-progress',
              tddPhase: data.tddPhase,
            },
          },
        };
      }

      case 'task.completed': {
        const data = event.data as { taskId?: string; artifacts?: string[]; duration?: number } | undefined;
        if (!data?.taskId || !view.tasks[data.taskId]) return view;
        return {
          tasks: {
            ...view.tasks,
            [data.taskId]: {
              ...view.tasks[data.taskId],
              status: 'completed',
              artifacts: data.artifacts,
              duration: data.duration,
            },
          },
        };
      }

      case 'task.failed': {
        const data = event.data as { taskId?: string; error?: string } | undefined;
        if (!data?.taskId || !view.tasks[data.taskId]) return view;
        return {
          tasks: {
            ...view.tasks,
            [data.taskId]: {
              ...view.tasks[data.taskId],
              status: 'failed',
              error: data.error,
            },
          },
        };
      }

      default:
        return view;
    }
  },
};

import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const DELEGATION_TIMELINE_VIEW = 'delegation-timeline';

// ─── Bounds ─────────────────────────────────────────────────────────────────

export const MAX_TIMELINE_TASKS = 200;

// ─── View State ────────────────────────────────────────────────────────────

export interface TimelineTask {
  taskId: string;
  teammateName: string;
  status: 'assigned' | 'completed' | 'failed';
  assignedAt: string;
  completedAt: string | null;
  durationMs: number;
}

export interface Bottleneck {
  taskId: string;
  durationMs: number;
  reason: string;
}

export interface DelegationTimelineViewState {
  teamSpawnedAt: string | null;
  teamDisbandedAt: string | null;
  totalDurationMs: number;
  tasks: TimelineTask[];
  bottleneck: Bottleneck | null;
  hasMore: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Find the task with the longest duration among completed tasks. */
function findBottleneck(tasks: TimelineTask[]): Bottleneck | null {
  const completedTasks = tasks.filter(
    (t) => t.status === 'completed' && t.durationMs > 0,
  );
  if (completedTasks.length === 0) return null;

  let longest = completedTasks[0];
  for (const task of completedTasks) {
    if (task.durationMs > longest.durationMs) {
      longest = task;
    }
  }

  return {
    taskId: longest.taskId,
    durationMs: longest.durationMs,
    reason: 'longest_task',
  };
}

// ─── Projection ────────────────────────────────────────────────────────────

export const delegationTimelineProjection: ViewProjection<DelegationTimelineViewState> = {
  init: () => ({
    teamSpawnedAt: null,
    teamDisbandedAt: null,
    totalDurationMs: 0,
    tasks: [],
    bottleneck: null,
    hasMore: false,
  }),

  apply: (view, event) => {
    switch (event.type) {
      case 'team.spawned': {
        return {
          ...view,
          teamSpawnedAt: event.timestamp,
        };
      }

      case 'team.task.assigned': {
        const data = event.data as {
          taskId?: string;
          teammateName?: string;
        } | undefined;

        const taskId = data?.taskId;
        const teammateName = data?.teammateName;
        if (!taskId || !teammateName) return view;

        const task: TimelineTask = {
          taskId,
          teammateName,
          status: 'assigned',
          assignedAt: event.timestamp,
          completedAt: null,
          durationMs: 0,
        };

        const newTasks = [...view.tasks, task];
        const evicted = newTasks.length > MAX_TIMELINE_TASKS;
        const boundedTasks = evicted
          ? newTasks.slice(newTasks.length - MAX_TIMELINE_TASKS)
          : newTasks;

        return {
          ...view,
          tasks: boundedTasks,
          hasMore: view.hasMore || evicted,
        };
      }

      case 'team.task.completed': {
        const data = event.data as {
          taskId?: string;
          durationMs?: number;
        } | undefined;

        const taskId = data?.taskId;
        if (!taskId) return view;

        const durationMs = data?.durationMs ?? 0;
        const updatedTasks = view.tasks.map((t) =>
          t.taskId === taskId
            ? { ...t, status: 'completed' as const, completedAt: event.timestamp, durationMs }
            : t,
        );

        return {
          ...view,
          tasks: updatedTasks,
          bottleneck: findBottleneck(updatedTasks),
        };
      }

      case 'team.task.failed': {
        const data = event.data as { taskId?: string } | undefined;
        const taskId = data?.taskId;
        if (!taskId) return view;

        const updatedTasks = view.tasks.map((t) =>
          t.taskId === taskId
            ? { ...t, status: 'failed' as const, completedAt: event.timestamp }
            : t,
        );

        return {
          ...view,
          tasks: updatedTasks,
        };
      }

      case 'team.disbanded': {
        const data = event.data as { totalDurationMs?: number } | undefined;

        return {
          ...view,
          teamDisbandedAt: event.timestamp,
          totalDurationMs: data?.totalDurationMs ?? 0,
        };
      }

      default:
        return view;
    }
  },
};

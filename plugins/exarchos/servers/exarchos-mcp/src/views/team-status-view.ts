import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const TEAM_STATUS_VIEW = 'team-status';

// ─── View State ────────────────────────────────────────────────────────────

export interface Teammate {
  name: string;
  role: string;
  model?: string;
}

export interface TeamStatusViewState {
  teammates: Teammate[];
  /** Maps agentId to their currently claimed taskId. */
  currentTasks: Record<string, string>;
}

// ─── Projection ────────────────────────────────────────────────────────────

export const teamStatusProjection: ViewProjection<TeamStatusViewState> = {
  init: () => ({
    teammates: [],
    currentTasks: {},
  }),

  apply: (view, event) => {
    switch (event.type) {
      case 'team.formed': {
        const data = event.data as { teammates?: Array<{ name: string; role: string; model?: string }> } | undefined;
        return {
          ...view,
          teammates: data?.teammates?.map((t) => ({
            name: t.name,
            role: t.role,
            model: t.model,
          })) ?? [],
        };
      }

      case 'task.claimed': {
        const data = event.data as { taskId?: string; agentId?: string } | undefined;
        if (!data?.taskId || !data?.agentId) return view;
        return {
          ...view,
          currentTasks: {
            ...view.currentTasks,
            [data.agentId]: data.taskId,
          },
        };
      }

      case 'task.completed':
      case 'task.failed': {
        const data = event.data as { taskId?: string } | undefined;
        if (!data?.taskId) return view;

        // Find the agent that had this task and remove the mapping
        const updatedTasks = { ...view.currentTasks };
        for (const [agentId, taskId] of Object.entries(updatedTasks)) {
          if (taskId === data.taskId) {
            delete updatedTasks[agentId];
          }
        }
        return {
          ...view,
          currentTasks: updatedTasks,
        };
      }

      default:
        return view;
    }
  },
};

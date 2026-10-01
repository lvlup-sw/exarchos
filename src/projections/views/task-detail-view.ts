/**
 * TaskDetail view over `task-store@v1`.
 *
 * Each fold step calls `taskStoreReducer.apply`, so the view and the canonical reducer cannot
 * drift. The public `TaskDetail` type stays a stable shape for consumers.
 */
import type { ViewProjection } from './materializer.js';
import { taskStoreReducer } from '../taskstore/reducer.js';
import type {
  TaskRecord,
  TaskStatus,
  TaskStoreState,
} from '../taskstore/types.js';

export const TASK_DETAIL_VIEW = 'task-detail';

/**
 * Public view shape of one task. It mirrors `TaskRecord`, and stays a separate type, so a
 * view-only field does not widen the reducer state.
 */
export interface TaskDetail {
  taskId: string;
  title: string;
  branch?: string | undefined;
  worktree?: string | undefined;
  assignee?: string | undefined;
  status: 'pending' | 'assigned' | 'claimed' | 'in-progress' | 'completed' | 'failed';
  tddPhase?: string | undefined;
  artifacts?: string[] | undefined;
  duration?: number | undefined;
  error?: string | undefined;
}

/** The view state: the tasks in the public `TaskDetail` shape. It is plain JSON, so a snapshot round-trips. */
export interface TaskDetailViewState {
  tasks: Record<string, TaskDetail>;
}

/**
 * Map a canonical `TaskRecord` to the public `TaskDetail` shape. A missing `title` becomes an empty
 * string, which the CLI and MCP consumers expect. `assignee` takes `agentId` first, and `artifacts`
 * becomes a mutable copy. The other `TaskRecord` fields, such as `claimedAt` and `detail`, are dropped.
 */
function toTaskDetail(record: TaskRecord): TaskDetail {
  return {
    taskId: record.taskId,
    title: record.title ?? '',
    branch: record.branch,
    worktree: record.worktree,
    assignee: record.agentId ?? record.assignee,
    status: record.status as Exclude<TaskStatus, never>,
    tddPhase: record.tddPhase,
    artifacts: record.artifacts ? [...record.artifacts] : undefined,
    duration: record.duration,
    error: record.error,
  };
}

export const taskDetailProjection: ViewProjection<TaskDetailViewState> = {
  init: () => ({ tasks: {} }),

  /**
   * Fold one event through the canonical `task-store@v1` reducer. Each step rebuilds a minimal
   * `TaskStoreState` from the view tasks, with `projectionSequence` at 0. Both sides fold one
   * stream, which the reducer needs, because a task key is unique only within a stream. When the
   * reducer returns its input, the view also returns its input, so change detection sees no change.
   */
  apply: (view, event) => {
    const priorTaskStore: TaskStoreState = {
      projectionSequence: 0,
      tasks: viewTasksToProjectionTasks(view.tasks),
    };

    const nextTaskStore = taskStoreReducer.apply(priorTaskStore, event);
    if (nextTaskStore === priorTaskStore) {
      return view;
    }

    const tasks: Record<string, TaskDetail> = {};
    for (const [taskId, record] of Object.entries(nextTaskStore.tasks)) {
      tasks[taskId] = toTaskDetail(record);
    }
    return { tasks };
  },
};

/**
 * Inverse of {@link toTaskDetail}: rebuild `TaskRecord` entries from the view tasks, so the reducer
 * can fold over the prior view state. An empty `title` becomes absent, because the reducer sets
 * `title` only when present. A field that `TaskDetail` does not hold, such as `claimedAt`, does
 * not come back.
 */
function viewTasksToProjectionTasks(
  tasks: Record<string, TaskDetail>,
): Record<string, TaskRecord> {
  const out: Record<string, TaskRecord> = {};
  for (const [taskId, detail] of Object.entries(tasks)) {
    const record: TaskRecord = {
      taskId: detail.taskId,
      status: detail.status as TaskStatus,
      ...(detail.title !== '' && detail.title !== undefined
        ? { title: detail.title }
        : {}),
      ...(detail.branch !== undefined ? { branch: detail.branch } : {}),
      ...(detail.worktree !== undefined ? { worktree: detail.worktree } : {}),
      ...(detail.assignee !== undefined ? { assignee: detail.assignee } : {}),
      ...(detail.tddPhase !== undefined
        ? { tddPhase: detail.tddPhase as TaskRecord['tddPhase'] }
        : {}),
      ...(detail.artifacts !== undefined ? { artifacts: detail.artifacts } : {}),
      ...(detail.duration !== undefined ? { duration: detail.duration } : {}),
      ...(detail.error !== undefined ? { error: detail.error } : {}),
    };
    out[taskId] = record;
  }
  return out;
}

import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { taskStoreReducer } from '../taskstore/reducer.js';
import type {
  TaskRecord,
  TaskStoreState,
} from '../taskstore/types.js';

export const WORKFLOW_STATUS_VIEW = 'workflow-status';

/**
 * Internal projection state. The `workflow_status` handler strips the `_seen*` fields
 * and `_taskStore` from the response, and it restores `_taskStore` under `detail: true`.
 *
 * The task counts come from `_taskStore`, a fold of the `task-store@v1` reducer. That
 * reducer upserts on `taskId`, so a repeated event does not count twice. Its scope is
 * `'stream'`, the same as this view, because a task id is unique only in one feature.
 */
export interface WorkflowStatusViewState {
  featureId: string;
  workflowType: string;
  phase: string;
  startedAt: string;
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  /** Legacy field. Only the rebuild of `_taskStore` from an old snapshot reads it. */
  _seenAssignedTaskIds: Record<string, true>;
  /** Legacy field. Only the rebuild of `_taskStore` from an old snapshot reads it. */
  _seenCompletedTaskIds: Record<string, true>;
  /** The `task-store@v1` state of this stream. The task counts come from it. */
  _taskStore: TaskStoreState;
}

const TASK_EVENT_TYPES = new Set([
  'task.assigned',
  'task.claimed',
  'task.progressed',
  'task.completed',
  'task.failed',
]);

/** Counts the records in `tasks` that have the given `status`. */
function countByStatus(
  tasks: Readonly<Record<string, TaskRecord>>,
  status: TaskRecord['status'],
): number {
  let n = 0;
  for (const record of Object.values(tasks)) {
    if (record.status === status) n += 1;
  }
  return n;
}

/** Sets the three task counts from `_taskStore`. */
function deriveCountsFromTaskStore(
  view: WorkflowStatusViewState,
): WorkflowStatusViewState {
  return {
    ...view,
    tasksTotal: Object.keys(view._taskStore.tasks).length,
    tasksCompleted: countByStatus(view._taskStore.tasks, 'completed'),
    tasksFailed: countByStatus(view._taskStore.tasks, 'failed'),
  };
}

/**
 * The id prefix of the placeholder failed tasks. An old snapshot holds only the failed
 * count, so the rebuild adds one placeholder for each failed task. The prefix marks
 * the legacy origin of a placeholder.
 */
const LEGACY_FAILED_PLACEHOLDER_PREFIX = '__legacy-failed-';

/**
 * Rebuilds `_taskStore` from an old snapshot that has none. Each id in
 * `_seenAssignedTaskIds` becomes `assigned`, or `completed` when `_seenCompletedTaskIds`
 * holds it. The `tasksFailed` count becomes that many placeholder `failed` records.
 *
 * An old snapshot has no failed ids, so a task that failed before the snapshot stays
 * `assigned`. The placeholders keep the failed count correct.
 */
function reconstructTaskStoreFromLegacy(
  view: WorkflowStatusViewState,
): TaskStoreState {
  const tasks: Record<string, TaskRecord> = {};
  for (const taskId of Object.keys(view._seenAssignedTaskIds ?? {})) {
    const status = view._seenCompletedTaskIds?.[taskId] ? 'completed' : 'assigned';
    tasks[taskId] = { taskId, status };
  }
  for (let i = 0; i < view.tasksFailed; i += 1) {
    const placeholderId = `${LEGACY_FAILED_PLACEHOLDER_PREFIX}${i}`;
    if (!(placeholderId in tasks)) {
      tasks[placeholderId] = { taskId: placeholderId, status: 'failed' };
    }
  }
  return { projectionSequence: 0, tasks };
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
    _seenAssignedTaskIds: {},
    _seenCompletedTaskIds: {},
    _taskStore: { ...taskStoreReducer.initial },
  }),

  /**
   * Sends a `task.*` event to the `task-store@v1` reducer, then derives the counts again.
   * When the reducer ignores an assigned, completed, or failed event because it has no
   * `taskId`, the switch increments the matching count. The next derive replaces that count.
   * `workflow.transition` sets `featureId` only when it is empty.
   */
  apply: (view, event: WorkflowEvent) => {
    if (TASK_EVENT_TYPES.has(event.type)) {
      const currentTaskStore = view._taskStore ?? reconstructTaskStoreFromLegacy(view);
      const nextTaskStore = taskStoreReducer.apply(currentTaskStore, event);
      if (nextTaskStore === currentTaskStore) {
      } else {
        return deriveCountsFromTaskStore({ ...view, _taskStore: nextTaskStore });
      }
    }

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
          featureId: view.featureId || data?.featureId || view.featureId,
          phase: data?.to ?? view.phase,
        };
      }

      case 'task.assigned': {
        return { ...view, tasksTotal: view.tasksTotal + 1 };
      }

      case 'task.completed': {
        return { ...view, tasksCompleted: view.tasksCompleted + 1 };
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

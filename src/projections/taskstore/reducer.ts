/**
 * The `task-store@v1` projection reducer. It folds the `task.*` events of one workflow stream into
 * task records keyed by `taskId`. `types.ts` holds the state shape.
 *
 * The scope must stay `stream`. A `taskId` is a per-feature ordinal such as `'001'`, and `TaskRecord`
 * holds no `featureId`. Thus a fold over several streams merges the tasks of different features.
 *
 * It handles `task.assigned`, `task.claimed`, `task.progressed`, `task.completed`, and `task.failed`.
 * Each sets the status of the same name, but `task.progressed` sets `'in-progress'`. `apply` is pure
 * and does not mutate its inputs. Any other event, or an event with no `taskId`, returns `state` by
 * identity, so `projectionSequence` counts only the handled events.
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import type { TaskRecord, TaskStoreState, TaskStatus } from './types.js';
import {
  extractTaskId,
  extractString,
  extractNumber,
  extractStringArray,
} from '../shared/event-data-extractors.js';

type TaskOverlay = { -readonly [K in keyof Omit<TaskRecord, 'taskId'>]?: TaskRecord[K] } & { status: TaskStatus };

const initialTaskStoreState: TaskStoreState = {
  projectionSequence: 0,
  tasks: {},
};

/**
 * Narrows `tddPhase` from event data to `'red' | 'green' | 'refactor'`, or `undefined` for any other value.
 * It stays local because it narrows to a `TaskRecord` type. The generic extractors are in `../shared/`.
 */
function extractTddPhase(
  data: WorkflowEvent['data'],
): TaskRecord['tddPhase'] | undefined {
  const raw = extractString(data, 'tddPhase');
  if (raw === 'red' || raw === 'green' || raw === 'refactor') return raw;
  return undefined;
}

/**
 * Returns a new state with one task upserted and `projectionSequence` incremented.
 * The overlay sets the status and each field that it holds. Other fields keep their prior values.
 */
function upsertTask(
  state: TaskStoreState,
  taskId: string,
  overlay: TaskOverlay,
): TaskStoreState {
  const prior = state.tasks[taskId];
  const next: TaskRecord = {
    ...(prior ?? { taskId }),
    ...overlay,
    taskId,
  };
  return {
    projectionSequence: state.projectionSequence + 1,
    tasks: { ...state.tasks, [taskId]: next },
  };
}

function applyTaskAssigned(
  state: TaskStoreState,
  event: WorkflowEvent,
): TaskStoreState {
  const taskId = extractTaskId(event.data);
  if (!taskId) return state;
  const overlay: TaskOverlay = {
    status: 'assigned',
  };
  const title = extractString(event.data, 'title');
  const branch = extractString(event.data, 'branch');
  const worktree = extractString(event.data, 'worktree');
  const assignee = extractString(event.data, 'assignee');
  if (title !== undefined) overlay.title = title;
  if (branch !== undefined) overlay.branch = branch;
  if (worktree !== undefined) overlay.worktree = worktree;
  if (assignee !== undefined) overlay.assignee = assignee;
  return upsertTask(state, taskId, overlay);
}

function applyTaskClaimed(
  state: TaskStoreState,
  event: WorkflowEvent,
): TaskStoreState {
  const taskId = extractTaskId(event.data);
  if (!taskId) return state;
  const overlay: TaskOverlay = {
    status: 'claimed',
  };
  const agentId = extractString(event.data, 'agentId');
  const claimedAt = extractString(event.data, 'claimedAt');
  if (agentId !== undefined) overlay.agentId = agentId;
  if (claimedAt !== undefined) overlay.claimedAt = claimedAt;
  return upsertTask(state, taskId, overlay);
}

function applyTaskProgressed(
  state: TaskStoreState,
  event: WorkflowEvent,
): TaskStoreState {
  const taskId = extractTaskId(event.data);
  if (!taskId) return state;
  const overlay: TaskOverlay = {
    status: 'in-progress',
  };
  const tddPhase = extractTddPhase(event.data);
  const detail = extractString(event.data, 'detail');
  if (tddPhase !== undefined) overlay.tddPhase = tddPhase;
  if (detail !== undefined) overlay.detail = detail;
  return upsertTask(state, taskId, overlay);
}

function applyTaskCompleted(
  state: TaskStoreState,
  event: WorkflowEvent,
): TaskStoreState {
  const taskId = extractTaskId(event.data);
  if (!taskId) return state;
  const overlay: TaskOverlay = {
    status: 'completed',
  };
  const artifacts = extractStringArray(event.data, 'artifacts');
  const duration = extractNumber(event.data, 'duration');
  if (artifacts !== undefined) overlay.artifacts = artifacts;
  if (duration !== undefined) overlay.duration = duration;
  return upsertTask(state, taskId, overlay);
}

function applyTaskFailed(
  state: TaskStoreState,
  event: WorkflowEvent,
): TaskStoreState {
  const taskId = extractTaskId(event.data);
  if (!taskId) return state;
  const overlay: TaskOverlay = {
    status: 'failed',
  };
  const error = extractString(event.data, 'error');
  if (error !== undefined) overlay.error = error;
  return upsertTask(state, taskId, overlay);
}

export const taskStoreReducer: ProjectionReducer<TaskStoreState, WorkflowEvent> = {
  id: 'task-store@v1',
  version: 1,
  /** Must stay `stream`, because the task key space is per feature. `projections/types.ts` states the rule. */
  scope: 'stream',
  initial: initialTaskStoreState,
  apply(state: TaskStoreState, event: WorkflowEvent): TaskStoreState {
    switch (event.type) {
      case 'task.assigned':
        return applyTaskAssigned(state, event);
      case 'task.claimed':
        return applyTaskClaimed(state, event);
      case 'task.progressed':
        return applyTaskProgressed(state, event);
      case 'task.completed':
        return applyTaskCompleted(state, event);
      case 'task.failed':
        return applyTaskFailed(state, event);
      default:
        return state;
    }
  },
};

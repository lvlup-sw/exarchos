/**
 * TaskDetail view — post-Wave-2A.7 composes over `task-store@v1` (#1284).
 *
 * Pre-2A.7 this projection carried its own per-event switch, duplicating
 * the fold logic that the canonical `task-store@v1` reducer already encodes.
 * The duplication let the two surfaces drift (e.g. the old view wrote
 * `title: data.title ?? ''` while the canonical reducer writes
 * `title: undefined` when absent — see the cross-fold parity test in
 * `task-detail-view.test.ts`).
 *
 * Post-2A.7 this view delegates to `taskStoreReducer.apply`. The view's
 * public `TaskDetail` type is preserved as a stable consumer-facing shape
 * (the `projections/views/tools.ts` envelope keys off `TASK_DETAIL_VIEW`); internally
 * the view state stores a thin `TaskStoreState` mirror that the
 * materializer can keep in sync per stream.
 */
import type { ViewProjection } from './materializer.js';
import { taskStoreReducer } from '../taskstore/reducer.js';
import type {
  TaskRecord,
  TaskStatus,
  TaskStoreState,
} from '../taskstore/types.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const TASK_DETAIL_VIEW = 'task-detail';

// ─── Task Detail ───────────────────────────────────────────────────────────

/**
 * Public view shape consumed by `projections/views/tools.ts`. Mirrors `TaskRecord`
 * from the canonical projection; kept as a separate type so future
 * view-only fields can be added without widening the reducer's surface.
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

// ─── View State ────────────────────────────────────────────────────────────

/**
 * View state mirrors `TaskStoreState.tasks` directly. `tasks` carries the
 * full record (canonical reducer shape); the materializer reads `tasks` to
 * compose the public envelope. Snapshot round-trip is preserved because
 * the state is plain-JSON-serializable.
 */
export interface TaskDetailViewState {
  tasks: Record<string, TaskDetail>;
}

/**
 * Project a canonical `TaskRecord` into the view's public `TaskDetail` shape.
 *
 * The two shapes differ only in two places:
 *
 *   1. `title` — the view exposes `string` (BC: empty string when missing).
 *      A historical contract for the view's CLI/MCP consumers.
 *   2. `artifacts` — the view exposes `string[]` (mutable copy) instead of
 *      `readonly string[]`. The view layer's consumers expect a plain array
 *      they can dump into a JSON envelope; the readonly typing belongs to
 *      the canonical reducer state only.
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

// ─── Projection ────────────────────────────────────────────────────────────

export const taskDetailProjection: ViewProjection<TaskDetailViewState> = {
  init: () => ({ tasks: {} }),

  apply: (view, event) => {
    // Delegate the per-event fold to the canonical `task-store@v1` reducer.
    // We reconstruct a minimal `TaskStoreState` from the view's tasks (the
    // canonical state shape's only other field, `projectionSequence`, is
    // not surfaced by the view; we discard it after each fold step). This
    // keeps this materializer on the reducer's fold semantics rather than a
    // second, drifting copy — see Wave 2A.7 / #1284.
    //
    // Both sides are per-stream: `task-store@v1` is `scope: 'stream'`, and
    // this view folds one feature's events. The reducer's `tasks` key is only
    // unique within a stream, so that alignment is required, not incidental.
    const priorTaskStore: TaskStoreState = {
      projectionSequence: 0,
      tasks: viewTasksToProjectionTasks(view.tasks),
    };

    const nextTaskStore = taskStoreReducer.apply(priorTaskStore, event);
    if (nextTaskStore === priorTaskStore) {
      // Reducer returned identity (unknown event or malformed payload).
      // Preserve the view by identity too so the materializer's
      // change-detection (structural sharing) sees an unchanged frame.
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
 * Inverse of {@link toTaskDetail}: hoist the view's `tasks` back into a
 * `Record<string, TaskRecord>` so the canonical reducer can re-fold over
 * a prior view state cleanly. The mapping is lossless because every
 * `TaskDetail` field maps to a corresponding `TaskRecord` field; the only
 * coercion is `title === ''` → `title: undefined` to keep the reducer's
 * "only set when present" contract intact during round-trips.
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

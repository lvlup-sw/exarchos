import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { taskStoreReducer } from '../projections/taskstore/reducer.js';
import type {
  TaskRecord,
  TaskStoreState,
} from '../projections/taskstore/types.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const WORKFLOW_STATUS_VIEW = 'workflow-status';

// ─── View State ────────────────────────────────────────────────────────────

/**
 * Internal projection state. Public callers receive the strip-down version
 * via `views/tools.ts` (the `_seen*` fields and the embedded `_taskStore`
 * are deleted before the view envelope is returned).
 *
 * Post-Wave-2A.7 (#1284) the task-count surface is derived from an embedded
 * `TaskStoreState` rather than the prior ad-hoc dedup maps. The task-store
 * reducer naturally dedupes by upserting on `taskId`, so:
 *
 *   - `tasksTotal     = Object.keys(_taskStore.tasks).length`
 *   - `tasksCompleted = count where status === 'completed'`
 *   - `tasksFailed    = count where status === 'failed'`
 *
 * Embedding the canonical state inside the view keeps the materializer's
 * per-stream snapshot integrity intact while sharing the fold logic with the
 * canonical `task-store@v1` reducer. That reducer is `scope: 'stream'`, which
 * matches this view exactly: the counts above describe one feature's tasks.
 * (A cross-stream `readProjection<TaskStoreState>('task-store@v1')` reader
 * once existed and was removed — folding every stream together merged
 * distinct features' tasks under the same ordinal key.)
 *
 * BC for legacy snapshots: the `_seenAssignedTaskIds` / `_seenCompletedTaskIds`
 * fields are retained on the state shape (kept empty / unused) so JSON
 * snapshot round-trip from a prior projection version still validates
 * structurally. The `asSeen*` coercions are no longer invoked since the
 * reducer-derived counts are the new source of truth.
 */
export interface WorkflowStatusViewState {
  featureId: string;
  workflowType: string;
  phase: string;
  startedAt: string;
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  /** Legacy dedup bookkeeping — preserved for snapshot BC, not consulted. */
  _seenAssignedTaskIds: Record<string, true>;
  /** Legacy dedup bookkeeping — preserved for snapshot BC, not consulted. */
  _seenCompletedTaskIds: Record<string, true>;
  /**
   * Internal: per-stream `task-store@v1` mirror used to derive task counts
   * from the canonical reducer fold. Stripped before the view envelope is
   * surfaced to callers.
   */
  _taskStore: TaskStoreState;
}

// ─── Projection ────────────────────────────────────────────────────────────

const TASK_EVENT_TYPES = new Set([
  'task.assigned',
  'task.claimed',
  'task.progressed',
  'task.completed',
  'task.failed',
]);

/**
 * Count records in `tasks` whose status matches `status`. Used by the
 * post-2A.7 derivation of tasksCompleted / tasksFailed.
 */
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

/**
 * Derive the public task-count surface from the embedded `_taskStore` mirror.
 * Idempotent and pure — replaces the ad-hoc dedup maps that lived here
 * pre-2A.7.
 */
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

// Synthetic taskId prefix used when backfilling `_taskStore` from a pre-2A.7
// snapshot's `tasksFailed` surface count. Pre-2A.7 the view only carried the
// aggregate failed count (no per-task ID bookkeeping), so we materialise N
// anonymous failed placeholders to preserve `countByStatus(...,'failed')`
// after the first post-upgrade event triggers `deriveCountsFromTaskStore`.
// The prefix is namespaced to make the legacy origin obvious in any view
// dump and to guarantee no collision with real task IDs.
const LEGACY_FAILED_PLACEHOLDER_PREFIX = '__legacy-failed-';

/**
 * Reconstruct a `_taskStore` mirror from a pre-2A.7 snapshot's legacy
 * `_seen*` maps + `tasksFailed` aggregate. Called once at apply-time when
 * the snapshot pre-dates the field's introduction.
 *
 * - `_seenAssignedTaskIds` → `status: 'assigned'`
 * - `_seenCompletedTaskIds` → overrides assigned → `status: 'completed'`
 * - `view.tasksFailed` aggregate → N synthetic `__legacy-failed-i` records
 *
 * Tasks that were assigned then failed pre-snapshot will appear as
 * `'assigned'` rather than `'failed'` (legacy bookkeeping had no per-ID
 * failed map) — the synthetic placeholders preserve the aggregate failed
 * count, which is the only consumer of that surface. Post-upgrade
 * `task.failed` events will fold in correctly via the reducer.
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

  apply: (view, event: WorkflowEvent) => {
    // task.* events: delegate to the canonical task-store@v1 reducer and
    // re-derive the count surface. The reducer dedupes by `taskId` via
    // upsert semantics so `Object.keys(_taskStore.tasks).length` IS the
    // unique-tasks-assigned count, matching the pre-2A.7 contract.
    if (TASK_EVENT_TYPES.has(event.type)) {
      const currentTaskStore = view._taskStore ?? reconstructTaskStoreFromLegacy(view);
      const nextTaskStore = taskStoreReducer.apply(currentTaskStore, event);
      if (nextTaskStore === currentTaskStore) {
        // Reducer returned identity (malformed event, e.g. missing taskId).
        // Fall through to the pre-2A.7 "count malformed events" behaviour
        // below so the dedup-on-missing-id contract from #1226 stays
        // honoured. The legacy branch never gets re-entered for valid
        // events because the reducer short-circuited above.
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
          // Only set featureId if not already populated by workflow.started
          featureId: view.featureId || data?.featureId || view.featureId,
          phase: data?.to ?? view.phase,
        };
      }

      // Pre-2A.7 BC branches for malformed task events (no taskId): the
      // canonical reducer returns identity on missing taskId, which would
      // otherwise drop the legacy "count it anyway" semantic that #1226
      // documented. Replicate the count-bump here so the legacy contract
      // survives.
      case 'task.assigned': {
        // Reached only when the reducer above returned identity, i.e. the
        // event is missing a taskId. Count toward total without populating
        // _taskStore (no taskId means no record to upsert).
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

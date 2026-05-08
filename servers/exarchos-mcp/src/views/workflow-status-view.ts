import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const WORKFLOW_STATUS_VIEW = 'workflow-status';

// ─── View State ────────────────────────────────────────────────────────────

/**
 * Internal projection state. Public callers receive the strip-down version
 * via `views/tools.ts` (the `_seen*` fields are deleted before the view
 * envelope is returned).
 *
 * Dedup bookkeeping for taskId (#1226) is stored as `Record<string, true>`
 * rather than `string[]`:
 *
 *   - O(1) membership check (was O(n) `.includes` per event → O(n²) replay).
 *   - O(1) insert (was `[...arr, id]` per event → O(n) per insert).
 *   - JSON-serializable (Sets are not), so snapshot round-trip is preserved.
 *
 * The maps grow with the number of distinct taskIds seen; for pathological
 * long-running workflows callers should compact via snapshot truncation.
 * The replay-cost / memory-growth tradeoff favours the map for any workflow
 * with more than ~100 tasks, which all production workflows now exceed.
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
  _seenAssignedTaskIds: Record<string, true>;
  /** Internal: taskIds already counted toward tasksCompleted. */
  _seenCompletedTaskIds: Record<string, true>;
}

// ─── Projection ────────────────────────────────────────────────────────────

/** Pull a string `taskId` from `event.data` if present, else undefined. */
function extractTaskId(event: WorkflowEvent): string | undefined {
  const data = event.data as { taskId?: unknown } | undefined;
  if (!data) return undefined;
  return typeof data.taskId === 'string' ? data.taskId : undefined;
}

/**
 * Coerce legacy snapshot shapes (the original `string[]`) to the current
 * `Record<string, true>` shape. Snapshots written before this projection
 * was migrated still load with arrays; without the coercion, the new
 * `view._seen*[taskId]` lookup returns `undefined` (because non-numeric
 * indexing on arrays does), the dedup guard collapses, and tasksCompleted
 * can exceed tasksTotal — exactly the #1226 invariant violation the dedup
 * is supposed to prevent.
 */
function asSeenSet(seen: unknown): Record<string, true> {
  if (Array.isArray(seen)) {
    const result: Record<string, true> = {};
    for (const id of seen) {
      if (typeof id === 'string') result[id] = true;
    }
    return result;
  }
  if (seen && typeof seen === 'object') {
    return seen as Record<string, true>;
  }
  return {};
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
        const seen = asSeenSet(view._seenAssignedTaskIds);
        if (seen[taskId]) {
          // Defensive coercion: ensure post-condition is the new shape so
          // subsequent applies do O(1) lookups instead of falling back to
          // asSeenSet on every event.
          return { ...view, _seenAssignedTaskIds: seen };
        }
        return {
          ...view,
          tasksTotal: view.tasksTotal + 1,
          _seenAssignedTaskIds: { ...seen, [taskId]: true },
        };
      }

      case 'task.completed': {
        const taskId = extractTaskId(event);
        if (taskId === undefined) {
          return { ...view, tasksCompleted: view.tasksCompleted + 1 };
        }
        const seen = asSeenSet(view._seenCompletedTaskIds);
        if (seen[taskId]) {
          return { ...view, _seenCompletedTaskIds: seen };
        }
        return {
          ...view,
          tasksCompleted: view.tasksCompleted + 1,
          _seenCompletedTaskIds: { ...seen, [taskId]: true },
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

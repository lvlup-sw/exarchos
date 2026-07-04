import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import {
  extractPlanTasksFromPatch,
  promoteStatus,
  type TaskStatus,
} from '../projections/shared/task-status-fold.js';

// ─── View Name Constant ────────────────────────────────────────────────────

export const PIPELINE_VIEW = 'pipeline';

// ─── Bounds ─────────────────────────────────────────────────────────────────

export const MAX_STACK_POSITIONS = 100;

// ─── Stack Position ────────────────────────────────────────────────────────

export interface StackPosition {
  position: number;
  taskId: string;
  branch?: string;
  prUrl?: string;
}

// ─── Measured-size summary variant (DR-3) ────────────────────────────────────

/**
 * The counts-by-group summary `handleViewPipeline` returns INSTEAD of per-item
 * detail when the capped payload would still exceed the resolved output-token
 * threshold (DR-3). Carries the full-inventory group counts (so the shape stays
 * informative) plus a small first page of {@link PipelineViewState} rows.
 */
export interface PipelineSummary {
  /** Total workflows in the filtered inventory (pre-cap). */
  total: number;
  /** Count of workflows per lifecycle phase across the whole inventory. */
  byPhase: Record<string, number>;
  /** Count of workflows per workflow type across the whole inventory. */
  byWorkflowType: Record<string, number>;
  /** A bounded first page of full detail rows so the summary is still actionable. */
  firstPage: PipelineViewState[];
}

// ─── View State ────────────────────────────────────────────────────────────

export interface PipelineViewState {
  featureId: string;
  workflowType: string;
  phase: string;
  taskCount: number;
  completedCount: number;
  failedCount: number;
  /**
   * Per-task canonical status keyed by task id (#1359 / PR4 T13). Both
   * `state.patched` plan folds and dedicated `task.*` events route
   * through this map so the three counters above derive from one
   * monotonic source of truth. Vocabulary is canonical TaskSchema
   * (`pending | in_progress | complete | failed`); legacy values from
   * pre-#1359 snapshots are accepted but pass through `rankOf` which
   * treats unrecognized vocabulary as rank 0.
   */
  tasksById: Record<string, string>;
  stackPositions: StackPosition[];
  hasMore: boolean;
  /**
   * ISO timestamp of the last folded event — used by handlers to expose
   * `projectionAsOf` and `_meta.projectionLag` on the response envelope
   * (#1359 / PR4 T14 + T15). Empty string when no event has been folded.
   */
  _asOf: string;
}

// ─── Internal: derive counters from tasksById ─────────────────────────────

function deriveCounters(
  tasksById: Readonly<Record<string, string>>,
): { taskCount: number; completedCount: number; failedCount: number } {
  let completedCount = 0;
  let failedCount = 0;
  let taskCount = 0;
  for (const status of Object.values(tasksById)) {
    taskCount += 1;
    if (status === 'complete') completedCount += 1;
    else if (status === 'failed') failedCount += 1;
  }
  return { taskCount, completedCount, failedCount };
}

// ─── Projection ────────────────────────────────────────────────────────────

export const pipelineProjection: ViewProjection<PipelineViewState> = {
  init: () => ({
    featureId: '',
    workflowType: '',
    phase: '',
    taskCount: 0,
    completedCount: 0,
    failedCount: 0,
    tasksById: {},
    stackPositions: [],
    hasMore: false,
    _asOf: '',
  }),

  apply: (view, event) => {
    // Update _asOf for every event we touch (whether or not we fold it
    // into other fields) so that `projectionAsOf` always reflects the
    // most recent event observed by the materializer.
    const nextAsOf = event.timestamp ?? view._asOf;

    switch (event.type) {
      case 'workflow.started': {
        const data = event.data as { featureId?: string; workflowType?: string } | undefined;
        return {
          ...view,
          featureId: data?.featureId ?? view.featureId,
          workflowType: data?.workflowType ?? view.workflowType,
          phase: 'started',
          _asOf: nextAsOf,
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
          _asOf: nextAsOf,
        };
      }

      case 'state.patched': {
        // #1359 / PR4 T13 — fold plan-task assertions into tasksById via
        // the shared monotonic STATUS_RANK helper. Plan-state assertions
        // can advance an entry up the ladder but never regress a terminal
        // status (the planner stamps the full task list repeatedly; events
        // carry execution truth).
        const data = event.data as Record<string, unknown> | undefined;
        const planTasks = extractPlanTasksFromPatch(data);
        if (!planTasks) {
          return { ...view, _asOf: nextAsOf };
        }
        let tasksById = view.tasksById;
        for (const t of planTasks) {
          tasksById = promoteStatus(tasksById, t.id, t.status);
        }
        const counters = deriveCounters(tasksById);
        return { ...view, tasksById, ...counters, _asOf: nextAsOf };
      }

      case 'task.assigned': {
        // Canonical vocabulary post #1359: task.assigned → 'in_progress'.
        const data = event.data as { taskId?: string } | undefined;
        if (!data?.taskId) return { ...view, _asOf: nextAsOf };
        const tasksById = promoteStatus(
          view.tasksById,
          data.taskId,
          'in_progress' satisfies TaskStatus,
        );
        const counters = deriveCounters(tasksById);
        return { ...view, tasksById, ...counters, _asOf: nextAsOf };
      }

      case 'task.completed': {
        const data = event.data as { taskId?: string } | undefined;
        if (!data?.taskId) return { ...view, _asOf: nextAsOf };
        const tasksById = promoteStatus(
          view.tasksById,
          data.taskId,
          'complete' satisfies TaskStatus,
        );
        const counters = deriveCounters(tasksById);
        return { ...view, tasksById, ...counters, _asOf: nextAsOf };
      }

      case 'task.failed': {
        const data = event.data as { taskId?: string } | undefined;
        if (!data?.taskId) return { ...view, _asOf: nextAsOf };
        const tasksById = promoteStatus(
          view.tasksById,
          data.taskId,
          'failed' satisfies TaskStatus,
        );
        const counters = deriveCounters(tasksById);
        return { ...view, tasksById, ...counters, _asOf: nextAsOf };
      }

      case 'stack.position-filled': {
        const data = event.data as {
          position?: number;
          taskId?: string;
          branch?: string;
          prUrl?: string;
        } | undefined;
        if (data?.position === undefined || !data?.taskId) {
          return { ...view, _asOf: nextAsOf };
        }
        const newPositions = [
          ...view.stackPositions,
          {
            position: data.position,
            taskId: data.taskId,
            branch: data.branch,
            prUrl: data.prUrl,
          },
        ];
        const evicted = newPositions.length > MAX_STACK_POSITIONS;
        const boundedPositions = evicted
          ? newPositions.slice(newPositions.length - MAX_STACK_POSITIONS)
          : newPositions;

        return {
          ...view,
          stackPositions: boundedPositions,
          hasMore: view.hasMore || evicted,
          _asOf: nextAsOf,
        };
      }

      default:
        return view;
    }
  },
};

import type { ViewProjection } from './materializer.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import {
  extractPlanTasksFromPatch,
  promoteStatus,
  type TaskStatus,
} from '../shared/task-status-fold.js';

export const PIPELINE_VIEW = 'pipeline';

/**
 * The snapshot file name of the pipeline view. The materializer maps `PIPELINE_VIEW` to it.
 * The registration name stays `PIPELINE_VIEW`, because the materializer lookup and `BUILTIN_VIEW_NAMES` key on it.
 * Thus a server ignores old `pipeline` snapshots, and the stream folds again to get `repoRoot`.
 * `EVENT_SCHEMA_VERSION` stays the same, because it controls event migration and not view snapshots.
 */
export const PIPELINE_SNAPSHOT_NAME = 'pipeline-v2';

export const MAX_STACK_POSITIONS = 100;

export interface StackPosition {
  position: number;
  taskId: string;
  branch?: string | undefined;
  prUrl?: string | undefined;
}

/**
 * A counts-by-group summary with a first page of full {@link PipelineViewState} rows.
 * `handleViewPipeline` returns a local variant of this shape with compact rows.
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

export interface PipelineViewState {
  featureId: string;
  workflowType: string;
  phase: string;
  taskCount: number;
  completedCount: number;
  failedCount: number;
  /**
   * The canonical status of each task, by task id. `state.patched` plan folds and `task.*` events both write it, and the three counters derive from it.
   * A status never moves down the rank order. `rankOf` gives rank 0 to an unknown legacy value.
   */
  tasksById: Record<string, string>;
  stackPositions: StackPosition[];
  hasMore: boolean;
  /** Repo identity, copied from `workflow.started` data with no lookup. When the event has no `repoRoot`, only an unscoped query shows the row. */
  repoRoot?: string | undefined;
  /** ISO timestamp of the last folded event, or an empty string. Handlers use it for `projectionAsOf` and `_meta.projectionLag`. */
  _asOf: string;
}

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
    repoRoot: undefined,
    _asOf: '',
  }),

  /**
   * Folds one event. Each handled event sets `_asOf`, so `projectionAsOf` shows the most recent event.
   * Plan tasks from `state.patched` can promote a status but never move it down. The planner sends the full task list many times, and events carry the execution result.
   */
  apply: (view, event) => {
    const nextAsOf = event.timestamp ?? view._asOf;

    switch (event.type) {
      case 'workflow.started': {
        const data = event.data as {
          featureId?: string;
          workflowType?: string;
          repoRoot?: string;
        } | undefined;
        return {
          ...view,
          featureId: data?.featureId ?? view.featureId,
          workflowType: data?.workflowType ?? view.workflowType,
          phase: 'started',
          repoRoot: data?.repoRoot ?? view.repoRoot,
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
          featureId: view.featureId || data?.featureId || view.featureId,
          phase: data?.to ?? view.phase,
          _asOf: nextAsOf,
        };
      }

      case 'state.patched': {
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

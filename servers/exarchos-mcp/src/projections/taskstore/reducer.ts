/**
 * TaskStore projection reducer — Wave 2A.3 (#1284).
 *
 * `task-store@v1` is a **stream-scoped** reducer: it folds `task.*` events from
 * ONE workflow stream and produces a view of that feature's task records keyed
 * by `taskId`. See `types.ts` for the projected state shape and the status-enum
 * rationale.
 *
 * It was authored (#1284) as a global reducer folding every stream. That was
 * incorrect, and #1342 retired it: `tasks` is keyed by a bare per-feature
 * ordinal (`'001'`) and `TaskRecord` carries no `featureId`, so folding streams
 * together merged feature-A's task `001` into feature-B's. The scope must match
 * the key space. Do not restore the cross-stream reading of this comment.
 *
 * ## Event-to-status map (matches `event-store/schemas.ts`)
 *
 *   - `task.assigned`   → status `'assigned'`, seeds title/branch/worktree/assignee
 *   - `task.claimed`    → status `'claimed'`, sets agentId/claimedAt
 *   - `task.progressed` → status `'in-progress'`, sets tddPhase/detail
 *   - `task.completed`  → status `'completed'`, sets artifacts/duration
 *   - `task.failed`     → status `'failed'`, sets error
 *
 * Any other event type is a no-op: the reducer returns the input `state` by
 * identity (preserves structural-sharing semantics for change detection in
 * downstream consumers, matching the convention from
 * `rehydration/reducer.ts`).
 *
 * ## Purity
 *
 * `apply` is a pure function over `(state, event)`:
 *   - No I/O, no clock reads, no module-scoped mutation.
 *   - No in-place mutation of `state` or any nested value — every transition
 *     constructs a fresh `TaskStoreState` via spread / structural sharing.
 *   - `projectionSequence` bumps ONLY on handled events. Unhandled and
 *     malformed (missing-taskId) events return identity.
 *
 * Enforced by `assertReducerImmutable` in `reducer.test.ts` (Task 2A.4).
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { TaskRecord, TaskStoreState, TaskStatus } from './types.js';

type TaskOverlay = { -readonly [K in keyof Omit<TaskRecord, 'taskId'>]?: TaskRecord[K] } & { status: TaskStatus };

// ─── Initial state ──────────────────────────────────────────────────────────

const initialTaskStoreState: TaskStoreState = {
  projectionSequence: 0,
  tasks: {},
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pull a non-empty string `taskId` off an event's opaque `data` bag without
 * widening the reducer's type surface. Returns `undefined` for missing,
 * non-string, or empty values so callers can short-circuit malformed events
 * into no-op handling.
 */
function extractTaskId(data: WorkflowEvent['data']): string | undefined {
  if (!data) return undefined;
  const raw = data['taskId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Extract a non-empty string field, or `undefined`. Matches the convention
 * from `rehydration/reducer.ts` so the two reducers stay symmetrically lax
 * about partial payloads (replay tolerance, DR-1).
 */
function extractString(
  data: WorkflowEvent['data'],
  key: string,
): string | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/** Extract a finite number, or `undefined`. */
function extractNumber(
  data: WorkflowEvent['data'],
  key: string,
): number | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/** Extract a `string[]`, filtering non-string entries. Returns `undefined` for missing or non-array. */
function extractStringArray(
  data: WorkflowEvent['data'],
  key: string,
): string[] | undefined {
  if (!data) return undefined;
  const raw = data[key];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * Narrow `tddPhase` from event data to the `TaskRecord` surface
 * (`'red' | 'green' | 'refactor'`). Anything else collapses to `undefined`.
 */
function extractTddPhase(
  data: WorkflowEvent['data'],
): TaskRecord['tddPhase'] | undefined {
  const raw = extractString(data, 'tddPhase');
  if (raw === 'red' || raw === 'green' || raw === 'refactor') return raw;
  return undefined;
}

/**
 * Produce a new `TaskStoreState` with one task upserted. The prior record
 * (if any) supplies passthrough field defaults; the new overlay replaces
 * status + any provided fields. Never mutates inputs.
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

// ─── Per-event handlers ─────────────────────────────────────────────────────

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

// ─── Reducer (thin dispatcher) ──────────────────────────────────────────────

export const taskStoreReducer: ProjectionReducer<TaskStoreState, WorkflowEvent> = {
  id: 'task-store@v1',
  version: 1,
  // Per-stream, and only ever safely per-stream: `TaskStoreState.tasks` is
  // keyed by a bare per-feature ordinal (`'001'`) and `TaskRecord` carries no
  // `featureId`, so a cross-stream fold would merge distinct features' task
  // `001` into one entry. Both real consumers (`views/workflow-status-view.ts`,
  // `views/task-detail-view.ts`) already fold `.apply` one stream at a time.
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
        // Unknown event type — return identity to preserve structural-sharing
        // semantics. Matches the rehydration reducer's default branch.
        return state;
    }
  },
};

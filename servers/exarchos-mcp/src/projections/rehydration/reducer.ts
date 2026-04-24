/**
 * Rehydration projection reducer (T022 skeleton + T023 task-event fold, DR-3).
 *
 * Folds the canonical event stream (`WorkflowEvent`) into a
 * {@link RehydrationDocument} suitable for emission by the rehydration MCP
 * envelope (DR-3). Task folding landed in T023; workflow/artifact/decision
 * folding lands in T024–T025:
 *
 *   - T023 — `task.assigned` / `task.completed` / `task.failed` → `taskProgress`
 *   - T024 — `workflow.*` events populate `workflowState`
 *   - T025 — artifacts, blockers, and decisions
 *
 * The reducer is **not** registered with the projection registry here; that
 * wiring is T026.
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import {
  RehydrationDocumentSchema,
  type RehydrationDocument,
} from './schema.js';

/** Terminal task states this reducer recognises as taskProgress statuses. */
type TaskProgressStatus = 'assigned' | 'completed' | 'failed';

/** Structural shape of a single taskProgress entry in the rehydration doc. */
type TaskProgressEntry = RehydrationDocument['taskProgress'][number];

/**
 * Minimal initial rehydration document — satisfies {@link RehydrationDocumentSchema}
 * with empty volatile sections and stable-section string defaults. Folding over
 * an empty event stream MUST yield this value (see `ProjectionReducer.initial`).
 *
 * Validated at module load (below) via `.parse(...)` so that any schema drift
 * is caught the moment this module is imported, rather than at first use.
 */
const initialRehydrationDocument: RehydrationDocument = RehydrationDocumentSchema.parse({
  v: 1,
  projectionSequence: 0,
  behavioralGuidance: {
    skill: '',
    skillRef: '',
  },
  workflowState: {
    featureId: '',
    phase: '',
    workflowType: '',
  },
  taskProgress: [],
  decisions: [],
  artifacts: {},
  blockers: [],
});

/**
 * Pure helper — upsert a task's progress entry by `taskId`.
 *
 * - If `taskId` is not present, append a new `{ id, status }` entry.
 * - If `taskId` is present, replace the existing entry's `status` (preserving
 *   any passthrough fields other reducers/callers may have attached).
 *
 * Never mutates `progress`; always returns a new array (identity-changed even
 * when contents are equivalent, to signal "handled this event" to callers
 * who rely on structural sharing for change detection).
 */
function upsertTaskProgress(
  progress: readonly TaskProgressEntry[],
  taskId: string,
  status: TaskProgressStatus,
): TaskProgressEntry[] {
  const existingIdx = progress.findIndex((entry) => entry.id === taskId);
  if (existingIdx === -1) {
    return [...progress, { id: taskId, status }];
  }
  const next = progress.slice();
  next[existingIdx] = { ...next[existingIdx], id: taskId, status };
  return next;
}

/**
 * Narrow extractor — pulls a string `taskId` off an event's opaque `data` bag
 * without widening the reducer's type surface to `any`. The event-store base
 * schema types `data` as `Record<string, unknown> | undefined`, so this
 * performs the runtime check the type system cannot.
 */
function extractTaskId(data: WorkflowEvent['data']): string | undefined {
  if (!data) return undefined;
  const raw = data['taskId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export const rehydrationReducer: ProjectionReducer<RehydrationDocument, WorkflowEvent> = {
  id: 'rehydration@v1',
  version: 1,
  initial: initialRehydrationDocument,
  apply(state: RehydrationDocument, event: WorkflowEvent): RehydrationDocument {
    // Discriminate on event.type. Unknown event types short-circuit back to
    // `state` unchanged (preserves T022's identity contract for unhandled types
    // and keeps `projectionSequence` monotonic only over *handled* events).
    let nextStatus: TaskProgressStatus;
    switch (event.type) {
      case 'task.assigned':
        nextStatus = 'assigned';
        break;
      case 'task.completed':
        nextStatus = 'completed';
        break;
      case 'task.failed':
        nextStatus = 'failed';
        break;
      default:
        return state;
    }

    const taskId = extractTaskId(event.data);
    if (!taskId) {
      // Malformed task event (no taskId): nothing to fold. Return unchanged
      // so that replay over partial/legacy data cannot corrupt taskProgress.
      return state;
    }

    return {
      ...state,
      projectionSequence: state.projectionSequence + 1,
      taskProgress: upsertTaskProgress(state.taskProgress, taskId, nextStatus),
    };
  },
};

export type { RehydrationDocument } from './schema.js';

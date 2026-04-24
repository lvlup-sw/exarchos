/**
 * Rehydration projection reducer (T022 skeleton + T023 task-event fold
 * + T024 workflow-event fold, DR-3).
 *
 * Folds the canonical event stream (`WorkflowEvent`) into a
 * {@link RehydrationDocument} suitable for emission by the rehydration MCP
 * envelope (DR-3). Task folding landed in T023; workflow folding lands in
 * T024; artifact/decision folding lands in T025:
 *
 *   - T023 — `task.assigned` / `task.completed` / `task.failed` → `taskProgress`
 *   - T024 — `workflow.started` / `workflow.transition` → `workflowState`
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

/**
 * Generic string-field extractor — mirrors {@link extractTaskId} for arbitrary
 * string-typed fields on the event's opaque `data` bag (e.g. `featureId`,
 * `workflowType`, `to`). Returns `undefined` for missing/non-string/empty
 * values so the reducer can short-circuit on malformed events without ever
 * writing `undefined` into the schema-validated workflowState.
 */
function extractString(
  data: WorkflowEvent['data'],
  key: string,
): string | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Narrow a `state.patched` event's opaque `data.patch.artifacts` subtree into
 * a `Record<string, string>` suitable for `ArtifactsSchema`. The workflow-side
 * `ArtifactsSchema` allows `string | null`, but the rehydration projection's
 * artifacts map is `Record<string, string>` — so non-string values (null,
 * undefined, nested objects, arrays) are dropped rather than coerced, keeping
 * the projection schema-valid under replay over legacy / partial patches.
 *
 * Returns `undefined` when the event carries no artifacts subtree at all —
 * the caller should treat that as a no-op (do not bump projectionSequence).
 */
function extractArtifactsPatch(
  data: WorkflowEvent['data'],
): Record<string, string> | undefined {
  if (!data) return undefined;
  const patch = data['patch'];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return undefined;
  }
  const artifacts = (patch as Record<string, unknown>)['artifacts'];
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return undefined;
  }
  const entries = Object.entries(artifacts as Record<string, unknown>);
  const stringEntries = entries.filter(
    (pair): pair is [string, string] =>
      typeof pair[1] === 'string' && pair[1].length > 0,
  );
  // Caller distinguishes "no artifacts subtree" (return undefined) from
  // "artifacts subtree present but all values non-string" (return {}): the
  // former is a no-op; the latter is a handled event that changes nothing but
  // should still advance projectionSequence only if it carried at least one
  // valid key. To keep the reducer contract simple — handled events MUST
  // update state — we return undefined here when no usable keys were found,
  // so an artifacts-only patch with all-null values is treated as a no-op.
  if (stringEntries.length === 0) return undefined;
  return Object.fromEntries(stringEntries);
}

export const rehydrationReducer: ProjectionReducer<RehydrationDocument, WorkflowEvent> = {
  id: 'rehydration@v1',
  version: 1,
  initial: initialRehydrationDocument,
  apply(state: RehydrationDocument, event: WorkflowEvent): RehydrationDocument {
    // Discriminate on event.type. Unknown event types short-circuit back to
    // `state` unchanged (preserves T022's identity contract for unhandled types
    // and keeps `projectionSequence` monotonic only over *handled* events).
    switch (event.type) {
      case 'task.assigned':
      case 'task.completed':
      case 'task.failed': {
        const nextStatus: TaskProgressStatus =
          event.type === 'task.assigned'
            ? 'assigned'
            : event.type === 'task.completed'
              ? 'completed'
              : 'failed';
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
      }

      case 'workflow.started': {
        // Per `WorkflowStartedData` in event-store/schemas.ts, the event data
        // carries `featureId` and `workflowType` (plus optional `designPath` /
        // `synthesisPolicy` the rehydration projection does not surface).
        // There is NO `phase` on this event — phase is only written by
        // `workflow.transition` below — so we leave state.workflowState.phase
        // at its prior value (initial default `''` on a fresh stream).
        const featureId = extractString(event.data, 'featureId');
        const workflowType = extractString(event.data, 'workflowType');
        if (!featureId || !workflowType) {
          // Malformed start event (missing identifiers): do not fold.
          return state;
        }
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          workflowState: {
            ...state.workflowState,
            featureId,
            workflowType,
          },
        };
      }

      case 'workflow.transition': {
        // Per `WorkflowTransitionData` in event-store/schemas.ts, the event
        // carries `from`, `to`, `trigger`, `featureId`. We advance phase to
        // `to` and preserve the pre-existing featureId / workflowType set by
        // the prior `workflow.started` event.
        const to = extractString(event.data, 'to');
        if (!to) {
          // Malformed transition (no `to`): cannot advance phase.
          return state;
        }
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          workflowState: {
            ...state.workflowState,
            phase: to,
          },
        };
      }

      // T025 — Artifacts: `state.patched` events carry the workflow-state
      // update delta, whose `data.patch.artifacts` subtree mirrors the
      // workflow `ArtifactsSchema`. (The plan references `workflow.set`, but
      // `workflow set` emits `state.patched` under the hood — see
      // `servers/exarchos-mcp/src/workflow/tools.ts` ~L759.)
      case 'state.patched': {
        const artifactsPatch = extractArtifactsPatch(event.data);
        if (!artifactsPatch) {
          // Either no artifacts subtree in this patch, or all values were
          // non-string — either way, nothing to fold into rehydration
          // artifacts. Other subtrees (e.g. `tasks`) are surfaced via their
          // own dedicated events (task.*) and are not re-derived from
          // state.patched here.
          return state;
        }
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          artifacts: {
            ...state.artifacts,
            ...artifactsPatch,
          },
        };
      }

      // T025 — Blockers: `review.completed` with a `blocked` verdict marks a
      // blocking review outcome (per ReviewCompletedData). Non-blocking
      // verdicts (`pass`, `fail`) are not folded — `fail` indicates findings
      // to fix but not a hard stop, and the plan's original `review.failed`
      // event type is not registered.
      case 'review.completed': {
        const verdict = extractString(event.data, 'verdict');
        if (verdict !== 'blocked') {
          return state;
        }
        const summary = extractString(event.data, 'summary') ?? 'review blocked';
        const stage = extractString(event.data, 'stage') ?? 'review';
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          blockers: [
            ...state.blockers,
            { source: 'review.completed', stage, summary },
          ],
        };
      }

      // T025 — Blockers: `review.escalated` is inherently a blocker — the
      // reviewer bumped the risk up (per ReviewEscalatedData).
      case 'review.escalated': {
        const reason = extractString(event.data, 'reason') ?? 'review escalated';
        const triggeringFinding = extractString(event.data, 'triggeringFinding');
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          blockers: [
            ...state.blockers,
            {
              source: 'review.escalated',
              reason,
              ...(triggeringFinding ? { triggeringFinding } : {}),
            },
          ],
        };
      }

      // T025 — Blockers: `workflow.guard-failed` indicates a guard predicate
      // rejected a transition (per WorkflowGuardFailedData). The rejection
      // itself is the blocker.
      case 'workflow.guard-failed': {
        const guard = extractString(event.data, 'guard') ?? 'unknown-guard';
        const from = extractString(event.data, 'from');
        const to = extractString(event.data, 'to');
        return {
          ...state,
          projectionSequence: state.projectionSequence + 1,
          blockers: [
            ...state.blockers,
            {
              source: 'workflow.guard-failed',
              guard,
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
            },
          ],
        };
      }

      // T025 — Decisions: no `decision.*` event type is registered in the
      // event-store. Skipped here; the projection's `decisions` array remains
      // empty until a decisions-producing event type is added.

      default:
        return state;
    }
  },
};

export type { RehydrationDocument } from './schema.js';

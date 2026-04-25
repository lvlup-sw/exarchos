/**
 * Rehydration projection reducer (T022 skeleton + T023 task-event fold
 * + T024 workflow-event fold + T025 remaining volatile sections, DR-3).
 *
 * Folds the canonical event stream (`WorkflowEvent`) into a
 * {@link RehydrationDocument} suitable for emission by the rehydration MCP
 * envelope (DR-3):
 *
 *   - T023 — `task.assigned` / `task.completed` / `task.failed` → `taskProgress`
 *   - T024 — `workflow.started` / `workflow.transition` → `workflowState`
 *   - T025 — `state.patched` → `artifacts`; `review.completed` (blocked) /
 *            `review.escalated` / `workflow.guard-failed` → `blockers`.
 *            No decisions-producing event type is registered; `decisions`
 *            remains empty until one is added (see note at bottom of file).
 *
 * Handlers are grouped by event-type prefix below (task.*, workflow.*,
 * state.*, review.*). The top-level `apply()` is a thin dispatcher; every
 * per-prefix handler returns the original `state` unchanged when the event
 * is malformed or not actionable, which keeps `projectionSequence` monotonic
 * only over *handled* events and preserves identity for unhandled types.
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

// ─── Initial state ──────────────────────────────────────────────────────────

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

// ─── Shared extractors ──────────────────────────────────────────────────────

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
 * Returns `undefined` when the patch has no artifacts subtree OR when every
 * value in the subtree is non-string. Callers treat `undefined` as a no-op
 * (do not bump projectionSequence), guaranteeing that only events which
 * change state advance the sequence.
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
  if (stringEntries.length === 0) return undefined;
  return Object.fromEntries(stringEntries);
}

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

// ─── Per-prefix handlers ────────────────────────────────────────────────────
//
// Each handler accepts (state, event) where `event.type` has already been
// narrowed by the dispatcher. Handlers are pure: they either return a new
// document (handled) or return `state` unchanged (malformed / no-op), and
// never mutate the input. Each handled result bumps `projectionSequence`
// exactly once.

/** Handlers for `task.*` events — taskProgress fold (T023). */
function applyTaskEvent(
  state: RehydrationDocument,
  event: WorkflowEvent,
  status: TaskProgressStatus,
): RehydrationDocument {
  const taskId = extractTaskId(event.data);
  if (!taskId) {
    // Malformed task event (no taskId): nothing to fold. Return unchanged
    // so that replay over partial/legacy data cannot corrupt taskProgress.
    return state;
  }
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    taskProgress: upsertTaskProgress(state.taskProgress, taskId, status),
  };
}

/**
 * Handler for `workflow.started` — seeds `workflowState.featureId` +
 * `workflowType` from the registered `WorkflowStartedData` payload. Does NOT
 * write `phase` — the started event carries no phase; phase is only advanced
 * by `workflow.transition` below.
 */
function applyWorkflowStarted(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
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

/**
 * Handler for `workflow.transition` — advances `workflowState.phase` to the
 * `to` value. Preserves the prior `featureId` / `workflowType` set by the
 * preceding `workflow.started` event.
 */
function applyWorkflowTransition(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
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

/**
 * Handler for `workflow.guard-failed` — a guard predicate rejected a
 * transition (per WorkflowGuardFailedData); record the rejection as a
 * structured blocker entry.
 *
 * Unlike sibling handlers, this one does NOT bail on missing fields — the
 * event's existence IS the signal that a guard fired, and dropping it on
 * partial payloads would leave the rehydration document blind to a real
 * blocker. `guard` falls back to `'unknown-guard'`; `from`/`to` are
 * surfaced only when present.
 */
function applyWorkflowGuardFailed(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
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

/**
 * Handler for `state.patched` — folds the `data.patch.artifacts` subtree into
 * rehydration `artifacts` (T025). The plan references `workflow.set`, but
 * `workflow set` emits `state.patched` under the hood — see
 * `servers/exarchos-mcp/src/workflow/tools.ts` ~L759. Other subtrees (e.g.
 * `tasks`) are surfaced via their own dedicated events (task.*) and are not
 * re-derived from state.patched here.
 */
function applyStatePatched(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const artifactsPatch = extractArtifactsPatch(event.data);
  if (!artifactsPatch) {
    // No artifacts subtree, or every value was non-string: no-op.
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

/**
 * Handler for `review.completed` — only the `blocked` verdict is folded as a
 * blocker (per ReviewCompletedData). Non-blocking verdicts (`pass`, `fail`)
 * are not folded; `fail` indicates findings to fix but not a hard stop, and
 * the plan's original `review.failed` event type is not registered in the
 * event-store.
 */
function applyReviewCompleted(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
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

/**
 * Handler for `review.escalated` — escalation is inherently a blocker (per
 * ReviewEscalatedData). The reviewer bumped risk up; capture the reason.
 */
function applyReviewEscalated(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
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

// ─── Reducer (thin dispatcher) ──────────────────────────────────────────────

export const rehydrationReducer: ProjectionReducer<RehydrationDocument, WorkflowEvent> = {
  id: 'rehydration@v1',
  version: 1,
  initial: initialRehydrationDocument,
  apply(state: RehydrationDocument, event: WorkflowEvent): RehydrationDocument {
    // Dispatch by event.type, grouped below by event-type prefix. Unknown
    // event types short-circuit back to `state` unchanged (preserves the T022
    // identity contract for unhandled types and keeps `projectionSequence`
    // monotonic only over *handled* events).
    switch (event.type) {
      // ── task.* — taskProgress fold (T023) ─────────────────────────────────
      case 'task.assigned':
        return applyTaskEvent(state, event, 'assigned');
      case 'task.completed':
        return applyTaskEvent(state, event, 'completed');
      case 'task.failed':
        return applyTaskEvent(state, event, 'failed');

      // ── workflow.* — workflowState + blockers fold (T024, T025) ──────────
      case 'workflow.started':
        return applyWorkflowStarted(state, event);
      case 'workflow.transition':
        return applyWorkflowTransition(state, event);
      case 'workflow.guard-failed':
        return applyWorkflowGuardFailed(state, event);

      // ── state.* — artifacts fold (T025) ──────────────────────────────────
      case 'state.patched':
        return applyStatePatched(state, event);

      // ── review.* — blockers fold (T025) ──────────────────────────────────
      case 'review.completed':
        return applyReviewCompleted(state, event);
      case 'review.escalated':
        return applyReviewEscalated(state, event);

      // ── decision.* — NOT YET WIRED ───────────────────────────────────────
      // No `decision.*` event type is registered in the event-store.
      // `decisions` on the rehydration document remains empty until a
      // decisions-producing event type is added and handled here.

      default:
        return state;
    }
  },
};

export type { RehydrationDocument } from './schema.js';

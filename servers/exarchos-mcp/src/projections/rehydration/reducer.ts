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

/**
 * Task statuses surfaced by this reducer.
 *
 *  - `assigned` / `completed` / `failed` come from dedicated `task.*` events.
 *  - `pending` is seeded from `state.patched.patch.tasks` (the planner's
 *    declared task list — see Fix 2 / #1179) so plan-state tasks that have
 *    not yet been dispatched still appear in the rehydration document.
 *
 * Event-derived statuses are *authoritative* over plan-derived statuses:
 * once a task has been observed assigned/completed/failed via events, a
 * later state.patched re-asserting the plan must NOT regress it back to
 * `pending` (the planner stamps the plan repeatedly; events carry execution
 * truth).
 */
type TaskProgressStatus = 'pending' | 'assigned' | 'completed' | 'failed';

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
 * Diff-style decoding of `data.patch.artifacts` from a `state.patched` event:
 *
 *   - `set`   — string upserts (`{ [name]: path }`)
 *   - `unset` — entries explicitly cleared via `null` (delete from artifacts)
 *
 * The two slices are mutually exclusive. Anything else (undefined, nested
 * objects, arrays, empty strings) is ignored as malformed — the projection's
 * artifacts map is `Record<string, string>` so coercing non-string values
 * would corrupt downstream consumers.
 */
interface ExtractedArtifactsPatch {
  readonly set: Record<string, string>;
  readonly unset: readonly string[];
}

/**
 * Decode a `state.patched` event's `data.patch.artifacts` subtree into an
 * upsert/clear diff. Returns `undefined` when the event has no artifacts
 * patch OR when no entry is actionable (so callers treat the event as a
 * no-op and avoid bumping `projectionSequence`).
 *
 * The workflow-side `ArtifactsSchema` allows `string | null`. We honour the
 * null branch as an explicit "clear this entry" signal so callers issuing
 * `workflow set { artifacts: { design: null } }` get the expected result —
 * silently dropping the null would let stale artifact paths survive in the
 * projection long after the underlying file moved.
 */
function extractArtifactsPatch(
  data: WorkflowEvent['data'],
): ExtractedArtifactsPatch | undefined {
  if (!data) return undefined;
  const patch = data['patch'];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return undefined;
  }
  const artifacts = (patch as Record<string, unknown>)['artifacts'];
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    return undefined;
  }

  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(
    artifacts as Record<string, unknown>,
  )) {
    if (typeof value === 'string' && value.length > 0) {
      set[key] = value;
    } else if (value === null) {
      unset.push(key);
    }
    // Other shapes (undefined, '', objects, arrays) are intentionally
    // ignored — `Record<string, string>` cannot represent them and they
    // do not carry an unambiguous "clear this entry" signal.
  }

  if (Object.keys(set).length === 0 && unset.length === 0) {
    return undefined;
  }
  return { set, unset };
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

/**
 * Decode the `data.patch.tasks` subtree of a `state.patched` event into a
 * minimal `{ id, status }[]` projection (Fix 2 / #1179).
 *
 * The workflow-side `TaskSchema` (workflow/schemas.ts) carries many fields,
 * but the rehydration document only consumes id + status. Anything that
 * isn't a non-empty string `id` is skipped — the patch could carry an
 * intentionally partial entry (e.g. only `title` updates) that we should
 * not invent an id for.
 *
 * Returns `undefined` when the event has no tasks subtree OR the subtree is
 * empty / unactionable, so callers can short-circuit and avoid bumping
 * `projectionSequence` for no-op patches.
 */
interface ExtractedPlanTask {
  readonly id: string;
  readonly status: TaskProgressStatus;
}

function extractPlanTasks(
  data: WorkflowEvent['data'],
): readonly ExtractedPlanTask[] | undefined {
  if (!data) return undefined;
  const patch = data['patch'];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return undefined;
  }
  const tasksRaw = (patch as Record<string, unknown>)['tasks'];
  if (!Array.isArray(tasksRaw)) {
    return undefined;
  }

  const out: ExtractedPlanTask[] = [];
  for (const entry of tasksRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e['id'] === 'string' ? (e['id'] as string) : undefined;
    if (!id) continue;
    // The plan-side TaskSchema status is `pending|in_progress|complete|failed`.
    // Map onto the reducer's TaskProgressStatus surface; anything else (or
    // missing) becomes `pending` because the plan-state assertion is "this
    // task exists" — refining its execution status is the events' job.
    const rawStatus = e['status'];
    const status: TaskProgressStatus =
      rawStatus === 'failed'
        ? 'failed'
        : rawStatus === 'complete' || rawStatus === 'completed'
          ? 'completed'
          : rawStatus === 'in_progress'
            ? 'assigned'
            : 'pending';
    out.push({ id, status });
  }

  return out.length > 0 ? out : undefined;
}

/**
 * Pure helper — fold a plan-derived task list into the existing taskProgress.
 *
 * Plan-derived statuses are *seed-only*: an event-derived status (assigned /
 * completed / failed) for the same id always wins. This guarantees that a
 * later state.patched re-asserting the plan cannot resurrect a completed
 * task back to pending. New ids in the plan are appended with their
 * plan-declared status; ids already present keep their stronger status.
 */
function foldPlanTasks(
  progress: readonly TaskProgressEntry[],
  planTasks: readonly ExtractedPlanTask[],
): TaskProgressEntry[] {
  const next = progress.slice();
  const indexById = new Map(next.map((entry, idx) => [entry.id, idx]));
  for (const planTask of planTasks) {
    const existingIdx = indexById.get(planTask.id);
    if (existingIdx === undefined) {
      next.push({ id: planTask.id, status: planTask.status });
      indexById.set(planTask.id, next.length - 1);
      continue;
    }
    // Preserve the existing status — events are authoritative over plan
    // re-assertions. Only fill in a status for entries that somehow lack
    // one (defensive; the schema requires status to be a string).
    const existing = next[existingIdx];
    if (!existing.status) {
      next[existingIdx] = { ...existing, status: planTask.status };
    }
  }
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
 * rehydration `artifacts` (T025) AND, post Fix 2 / #1179, folds
 * `data.patch.tasks` into `taskProgress` as plan-state assertions.
 *
 * `state.patched` is the canonical event behind `exarchos_workflow set` — see
 * `servers/exarchos-mcp/src/workflow/tools.ts` ~L759. Pre-fix this handler
 * deliberately ignored the `tasks` subtree on the assumption that dedicated
 * `task.*` events would always cover the tasks list. In practice planners
 * stamp the full task list via `workflow set` before any `task.assigned`
 * event fires, so pending tasks went missing from the rehydration document.
 *
 * Both subtrees are independent — the event may carry one, the other, both,
 * or neither. The handler treats them as independent contributions to a
 * single (potentially merged) state delta and bumps `projectionSequence`
 * once per actionable event (DR-1, no mutation; counter monotonicity).
 */
function applyStatePatched(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const artifactsPatch = extractArtifactsPatch(event.data);
  const planTasks = extractPlanTasks(event.data);
  if (!artifactsPatch && !planTasks) {
    // No actionable subtrees: no-op. Return identity so callers that rely
    // on structural sharing for change detection see "unhandled".
    return state;
  }

  let nextArtifacts: Record<string, string> = state.artifacts;
  if (artifactsPatch) {
    // Fold the diff: drop unset keys first (so an `unset` entry can't be
    // resurrected by a same-event `set`), then overlay the upserts. Build a
    // fresh object rather than mutating to preserve reducer purity (DR-1).
    nextArtifacts = { ...state.artifacts };
    for (const key of artifactsPatch.unset) {
      delete nextArtifacts[key];
    }
    for (const [key, value] of Object.entries(artifactsPatch.set)) {
      nextArtifacts[key] = value;
    }
  }

  const nextTaskProgress = planTasks
    ? foldPlanTasks(state.taskProgress, planTasks)
    : state.taskProgress;

  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    artifacts: nextArtifacts,
    taskProgress: nextTaskProgress,
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

// ─── Registered event-type accessor (Fix 3 / #1180, DIM-3) ─────────────────
//
// SoT introspection — exposes the per-phase set of event types the reducer
// recognises so that downstream surfaces (`PHASE_EXPECTED_EVENTS` in
// orchestrate/check-event-emissions.ts; the delegate-phase playbook events
// list in workflow/playbooks.ts) can derive their lists from a single source
// instead of maintaining independent copies that drift silently.
//
// In the RED state of TDD this returns ONLY the events whose handlers are
// already wired into `apply()` below (`task.assigned/completed/failed` for
// the delegate phases). The aligning GREEN step extends both the registry
// and the dispatch table to cover the full delegate event contract — see
// reducer.delegate-contract.test.ts.

export function getRegisteredEventTypes(phase: string): readonly string[] {
  switch (phase) {
    case 'delegate':
    case 'overhaul-delegate':
      // Pre-Fix-3 surface: the reducer only folds task.* status changes for
      // delegate phases. Hints + playbook will fail their equality assertions
      // until GREEN broadens this set.
      return ['task.assigned', 'task.completed', 'task.failed'];
    default:
      return [];
  }
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

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
import {
  STATUS_RANK,
  extractPlanTasksFromPatch,
  rankOf,
  type ExtractedPlanTask,
  type TaskStatus,
} from '../shared/task-status-fold.js';

/**
 * Task statuses surfaced by this reducer — post #1359 PR4 canonical
 * vocabulary aligned with `workflow/schemas.ts`' `TaskSchema.status`.
 *
 *  - `in_progress` / `complete` / `failed` come from dedicated `task.*` events
 *    (formerly `assigned` / `completed`).
 *  - `pending` is seeded from `state.patched.patch.tasks` (the planner's
 *    declared task list — see Fix 2 / #1179) so plan-state tasks that have
 *    not yet been dispatched still appear in the rehydration document.
 *
 * Event-derived statuses are *authoritative* over plan-derived statuses:
 * once a task has been observed in_progress / complete / failed via events,
 * a later state.patched re-asserting the plan must NOT regress it back to
 * `pending` (the planner stamps the plan repeatedly; events carry execution
 * truth).
 *
 * Pre-#1359 the reducer normalized `'complete' → 'completed'`. That divergence
 * from canonical `TaskSchema.status` was Bug B in the #1359 projection-drift
 * RCA: an agent reading rehydrate.taskProgress saw `'completed'` and then
 * compared against `tasks[].status === 'complete'`, never matched, and
 * re-dispatched already-complete work.
 */
type TaskProgressStatus = TaskStatus;

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
  v: 4,
  projectionSequence: 0,
  workflowState: {
    featureId: '',
    phase: '',
    workflowType: '',
  },
  taskProgress: [],
  decisions: [],
  artifacts: {},
  blockers: [],
  // recentHandoffs defaults to [] via the schema; explicit here so the
  // initial document is self-describing and `parse(...)` doesn't have to
  // populate it as a side effect.
  recentHandoffs: [],
  // phasePlaybook is composed live at handler time (T-20). Initial document
  // seeds it to `null` per the v:3 schema's nullable contract.
  phasePlaybook: null,
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
// `extractPlanTasksFromPatch` (canonical-vocabulary plan-task extractor) and
// `STATUS_RANK` (canonical-vocabulary precedence ladder) live in
// `../shared/task-status-fold.ts` (#1359 / PR4 T13) so the pipeline view
// projection can share the same monotonic-fold semantics. The reducer uses
// the canonical extractor directly; callers pre-#1359 passed `data` through
// a local extractor whose status mapping renamed `'complete' → 'completed'`,
// which was Bug B of the #1359 projection-drift RCA.

const extractPlanTasks = extractPlanTasksFromPatch;

/**
 * Pure helper — fold a plan-derived task list into the existing taskProgress.
 *
 * Monotonic status promotion: a plan-carried status can advance an existing
 * entry up the precedence ladder (pending → assigned → completed/failed),
 * but never back down. This covers the missing-event flows #1180 was filed
 * against — a state.patched re-assertion can promote `assigned` to
 * `completed` even when the dedicated task.completed event never fired —
 * while still preventing the regression case (a re-assertion of `pending`
 * over a `completed` entry is ignored). New ids in the plan are appended
 * with their plan-declared status. Per CR review 4178067854.
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
    const existing = next[existingIdx];
    // Rank lookup is shared with the pipeline view via
    // `../shared/task-status-fold.ts` so both surfaces agree on the
    // precedence ladder (#1359 / PR4 T13).
    if (rankOf(planTask.status) > rankOf(existing.status)) {
      next[existingIdx] = { ...existing, status: planTask.status };
    }
  }
  return next;
}

// Silence the unused-import warning for `STATUS_RANK` — the ladder is
// re-exported below for snapshot/migration consumers, but the reducer
// itself uses `rankOf` exclusively. Without this reference TypeScript's
// `noUnusedLocals` would flag the import.
void STATUS_RANK;

// ─── Per-prefix handlers ────────────────────────────────────────────────────
//
// Each handler accepts (state, event) where `event.type` has already been
// narrowed by the dispatcher. Handlers are pure: they either return a new
// document (handled) or return `state` unchanged (malformed / no-op), and
// never mutate the input. Each handled result bumps `projectionSequence`
// exactly once.

/**
 * Predicate (#1208 / DR-MO-1, DR-MO-2) — true when the event's `data` carries
 * a worktree association via `worktree` OR `worktreePath`. Centralised so the
 * rehydration projection (this file) and the HSM `mergePendingEntry` guard
 * (workflow/hsm-definitions.ts) compute the same trigger.
 */
export function eventDataHasWorktreeAssociation(
  data: WorkflowEvent['data'],
): boolean {
  if (!data) return false;
  const w = data['worktree'];
  const p = data['worktreePath'];
  // Trim before length-checking — a whitespace-only string is not a real
  // worktree association and must not trigger the merge-pending detour.
  return (
    (typeof w === 'string' && w.trim().length > 0) ||
    (typeof p === 'string' && p.trim().length > 0)
  );
}

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
  // #1208 / DR-MO-1 auto-detour: when a `task.completed` carries a worktree
  // association AND the merge orchestrator has not already terminated for
  // this task, project the workflow into the `merge-pending` substate and
  // seed the `mergeOrchestrator` segment so `nextActionsFromResult` can
  // surface `merge_orchestrate`. Idempotent: a re-folded same-taskId event
  // will not regress a terminal merge phase back to `pending`.
  //
  // Scope (per coderabbit / #1109 Constraint 1 — event-sourcing integrity):
  // gated on workflowType='feature' AND a phase compatible with the
  // `merge-pending` substate. `createFeatureHSM()` is the only HSM that
  // defines `merge-pending`, so detouring a refactor / debug / oneshot /
  // discovery stream — or a feature stream already past `delegate` (e.g.
  // `synthesize`, `completed`) — would project an impossible state and
  // confuse next-action / HSM consumers downstream.
  //
  // Compatible phases: `''` (initial — production flows reach `delegate`
  // implicitly via `prepare_delegation` without emitting a
  // `workflow.transition`), `delegate` (canonical entry), and
  // `merge-pending` (re-entrant). All other phases are blocked.
  let nextWorkflowState = state.workflowState;
  const detourablePhase =
    state.workflowState.phase === '' ||
    state.workflowState.phase === 'delegate' ||
    state.workflowState.phase === 'merge-pending';
  if (
    status === 'complete' &&
    state.workflowState.workflowType === 'feature' &&
    detourablePhase &&
    eventDataHasWorktreeAssociation(event.data)
  ) {
    const existing = state.workflowState.mergeOrchestrator;
    // Skip the (re)stamp in two distinct cases:
    //
    //   1. `conflictsWithActiveOther` — an active pending merge already exists
    //      for a DIFFERENT task. Clobbering it would let a subsequent
    //      merge.executed / merge.rollback / merge.aborted fire against the
    //      wrong taskId in `applyMergeTerminalEvent`. Preserve the active
    //      pending; the second task's worktree merge gets picked up after
    //      the first task's terminal event lands.
    //
    //   2. `sameTaskTerminal` — the same task already has a TERMINAL
    //      mergeOrchestrator phase. Idempotency: a re-folded task.completed
    //      (replay scenario) must not regress the terminal phase back to
    //      'pending', otherwise next_actions would re-surface
    //      merge_orchestrate after a successful merge.
    const conflictsWithActiveOther =
      existing !== undefined &&
      existing.taskId !== taskId &&
      existing.phase === 'pending';
    const sameTaskTerminal =
      existing !== undefined &&
      existing.taskId === taskId &&
      existing.phase !== 'pending';
    if (!conflictsWithActiveOther && !sameTaskTerminal) {
      nextWorkflowState = {
        ...state.workflowState,
        phase: 'merge-pending',
        mergeOrchestrator: { taskId, phase: 'pending' },
      };
    }
  }
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    taskProgress: upsertTaskProgress(state.taskProgress, taskId, status),
    workflowState: nextWorkflowState,
  };
}

/**
 * Handler for `merge.executed` / `merge.rollback` / `merge.aborted` — exits
 * the `merge-pending` substate by stamping the terminal phase on
 * `mergeOrchestrator` and reverting `workflowState.phase` to `delegate`.
 *
 * The exit phase is derived from the event type (caller-provided). Mirrors
 * the HSM `mergePendingExit` guard in `workflow/hsm-definitions.ts` so the
 * rehydration projection observes the same lifecycle the HSM defines.
 */
function applyMergeTerminalEvent(
  state: RehydrationDocument,
  event: WorkflowEvent,
  terminalPhase: 'completed' | 'rolled-back' | 'aborted',
): RehydrationDocument {
  // No-op when there is nothing to terminate — protects replay over partial
  // streams (a rogue merge.* event without a preceding worktree task.completed
  // must not invent a mergeOrchestrator entry).
  const existing = state.workflowState.mergeOrchestrator;
  if (!existing) return state;
  // Idempotent no-op when this terminal event has already been folded — a
  // duplicate merge.executed / merge.rollback / merge.aborted at the same
  // taskId + terminalPhase must NOT bump projectionSequence, otherwise replay
  // count diverges from the truth-of-events count and downstream consumers
  // (snapshot cadence, fingerprint comparisons) observe phantom mutations.
  if (
    existing.phase === terminalPhase &&
    state.workflowState.phase === 'delegate'
  ) {
    return state;
  }
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    workflowState: {
      ...state.workflowState,
      phase: 'delegate',
      mergeOrchestrator: { taskId: existing.taskId, phase: terminalPhase },
    },
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
 * Handler for `workflow.checkpoint` — folds the optional `data.handoff`
 * sub-payload (#1240) into the volatile `latestHandoff` slot AND a bounded
 * sliding window `recentHandoffs` (max 3, most-recent-first).
 *
 * Empty-handoff events (no `handoff` sub-object, OR a `handoff` whose only
 * fields are missing/empty arrays) are intentionally folded as no-ops:
 * `projectionSequence` is NOT bumped, mirroring the "unhandled / unactionable"
 * convention used by the other handlers in this file. This keeps the
 * monotone-counter contract aligned with the truth-of-events count for
 * snapshot/fingerprint consumers.
 *
 * The entry's `eventRef` is keyed by `event.sequence` (#1246 v:2 contract;
 * post-#1230 sequence uniqueness guarantees this is a stable primary key) and
 * carries the source event's `timestamp` for human-readable audit. The v:2
 * schema (`HandoffEntrySchemaV2`, `.strict()` on the inner object) rejects an
 * `id` key, so this handler MUST NOT set one — the v:1 advisory `id` field is
 * gone (DR-Q-V2 strict deprecation).
 */
function applyWorkflowCheckpoint(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const handoff = extractHandoff(event.data);
  if (!handoff) {
    // No actionable handoff payload — return identity (no projectionSequence
    // bump). The non-handoff portion of `workflow.checkpoint` (counter, phase,
    // featureId) is not projected onto the rehydration document today.
    return state;
  }
  // Build the v:2 entry. `eventRef` carries ONLY {sequence, timestamp};
  // `HandoffEntrySchemaV2`'s `.strict()` enforces the no-`id` invariant at
  // the schema boundary, but we also avoid constructing one here.
  const entry: RehydrationDocument['recentHandoffs'][number] = {
    ...(handoff.context !== undefined ? { context: handoff.context } : {}),
    ...(handoff.nextSteps !== undefined ? { nextSteps: handoff.nextSteps } : {}),
    ...(handoff.suggestions !== undefined
      ? { suggestions: handoff.suggestions }
      : {}),
    eventRef: {
      sequence: event.sequence,
      timestamp: event.timestamp,
    },
    // #1242 — operator-authored provenance. An operator checkpoint ALWAYS
    // overwrites the slot (it is the higher-precedence source), and tagging it
    // lets a later `workflow.handoff_summarized` defer to it.
    source: 'operator',
  };
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    latestHandoff: entry,
    // Bounded sliding window — most-recent first; cap at 3 to bound the
    // rehydration envelope's token cost. Older entries naturally fall off as
    // new checkpoints land.
    recentHandoffs: [entry, ...state.recentHandoffs].slice(0, 3),
  };
}

/**
 * Handler for `workflow.handoff_summarized` (#1242) — folds the auto-summarized
 * handoff fallback, but ONLY when no operator-authored handoff currently holds
 * the `latestHandoff` slot. Operator-authored content (a `workflow.checkpoint`
 * handoff, tagged `source: 'operator'`) always takes precedence.
 *
 * Precedence rule (pure, replay-deterministic): the summary applies iff the
 * current `latestHandoff` is absent OR already `'auto'`. A legacy entry with no
 * `source` (only the checkpoint handler wrote handoffs pre-#1242) counts as
 * operator-authored and is therefore preserved. When the summary is suppressed,
 * this returns identity (no `projectionSequence` bump, no `recentHandoffs`
 * pollution) — matching the unactionable-event convention used throughout.
 *
 * The folded summary string comes verbatim from the stored event payload, so
 * replay reproduces the projection without re-invoking the (non-deterministic)
 * summarizer (INV-1 / Constraint 1 of #1242).
 */
function applyWorkflowHandoffSummarized(
  state: RehydrationDocument,
  event: WorkflowEvent,
): RehydrationDocument {
  const handoff = extractHandoff(event.data);
  if (!handoff) {
    // No actionable summary content — identity fold (no projectionSequence bump).
    return state;
  }
  // Operator precedence: defer to an operator-authored handoff already in the
  // slot. `source` absent (legacy) is treated as operator-authored.
  const current = state.latestHandoff;
  if (current !== undefined && current.source !== 'auto') {
    return state;
  }
  const entry: RehydrationDocument['recentHandoffs'][number] = {
    ...(handoff.context !== undefined ? { context: handoff.context } : {}),
    ...(handoff.nextSteps !== undefined ? { nextSteps: handoff.nextSteps } : {}),
    ...(handoff.suggestions !== undefined
      ? { suggestions: handoff.suggestions }
      : {}),
    eventRef: {
      sequence: event.sequence,
      timestamp: event.timestamp,
    },
    source: 'auto',
  };
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    latestHandoff: entry,
    recentHandoffs: [entry, ...state.recentHandoffs].slice(0, 3),
  };
}

/**
 * Decode the `data.handoff` subtree of a `workflow.checkpoint` event into
 * the projection-side handoff fields. Returns `undefined` when the event has
 * no handoff OR the handoff carries no actionable fields, so callers can
 * short-circuit without bumping `projectionSequence`.
 *
 * "Actionable" means at least one of: a non-empty `context` string, a
 * non-empty `nextSteps` array, or a non-empty `suggestions` array. An empty
 * array is treated identically to a missing field — empty handoff payloads
 * are written by hooks/auto-emitters under non-checkpoint flows and must
 * not generate noisy projection updates.
 */
interface ExtractedHandoff {
  readonly context?: string;
  // Mutable arrays here so that the assembled entry is assignable to
  // `RehydrationDocument['recentHandoffs'][number]` — the schema's `z.array()`
  // infers `string[]`, not `readonly string[]`. The reducer never mutates
  // these values; the mutability is a Zod-inferred-type requirement, not a
  // semantic one.
  readonly nextSteps?: string[];
  readonly suggestions?: string[];
}

function extractHandoff(
  data: WorkflowEvent['data'],
): ExtractedHandoff | undefined {
  if (!data) return undefined;
  const raw = data['handoff'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const h = raw as Record<string, unknown>;
  const context =
    typeof h['context'] === 'string' && h['context'].length > 0
      ? (h['context'] as string)
      : undefined;
  const nextSteps = Array.isArray(h['nextSteps'])
    ? (h['nextSteps'] as unknown[]).filter(
        (e): e is string => typeof e === 'string' && e.length > 0,
      )
    : undefined;
  const suggestions = Array.isArray(h['suggestions'])
    ? (h['suggestions'] as unknown[]).filter(
        (e): e is string => typeof e === 'string' && e.length > 0,
      )
    : undefined;

  // No actionable content → caller treats event as no-op (no projectionSequence
  // bump). An empty array post-filter counts the same as a missing field.
  const hasContext = context !== undefined;
  const hasNextSteps = nextSteps !== undefined && nextSteps.length > 0;
  const hasSuggestions = suggestions !== undefined && suggestions.length > 0;
  if (!hasContext && !hasNextSteps && !hasSuggestions) return undefined;

  // Normalise: drop empty-array fields so they don't surface as `[]` in the
  // projection — match the optional-field contract on HandoffEntrySchemaV2
  // (a missing field and an empty array carry the same "no entries" meaning).
  return {
    ...(hasContext ? { context } : {}),
    ...(hasNextSteps ? { nextSteps } : {}),
    ...(hasSuggestions ? { suggestions } : {}),
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
// list in workflow/playbooks.ts) derive their lists from a single source
// instead of maintaining independent copies that drift silently.
//
// "Recognises" is broader than "folds into projection state". A handler may
// either (a) fold the event into the rehydration document — `task.*` status
// changes upsert taskProgress entries — or (b) acknowledge the event as a
// known coordination/observability beat that bumps `projectionSequence` but
// otherwise leaves the document unchanged. Pattern (b) matters because
// hints + playbook need to advertise these coordination events to the model
// even when no document field tracks them; without recognition here they
// fall through the dispatcher's default branch and silently drift back out
// of the contract.
//
// Only `model`-source events belong in these lists: `PHASE_EXPECTED_EVENTS`
// throws at module load if a non-model event leaks through, and
// `gate.executed` (auto-emitted by withTelemetry) deliberately stays out of
// the playbook events surface since the model never emits it directly.

/**
 * Canonical model-emitted event contract for the `delegate` phase
 * (feature workflow).
 *
 * Fold semantics:
 *   - `task.assigned/completed/failed` upsert taskProgress entries (T023).
 *   - `team.*` and `task.progressed` are recognised coordination beats —
 *     handlers acknowledge them (so the dispatcher does not fall through
 *     to the default branch) but make no document mutation today. They are
 *     load-bearing for the SoT contract: hints/playbook advertise them to
 *     the model, and recognising them here keeps the three lists aligned.
 */
export const DELEGATE_PHASE_EVENT_TYPES = [
  'task.assigned',
  'task.completed',
  'task.failed',
  'team.spawned',
  'team.task.planned',
  'team.teammate.dispatched',
  'team.disbanded',
  'task.progressed',
] as const;

/**
 * Canonical model-emitted event contract for the `overhaul-delegate` phase
 * (refactor workflow). Mirrors {@link DELEGATE_PHASE_EVENT_TYPES} minus
 * `task.progressed` — the refactor-track delegation does not run TDD and
 * therefore does not emit per-phase progression beats.
 */
export const OVERHAUL_DELEGATE_PHASE_EVENT_TYPES = [
  'task.assigned',
  'task.completed',
  'task.failed',
  'team.spawned',
  'team.task.planned',
  'team.teammate.dispatched',
  'team.disbanded',
] as const;

export function getRegisteredEventTypes(phase: string): readonly string[] {
  switch (phase) {
    case 'delegate':
      return DELEGATE_PHASE_EVENT_TYPES;
    case 'overhaul-delegate':
      return OVERHAUL_DELEGATE_PHASE_EVENT_TYPES;
    default:
      return [];
  }
}

/**
 * Recognised-but-non-folding handler for delegate-phase coordination beats
 * (`team.*` events, `task.progressed`).
 *
 * Currently a no-op on document fields — these events are load-bearing for
 * the SoT contract (hints/playbook advertise them; recognition here keeps
 * the three lists aligned per #1180) but carry no projection mutation
 * today. We do NOT bump `projectionSequence` on these events: monotonicity
 * of that counter is reserved for events that actually mutate document
 * state (DR-3 contract for the rehydration projection). Returning identity
 * preserves the same "unhandled" structural-sharing semantic the
 * dispatcher's default branch uses.
 *
 * If a future change folds any of these into a document field, switch this
 * handler (or split it per event) to return a new state with an incremented
 * `projectionSequence` — the existing `task.*`/`workflow.*` handlers above
 * are the canonical pattern.
 */
function applyCoordinationEventNoOp(
  state: RehydrationDocument,
  _event: WorkflowEvent,
): RehydrationDocument {
  return state;
}

// ─── Reducer (thin dispatcher) ──────────────────────────────────────────────

export const rehydrationReducer: ProjectionReducer<RehydrationDocument, WorkflowEvent> = {
  id: 'rehydration@v1',
  version: 1,
  scope: 'stream' as const,
  initial: initialRehydrationDocument,
  apply(state: RehydrationDocument, event: WorkflowEvent): RehydrationDocument {
    // Dispatch by event.type, grouped below by event-type prefix. Unknown
    // event types short-circuit back to `state` unchanged (preserves the T022
    // identity contract for unhandled types and keeps `projectionSequence`
    // monotonic only over *handled* events).
    switch (event.type) {
      // ── task.* — taskProgress fold (T023) ─────────────────────────────────
      // Canonical vocabulary post #1359 / PR4 T11:
      //   task.assigned  → 'in_progress'  (was 'assigned')
      //   task.completed → 'complete'     (was 'completed')
      //   task.failed    → 'failed'
      // Aligned with `workflow/schemas.ts`' TaskSchema.status enum so a
      // rehydrate consumer can compare directly against canonical
      // `tasks[].status` without translation.
      case 'task.assigned':
        return applyTaskEvent(state, event, 'in_progress');
      case 'task.completed':
        return applyTaskEvent(state, event, 'complete');
      case 'task.failed':
        return applyTaskEvent(state, event, 'failed');

      // ── workflow.* — workflowState + blockers fold (T024, T025) ──────────
      case 'workflow.started':
        return applyWorkflowStarted(state, event);
      case 'workflow.transition':
        return applyWorkflowTransition(state, event);
      case 'workflow.guard-failed':
        return applyWorkflowGuardFailed(state, event);
      // workflow.checkpoint — handoff fold (T2 / #1240 / #1246, v:2 envelope)
      case 'workflow.checkpoint':
        return applyWorkflowCheckpoint(state, event);
      // workflow.handoff_summarized — auto-summary fallback (#1242). Operator
      // checkpoints take precedence; see applyWorkflowHandoffSummarized.
      case 'workflow.handoff_summarized':
        return applyWorkflowHandoffSummarized(state, event);

      // ── state.* — artifacts fold (T025) ──────────────────────────────────
      case 'state.patched':
        return applyStatePatched(state, event);

      // ── review.* — blockers fold (T025) ──────────────────────────────────
      case 'review.completed':
        return applyReviewCompleted(state, event);
      case 'review.escalated':
        return applyReviewEscalated(state, event);

      // ── merge.* — merge-orchestrator lifecycle (#1208 / DR-MO-1) ─────────
      case 'merge.executed':
        return applyMergeTerminalEvent(state, event, 'completed');
      case 'merge.rollback':
        return applyMergeTerminalEvent(state, event, 'rolled-back');
      case 'merge.aborted':
        return applyMergeTerminalEvent(state, event, 'aborted');

      // ── team.* + task.progressed — delegate-phase coordination beats ─────
      // Recognised by the SoT registry (DELEGATE_PHASE_EVENT_TYPES /
      // OVERHAUL_DELEGATE_PHASE_EVENT_TYPES) so that hints + playbook stay
      // aligned with the reducer's known event surface (#1180, DIM-3). No
      // document mutation today — see applyCoordinationEventNoOp for the
      // rationale and the upgrade path if a fold is added later.
      case 'team.spawned':
      case 'team.task.planned':
      case 'team.teammate.dispatched':
      case 'team.disbanded':
      case 'task.progressed':
        return applyCoordinationEventNoOp(state, event);

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

// ─── Derive NextAction[] from a ToolResult (T041, DR-8) ───────────────────
//
// All composite tools (`exarchos_workflow`, `exarchos_event`,
// `exarchos_orchestrate`, `exarchos_view`) go through this helper at their
// envelope-wrap boundary. When the handler's response data carries both
// `phase` and `workflowType` (as the real workflow handlers do — see
// `workflow/tools.ts` `handleInit` / `handleGet` / `handleSet`), the helper
// looks up the HSM for that workflow type and returns the outbound
// transitions computed by `computeNextActions`. Otherwise it yields `[]`.
//
// Unknown workflow types fall through to `[]` rather than throwing — the
// HSM registry is mutable (see `registerWorkflowType`), so stale references
// are possible and must not poison the envelope. Invoked at most once per
// composite call.

import { z } from 'zod';
import type { ToolResult } from './format.js';
import { logger } from './logger.js';
import type { NextAction } from './next-action.js';
import { computeNextActions, type AdmissionFacts } from './next-actions-computer.js';
import {
  RehydrationMergeOrchestratorSchema,
  WorkflowStateSchema,
} from './projections/rehydration/schema.js';
import { getHSMDefinition } from './workflow/state-machine.js';

/**
 * Structured logger child for fail-closed parse warnings (#1238).
 * Exported so unit tests can `vi.spyOn(nextActionsLogger, 'warn')` to assert
 * the malformed-payload fail-closed branch.
 */
export const nextActionsLogger = logger.child({ subsystem: 'next-actions' });

// ─── #1238 ResultDataSchema discriminated union ─────────────────────────────
//
// The parser body previously used `Record<string, unknown>` casts and inline
// `typeof` guards to dig phase / workflowType / featureId / mergeOrchestrator
// out of `result.data`. #1238 replaces that with a Zod union of two shapes so
// the contract is declarative and a malformed payload fails closed rather
// than silently degrading.
//
// `.passthrough()` keeps unknown sibling fields (handler payloads carry many
// extra fields — taskProgress, decisions, etc.) — we only validate the
// fields this helper reads.

/** Shape 1 — handler payload (`handleInit` / `handleGet` / `handleSet`). */
export const ShapeOneSchema = z
  .object({
    phase: z.string(),
    workflowType: z.string(),
    featureId: z.string().optional(),
    mergeOrchestrator: RehydrationMergeOrchestratorSchema.optional(),
    // ── DR-9 (T-13): the widened admission-fact surface ──────────────────────
    //
    // These four keys are what makes a payload a FULL workflow-state read
    // rather than a field projection or a phase-confirmation receipt, and they
    // are exactly the segments `Guard.evaluate(state)` / the admission
    // obligations read. They are declared as `unknown` ON PURPOSE: the
    // authority for their shape is the admission projector
    // (`workflow/admission/legacy-state-translation.ts::projectStateToFacts`),
    // and re-declaring it here would (a) fork the fact vocabulary and (b) turn
    // any state-schema evolution into a "malformed result.data" warning plus an
    // empty `next_actions` on a payload that is perfectly usable. Declaring
    // them keeps the widened contract visible in the parse; the structural
    // guard in `admissionFactsFrom` decides whether they are usable.
    updatedAt: z.unknown().optional(),
    artifacts: z.unknown().optional(),
    tasks: z.unknown().optional(),
    reviews: z.unknown().optional(),
  })
  .passthrough();

/** Shape 2 — rehydration document (`handleRehydrate`). */
export const ShapeTwoSchema = z
  .object({
    workflowState: WorkflowStateSchema,
  })
  .passthrough();

/**
 * The two recognised workflow-context payload shapes. A success-envelope
 * payload that carries a discriminator key but fails this union is treated
 * as malformed (warn + `[]`) at the fail-closed boundary in
 * `nextActionsFromResult`. Payloads without any discriminator key are
 * non-workflow responses (event-store / view composite / describe) and are
 * not parsed against this schema at all.
 */
export const ResultDataSchema = z.union([ShapeOneSchema, ShapeTwoSchema]);

export type ResultData = z.infer<typeof ResultDataSchema>;

/**
 * Per-shape discriminator keys. A payload is considered to *advertise* a
 * shape when it carries *every* discriminator key for that shape — matching
 * what the shape's schema actually requires. Once advertised, the shape must
 * validate strictly or the helper fails closed (warn + `[]`).
 *
 * Why `every` and not `some` (Sentry #1421 rev2, LOW): handler returns from
 * `handleCheckpoint` and the idempotent branch of `handleSet` legitimately
 * carry `{ phase, ... }` without `workflowType` — they are not workflow-state
 * envelopes, just phase-confirmation receipts. A `some`-based advertise
 * predicate would (mis)mark those as shape-1 advertisements, the strict
 * safeParse would then fail (missing required `workflowType`), and the
 * helper would emit a misleading "malformed result.data" warning on every
 * normal checkpoint/set call. `every` aligns the advertise check with the
 * schema's required-field set, so partial-key payloads silently fall through
 * to the no-actions path instead of being escalated to malformed.
 *
 * The asymmetric-failure pin still holds: a payload that advertises both
 * keys for shape 1 *and* the discriminator for shape 2 must validate against
 * both shapes independently.
 */
const SHAPE_ONE_DISCRIMINATOR_KEYS = ['phase', 'workflowType'] as const;
const SHAPE_TWO_DISCRIMINATOR_KEYS = ['workflowState'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * DR-9 (T-13) — extract the admission fact carrier from a shape-1 payload, or
 * `undefined` when the payload cannot support an admission verdict.
 *
 * A shape-1 payload is only usable as admission facts when it is a FULL state
 * read. `handleGet` serves three payload shapes off the same handler — full
 * state, a `fields:[…]` projection, and a dot-path `query` scalar — and the
 * first is the only one whose absent facts genuinely mean "absent". Projecting
 * `{phase, workflowType}` and handing THAT to admission would deny nearly every
 * edge (an unrequested artifact reads as a missing one), silently emptying the
 * affordance list on a read the caller deliberately narrowed. The four marker
 * keys below are present on every full state (`BaseWorkflowStateSchema` makes
 * them required) and absent from a projection that did not ask for them, so
 * they are a sound structural discriminator rather than a heuristic.
 *
 * `updatedAt` doubles as the trusted evaluation instant: it is already in the
 * payload, is a validated RFC3339 datetime on the write side, and keeps this
 * helper deterministic — no clock read, so the same payload always yields the
 * same affordances.
 *
 * `eventLogAvailable` is `false` unconditionally: `workflow/tools.ts` strips
 * `_events` from every handler payload (INTERNAL_FIELDS), so the event log is
 * never present at this seam. Edges decided from the log are therefore reported
 * undecidable and keep being advertised — see `adjudicateOutboundEdges`.
 */
function admissionFactsFrom(
  data: z.infer<typeof ShapeOneSchema>,
): AdmissionFacts | undefined {
  const { updatedAt, artifacts, tasks, reviews } = data;
  if (typeof updatedAt !== 'string' || updatedAt.trim().length === 0) {
    return undefined;
  }
  if (!isRecord(artifacts) || !Array.isArray(tasks) || !isRecord(reviews)) {
    return undefined;
  }
  return {
    state: data as Record<string, unknown>,
    evaluatedAt: updatedAt,
    eventLogAvailable: false,
  };
}

/**
 * Extract workflow state from a successful `ToolResult` and compute the
 * outbound `NextAction[]` for the current HSM phase. Returns `[]` whenever
 * the response lacks workflow context (describe/list/status actions,
 * event-store responses, view composites, etc.).
 *
 * Two payload shapes are recognised:
 *
 *   1. **Workflow-handler shape** (`handleInit` / `handleGet` / `handleSet`)
 *      — `{ phase, workflowType, ... }` carried at the top level.
 *   2. **Rehydration-envelope shape** (`handleRehydrate`'s
 *      `RehydrationDocument`) — `{ workflowState: { phase, workflowType,
 *      featureId, mergeOrchestrator } }` nested under the
 *      `workflowState` segment.
 *
 * Pre-fix (#1208) only shape 1 was extracted, so rehydrate envelopes always
 * yielded `next_actions: []` even when a `merge_orchestrate` verb was
 * required by `content/delivery/skills/delegate/SKILL.md` § "Worktree-Bearing Tasks:
 * Auto-Detour to merge-pending". Reading shape 2 lets the merge-pending
 * substate (set by the rehydration reducer when a worktree-bearing
 * task.completed is folded) drive `computeNextActions`'s
 * `merge_orchestrate` surfacing branch.
 */
export function nextActionsFromResult(result: ToolResult): readonly NextAction[] {
  // Legitimate no-actions paths — describe/list/status actions, error
  // envelopes, view composites. These MUST NOT warn: they're expected to be
  // empty.
  if (!result.success) return [];
  const data = result.data;
  if (data === null || data === undefined || typeof data !== 'object') return [];

  // Fail-closed parse boundary (#1238 + per-shape advertised-validation
  // follow-up). Four cases:
  //
  //   1. Payload advertises neither shape (no discriminator key from either
  //      set). It's an event-store / view-composite / describe response —
  //      return [] silently.
  //   2. Payload advertises a shape but that shape fails its own safeParse —
  //      malformed (wrong types, missing required nested fields). Warn and
  //      return [].
  //   3. Payload advertises exactly one shape and that shape parses — proceed
  //      using just that shape.
  //   4. Payload advertises both shapes and both parse — proceed using both
  //      (shape-1 precedence; shape-2 backfill for mergeOrchestrator).
  //
  // The earlier implementation used a single `ResultDataSchema` (union) parse
  // here, which accepted asymmetric malformed payloads — e.g. a valid shape-1
  // alongside a malformed `workflowState` — because the union short-circuits
  // on the first matching member. `.passthrough()` then let the bad keys
  // through. Validating each advertised shape independently closes that hole.
  //
  // `Reflect.has` is the structural attempt-detector; it does not introspect
  // value types (that's each shape's safeParse).
  const shapeOneAdvertised = SHAPE_ONE_DISCRIMINATOR_KEYS.every((k) =>
    Reflect.has(data, k),
  );
  const shapeTwoAdvertised = SHAPE_TWO_DISCRIMINATOR_KEYS.every((k) =>
    Reflect.has(data, k),
  );
  if (!shapeOneAdvertised && !shapeTwoAdvertised) return [];

  const shapeOne = shapeOneAdvertised ? ShapeOneSchema.safeParse(data) : null;
  const shapeTwo = shapeTwoAdvertised ? ShapeTwoSchema.safeParse(data) : null;

  if ((shapeOne && !shapeOne.success) || (shapeTwo && !shapeTwo.success)) {
    nextActionsLogger.warn(
      {
        issues: [
          ...(shapeOne && !shapeOne.success ? shapeOne.error.issues : []),
          ...(shapeTwo && !shapeTwo.success ? shapeTwo.error.issues : []),
        ],
        shapeOneAdvertised,
        shapeTwoAdvertised,
      },
      'malformed result.data — advertised shape failed safeParse; returning [].',
    );
    return [];
  }

  let phase: string | undefined;
  let workflowType: string | undefined;
  let featureId: string | undefined;
  let mergeOrchestrator: { taskId?: string; phase?: string } | undefined;
  let admission: AdmissionFacts | undefined;

  if (shapeOne?.success) {
    phase = shapeOne.data.phase;
    workflowType = shapeOne.data.workflowType;
    featureId = shapeOne.data.featureId;
    mergeOrchestrator = shapeOne.data.mergeOrchestrator;
    admission = admissionFactsFrom(shapeOne.data);
  }

  if (shapeTwo?.success) {
    const ws = shapeTwo.data.workflowState;
    if (!phase) phase = ws.phase;
    if (!workflowType) workflowType = ws.workflowType;
    if (!featureId) featureId = ws.featureId;
    if (mergeOrchestrator === undefined && ws.mergeOrchestrator !== undefined) {
      mergeOrchestrator = ws.mergeOrchestrator;
    }
    // DR-9 SPLIT (recorded, not an oversight): the rehydration document is NOT
    // widened here. Its `workflowState` segment carries only featureId / phase /
    // workflowType / mergeOrchestrator, and the sibling sections expose
    // `artifacts` + `taskProgress` but no `reviews`, no `_cleanup` and no event
    // log — so an admission verdict computed from it would deny every
    // review-gated edge on evidence that exists but was never serialized. That
    // is the unsafe direction (hiding legal moves), so shape 2 stays
    // topology-only until the envelope itself carries the facts, which is a
    // RehydrationDocument schema rev (v:4 → v:5) and out of this task's scope.
  }

  if (!phase || !workflowType) return [];

  let hsm;
  try {
    hsm = getHSMDefinition(workflowType);
  } catch {
    return [];
  }

  return computeNextActions(
    { phase, workflowType, featureId, mergeOrchestrator, admission },
    hsm,
  );
}

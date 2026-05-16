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
import { computeNextActions } from './next-actions-computer.js';
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
 * Per-shape discriminator keys. A payload carrying any key from one of these
 * sets is *advertising* that shape; if it advertises a shape, that shape must
 * validate strictly. This is the asymmetric-failure pin for the union
 * (#1238 follow-up): without per-shape advertised-validation, a payload that
 * satisfies shape 1 but advertises a malformed shape 2 (or vice versa) would
 * slip through the loose union safeParse and silently degrade.
 */
const SHAPE_ONE_DISCRIMINATOR_KEYS = ['phase', 'workflowType'] as const;
const SHAPE_TWO_DISCRIMINATOR_KEYS = ['workflowState'] as const;

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
 * required by `skills-src/delegation/SKILL.md` § "Worktree-Bearing Tasks:
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
  const shapeOneAdvertised = SHAPE_ONE_DISCRIMINATOR_KEYS.some((k) =>
    Reflect.has(data, k),
  );
  const shapeTwoAdvertised = SHAPE_TWO_DISCRIMINATOR_KEYS.some((k) =>
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

  if (shapeOne?.success) {
    phase = shapeOne.data.phase;
    workflowType = shapeOne.data.workflowType;
    featureId = shapeOne.data.featureId;
    mergeOrchestrator = shapeOne.data.mergeOrchestrator;
  }

  if (shapeTwo?.success) {
    const ws = shapeTwo.data.workflowState;
    if (!phase) phase = ws.phase;
    if (!workflowType) workflowType = ws.workflowType;
    if (!featureId) featureId = ws.featureId;
    if (mergeOrchestrator === undefined && ws.mergeOrchestrator !== undefined) {
      mergeOrchestrator = ws.mergeOrchestrator;
    }
  }

  if (!phase || !workflowType) return [];

  let hsm;
  try {
    hsm = getHSMDefinition(workflowType);
  } catch {
    return [];
  }

  return computeNextActions(
    { phase, workflowType, featureId, mergeOrchestrator },
    hsm,
  );
}

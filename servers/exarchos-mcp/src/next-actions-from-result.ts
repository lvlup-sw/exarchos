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
import type { NextAction } from './next-action.js';
import { computeNextActions } from './next-actions-computer.js';
import {
  RehydrationMergeOrchestratorSchema,
  WorkflowStateSchema,
} from './projections/rehydration/schema.js';
import { getHSMDefinition } from './workflow/state-machine.js';

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
 * Discriminated by structure: ShapeOne carries top-level `phase` /
 * `workflowType`; ShapeTwo nests them inside `workflowState`. A payload that
 * matches both (a handler payload that also carries a `workflowState`
 * sibling) parses as ShapeOne by virtue of union order — the top-level
 * extraction is preserved and the workflowState segment is read for
 * `mergeOrchestrator` backfill via a separate ShapeTwo parse downstream.
 */
export const ResultDataSchema = z.union([ShapeOneSchema, ShapeTwoSchema]);

export type ResultData = z.infer<typeof ResultDataSchema>;

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

  // Fail-closed parse boundary (#1238). A success payload that's a non-null
  // object but matches NEITHER shape is malformed — warn so the contract
  // violation is surfaced rather than silently degrading to []. The two
  // shapes are intentionally permissive (`.passthrough()`), so this only
  // triggers on genuinely unexpected payloads (e.g. handler returned wrong
  // types on phase / workflowType, or workflowState missing featureId).
  const parsed = ResultDataSchema.safeParse(data);
  if (!parsed.success) {
    console.warn(
      '[next-actions] malformed result.data — failed ResultDataSchema parse; returning [].',
      { issues: parsed.error.issues },
    );
    return [];
  }

  // The union parses non-greedily on the first matching shape. To preserve
  // the existing semantics — shape-1 fields take precedence; mergeOrchestrator
  // backfilled from workflowState even when shape 1 supplies phase — read
  // both shapes independently. Both safeParses are cheap (the data already
  // matched at least one shape).
  const shapeOne = ShapeOneSchema.safeParse(data);
  const shapeTwo = ShapeTwoSchema.safeParse(data);

  let phase: string | undefined;
  let workflowType: string | undefined;
  let featureId: string | undefined;
  let mergeOrchestrator: { taskId?: string; phase?: string } | undefined;

  if (shapeOne.success) {
    phase = shapeOne.data.phase;
    workflowType = shapeOne.data.workflowType;
    featureId = shapeOne.data.featureId;
    mergeOrchestrator = shapeOne.data.mergeOrchestrator;
  }

  if (shapeTwo.success) {
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

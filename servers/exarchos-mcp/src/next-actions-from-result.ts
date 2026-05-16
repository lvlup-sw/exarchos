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
  if (!result.success) return [];
  const data = result.data;
  if (data === null || typeof data !== 'object') return [];

  const dataRecord = data as Record<string, unknown>;
  // Shape 1 — workflow-handler payload.
  let phase = typeof dataRecord.phase === 'string' ? dataRecord.phase : undefined;
  let workflowType =
    typeof dataRecord.workflowType === 'string' ? dataRecord.workflowType : undefined;
  let featureId =
    typeof dataRecord.featureId === 'string' ? dataRecord.featureId : undefined;
  let mergeOrchestrator: { taskId?: string; phase?: string } | undefined;
  if (
    typeof dataRecord.mergeOrchestrator === 'object' &&
    dataRecord.mergeOrchestrator !== null
  ) {
    const mo = dataRecord.mergeOrchestrator as Record<string, unknown>;
    mergeOrchestrator = {
      ...(typeof mo.taskId === 'string' ? { taskId: mo.taskId } : {}),
      ...(typeof mo.phase === 'string' ? { phase: mo.phase } : {}),
    };
  }

  // Shape 2 — rehydration document. Backfill any field shape 1 did not
  // populate. Read `mergeOrchestrator` regardless of whether shape 1 had
  // phase/workflowType: handler payloads (shape 1) carry phase + workflowType
  // at the top level but typically NOT mergeOrchestrator; that field lives on
  // the workflowState segment. Without this backfill, a payload with both
  // top-level phase + nested workflowState.mergeOrchestrator would drop the
  // merge-orchestration context and miss `merge_orchestrate` in next_actions.
  if (typeof dataRecord.workflowState === 'object' && dataRecord.workflowState !== null) {
    const ws = dataRecord.workflowState as Record<string, unknown>;
    if (!phase && typeof ws.phase === 'string') phase = ws.phase;
    if (!workflowType && typeof ws.workflowType === 'string') {
      workflowType = ws.workflowType;
    }
    if (!featureId && typeof ws.featureId === 'string') featureId = ws.featureId;
    if (
      mergeOrchestrator === undefined &&
      typeof ws.mergeOrchestrator === 'object' &&
      ws.mergeOrchestrator !== null
    ) {
      const mo = ws.mergeOrchestrator as Record<string, unknown>;
      mergeOrchestrator = {
        ...(typeof mo.taskId === 'string' ? { taskId: mo.taskId } : {}),
        ...(typeof mo.phase === 'string' ? { phase: mo.phase } : {}),
      };
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

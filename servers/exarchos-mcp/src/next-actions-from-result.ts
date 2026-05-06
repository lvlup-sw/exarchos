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

import type { ToolResult } from './format.js';
import type { NextAction } from './next-action.js';
import { computeNextActions } from './next-actions-computer.js';
import { getHSMDefinition } from './workflow/state-machine.js';

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

  // Shape 2 — rehydration document. Only consulted when the top-level
  // shape did not carry phase / workflowType, so the cheaper (and far
  // more common) handler shape is preferred when both could match.
  if ((!phase || !workflowType) && typeof dataRecord.workflowState === 'object'
      && dataRecord.workflowState !== null) {
    const ws = dataRecord.workflowState as Record<string, unknown>;
    if (!phase && typeof ws.phase === 'string') phase = ws.phase;
    if (!workflowType && typeof ws.workflowType === 'string') {
      workflowType = ws.workflowType;
    }
    if (!featureId && typeof ws.featureId === 'string') featureId = ws.featureId;
    if (typeof ws.mergeOrchestrator === 'object' && ws.mergeOrchestrator !== null) {
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

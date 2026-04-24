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
 */
export function nextActionsFromResult(result: ToolResult): readonly NextAction[] {
  if (!result.success) return [];
  const data = result.data;
  if (data === null || typeof data !== 'object') return [];

  const dataRecord = data as Record<string, unknown>;
  const phase = typeof dataRecord.phase === 'string' ? dataRecord.phase : undefined;
  const workflowType =
    typeof dataRecord.workflowType === 'string' ? dataRecord.workflowType : undefined;

  if (!phase || !workflowType) return [];

  let hsm;
  try {
    hsm = getHSMDefinition(workflowType);
  } catch {
    return [];
  }

  return computeNextActions({ phase, workflowType }, hsm);
}

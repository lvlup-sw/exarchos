// ─── Module-Level EventStore (removed — now threaded via DispatchContext) ─────

// ─── Module-Level ViewMaterializer (removed) ─────────────────────────────────
//
// `moduleViewMaterializer` was a settable singleton that gated the ES v2 read
// and snapshot paths. Nothing in `src/` ever set it, so both paths were dark in
// the shipped composition: `workflow get` always fell through to the state
// file, and `get --asOf` silently answered with tip state. A control whose
// enabling call exists only in tests is not a seam, it is an off switch nobody
// can reach.
//
// `handleGet` / `handleSet` now resolve `getOrCreateMaterializer(stateDir)`
// directly. That is per-stateDir rather than process-global, shares one fold
// cache with the view surface, and cannot be left unwired.
// `tests/architecture/reachable-controls.test.ts` keeps the class closed.

// Re-export from dedicated modules for backward compatibility
export { handleCancel } from '../cancel.js';
export { handleSummary, handleReconcile, handleTransitions } from '../query.js';

// ─── Internal Field Stripping ────────────────────────────────────────────────

const INTERNAL_FIELDS = ['_events', '_eventSequence', '_history'] as const;

export function stripInternalFields(state: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...state };
  for (const field of INTERNAL_FIELDS) {
    delete stripped[field];
  }
  return stripped;
}

// ─── Event-Sourcing Version Discriminator ───────────────────────────────────

export const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
export function isEventSourced(state: unknown): boolean {
  if (typeof state !== 'object' || state === null) return false;
  if (!('_esVersion' in state)) return false;
  return state._esVersion === CURRENT_ES_VERSION;
}

// ─── Workflow Risk Tier (review-gate path, R5) ──────────────────────────────
//
// DR-10 (T-14): the local `resolveWorkflowRiskTier` shim is retired. It read
// the raw stamp and left every call site to coerce it, which is how the
// weakest-coordinate collapse (`rawTier === 'high' ? … : 'low'`) got written.
// Both call sites now use `resolveRiskTier` from
// `verification-policy-resolver.ts` — the single authority for turning an
// untrusted stamp into a tier claim, which returns `'unknown'` rather than
// fabricating one.

import {
  workflowStateProjection,
} from '../../projections/views/workflow-state-projection.js';
import type { WorkflowState } from '../types.js';

// ─── The state file's half of the answer ─────────────────────────────────────

/**
 * Fields the state file owns, which the projection cannot supply.
 *
 * Both are declared in the projection's shape and neither is reconstructible
 * from the log. `_version` is the file's optimistic-lock counter and the
 * projection carries a dead literal `1`, so serving the fold's value would hand
 * a caller a version that CAS rejects. `_checkpoint` is only partly
 * event-derived — `workflow.checkpoint` sets four of its fields and nothing
 * sets `summary`, `fixCycleCount` or `staleAfterMinutes` — so the fold answers
 * with sentinels where the file holds the real entry.
 */
export const FILE_OWNED_FIELDS: ReadonlySet<string> = new Set(['_version', '_checkpoint']);

/**
 * The event fold, plus what only the state file knows.
 *
 * The log is the source of truth for everything it can derive, so the fold is
 * the base and wins every contested field. The file contributes exactly two
 * things: the fields above, and any key the projection has no slot for at all —
 * the "plan facts the projection can't derive" that the state-file contract
 * names.
 *
 * The second half is DERIVED from `workflowStateProjection.init()` rather than
 * listed, so a state field the projection does not model is carried through
 * automatically instead of disappearing the day someone adds one.
 *
 * Read and write share this because they fail the same way. `handleGet` serving
 * the bare fold would drop `_version`, `_checkpoint`, `_esVersion` and
 * `explore` from the response; `handleSet` stamping the bare fold would delete
 * the same fields from the file, so the next read could not recover them
 * either. Both paths were unreachable until the materializer was wired, which
 * is why neither had to answer the question before.
 */
export function mergeFileOwnedFields(
  materialized: Record<string, unknown>,
  fileState: WorkflowState,
): Record<string, unknown> {
  const modelled = new Set(Object.keys(workflowStateProjection.init()));
  const merged: Record<string, unknown> = { ...materialized };
  for (const [key, value] of Object.entries(fileState)) {
    if (!modelled.has(key) || FILE_OWNED_FIELDS.has(key)) merged[key] = value;
  }
  return merged;
}

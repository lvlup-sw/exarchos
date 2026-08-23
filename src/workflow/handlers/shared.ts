import type { ViewMaterializer } from '../../projections/views/materializer.js';

// ─── Module-Level EventStore (removed — now threaded via DispatchContext) ─────

// ─── Module-Level ViewMaterializer Configuration ─────────────────────────────

export let moduleViewMaterializer: ViewMaterializer | null = null;

/** Configure the ViewMaterializer instance used by handleGet for ES v2 workflows. */
export function configureWorkflowMaterializer(materializer: ViewMaterializer | null): void {
  moduleViewMaterializer = materializer;
}

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

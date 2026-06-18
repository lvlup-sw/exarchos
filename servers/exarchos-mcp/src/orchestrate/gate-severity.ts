// ─── Gate Severity Resolution ───────────────────────────────────────────────
//
// Resolves the effective severity for a quality gate by layering gate-level
// overrides on top of dimension-level settings from project config.
// ─────────────────────────────────────────────────────────────────────────────

import type { ResolvedProjectConfig } from '../config/resolve.js';
import { VERIFICATION_GATE_NAMES } from '../workflow/verification-policy.js';

type DimensionKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
type Severity = 'blocking' | 'warning' | 'disabled';

/**
 * Per-workflow default severity for verification-LADDER gates (task 005).
 *
 * A DATA TABLE — not branching prose — mapping a workflow type to the severity
 * its ladder-gate failures resolve to by default. `oneshot` workflows are quick,
 * low-ceremony fixes where a ladder-gate miss should advise (warning), not block.
 * Keeping this a table means future workflow types are a single-line ADDITION,
 * never new control flow in {@link resolveGateSeverity}.
 *
 * Scope: this default ONLY applies to gates named in `VERIFICATION_GATE_NAMES`
 * (the single source of truth) and is ALWAYS beaten by an explicit
 * `review.gates[gateName]` override — a consumer who pins a gate wins.
 *
 * SEVERITY (advisory vs blocking) is one of the two workflow-keyed axes the
 * IMPLEMENT-phase obligation surface composes; the orthogonal MODE axis
 * (audit→enforce graduation) is `IMPLEMENT_PHASE_MODE` in `gate-utils.ts` (DR-6).
 * Both are workflow-specific — NOT kind-universal — so neither belongs in
 * `KIND_OBLIGATIONS` (INV-6).
 */
export const WORKFLOW_DEFAULT_SEVERITY: Readonly<Record<string, 'warning'>> =
  Object.freeze({ oneshot: 'warning' });

/** The ladder-gate name set, as a Set for O(1) membership (SoT is the tuple). */
const LADDER_GATE_NAMES: ReadonlySet<string> = new Set(VERIFICATION_GATE_NAMES);

/**
 * Resolves the effective severity for a named gate within a dimension.
 *
 * Resolution order (highest precedence first):
 * 1. Gate-level override (`review.gates[gateName]`)
 * 2. Explicit dimension disable (`review.dimensions[dimension].enabled === false`
 *    → `'disabled'`) — an explicit project off is a stronger statement than any
 *    convention default and must win over the per-workflow ladder default below.
 * 3. Per-workflow ladder default: when `workflowType` is supplied, the gate is
 *    a verification-ladder gate, AND `WORKFLOW_DEFAULT_SEVERITY[workflowType]`
 *    is defined → that severity (e.g. oneshot → warning).
 * 4. Dimension-level severity (`review.dimensions[dimension].severity`)
 * 5. Default: `'blocking'` (unknown dimensions)
 *
 * Omitting `workflowType` reproduces the pre-task-005 behavior exactly, so
 * legacy callers are unaffected.
 */
export function resolveGateSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig,
  workflowType?: string,
): Severity {
  // Gate-level override takes precedence — an explicit pin always wins, even
  // over the per-workflow ladder default below.
  const gateOverride = config.review.gates[gateName];
  if (gateOverride) {
    if (!gateOverride.enabled) return 'disabled';
    return gateOverride.blocking ? 'blocking' : 'warning';
  }

  // An EXPLICIT dimension disable is a stronger statement than any convention
  // default: a consumer who pins `enabled: false` means "never run this gate".
  // Checked BEFORE the per-workflow ladder default so that a project which
  // disabled (e.g.) D1/D2 does not still see ladder gates execute as warning-only
  // under an oneshot workflow.
  const dimKey = dimension as DimensionKey;
  const dimConfig = config.review.dimensions[dimKey];
  if (dimConfig && !dimConfig.enabled) return 'disabled';

  // Per-workflow ladder default: applies ONLY to verification-ladder gates and
  // ONLY when the workflow type has a table entry. Data-driven so adding a
  // workflow type is an entry in WORKFLOW_DEFAULT_SEVERITY, not a code branch.
  if (workflowType !== undefined && LADDER_GATE_NAMES.has(gateName)) {
    const workflowDefault = WORKFLOW_DEFAULT_SEVERITY[workflowType];
    if (workflowDefault !== undefined) return workflowDefault;
  }

  // Fall back to dimension-level severity.
  if (!dimConfig) return 'blocking'; // unknown dimension defaults to blocking
  return dimConfig.severity;
}

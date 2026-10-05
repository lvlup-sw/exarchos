/**
 * Resolves the effective severity of a quality gate. Gate-level overrides
 * take precedence over dimension-level settings from the project config.
 */

import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { VERIFICATION_GATE_NAMES } from '../../workflow/verification-policy.js';

type DimensionKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
type Severity = 'blocking' | 'warning' | 'disabled';

/**
 * Default severity for verification-ladder gates, keyed by workflow type. For
 * `oneshot`, a ladder-gate miss gives a warning, not a block. The default
 * applies only to gates in `VERIFICATION_GATE_NAMES`. A gate-level override or
 * a disabled dimension takes precedence. This axis is workflow-specific, so it
 * is not in `KIND_OBLIGATIONS`. The mode axis is `IMPLEMENT_PHASE_MODE` in
 * `gate-utils.ts`.
 */
export const WORKFLOW_DEFAULT_SEVERITY: Readonly<Record<string, 'warning'>> =
  Object.freeze({ oneshot: 'warning' });

/** The ladder-gate names as a Set. `VERIFICATION_GATE_NAMES` is the source. */
const LADDER_GATE_NAMES: ReadonlySet<string> = new Set(VERIFICATION_GATE_NAMES);

/**
 * Resolves the effective severity for a named gate within a dimension.
 *
 * Resolution order (highest precedence first):
 * 1. Gate-level override (`review.gates[gateName]`).
 * 2. Explicit dimension disable (`enabled === false`) gives `'disabled'`. It
 *    beats the ladder default, so `oneshot` does not turn a disabled gate into
 *    a warning.
 * 3. Per-workflow ladder default, when `workflowType` is given, the gate is a
 *    ladder gate, and `WORKFLOW_DEFAULT_SEVERITY` has an entry.
 * 4. Dimension-level severity (`review.dimensions[dimension].severity`).
 * 5. `'blocking'` for an unknown dimension.
 */
export function resolveGateSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig,
  workflowType?: string,
): Severity {
  const gateOverride = config.review.gates[gateName];
  if (gateOverride) {
    if (!gateOverride.enabled) return 'disabled';
    return gateOverride.blocking ? 'blocking' : 'warning';
  }

  const dimKey = dimension as DimensionKey;
  const dimConfig = config.review.dimensions[dimKey];
  if (dimConfig && !dimConfig.enabled) return 'disabled';

  if (workflowType !== undefined && LADDER_GATE_NAMES.has(gateName)) {
    const workflowDefault = WORKFLOW_DEFAULT_SEVERITY[workflowType];
    if (workflowDefault !== undefined) return workflowDefault;
  }

  if (!dimConfig) return 'blocking';
  return dimConfig.severity;
}

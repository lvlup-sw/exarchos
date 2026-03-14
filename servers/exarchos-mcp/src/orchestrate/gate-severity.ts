// ─── Gate Severity Resolution ───────────────────────────────────────────────
//
// Resolves the effective severity for a quality gate by layering gate-level
// overrides on top of dimension-level settings from project config.
// ─────────────────────────────────────────────────────────────────────────────

import type { ResolvedProjectConfig } from '../config/resolve.js';

type DimensionKey = 'D1' | 'D2' | 'D3' | 'D4' | 'D5';
type Severity = 'blocking' | 'warning' | 'disabled';

/**
 * Resolves the effective severity for a named gate within a dimension.
 *
 * Resolution order (highest precedence first):
 * 1. Gate-level override (`review.gates[gateName]`)
 * 2. Dimension-level setting (`review.dimensions[dimension]`)
 * 3. Default: `'blocking'` (unknown dimensions)
 */
export function resolveGateSeverity(
  gateName: string,
  dimension: string,
  config: ResolvedProjectConfig,
): Severity {
  // Gate-level override takes precedence
  const gateOverride = config.review.gates[gateName];
  if (gateOverride) {
    if (!gateOverride.enabled) return 'disabled';
    return gateOverride.blocking ? 'blocking' : 'warning';
  }

  // Fall back to dimension-level setting
  const dimKey = dimension as DimensionKey;
  const dimConfig = config.review.dimensions[dimKey];
  if (!dimConfig) return 'blocking'; // unknown dimension defaults to blocking
  if (!dimConfig.enabled) return 'disabled';
  return dimConfig.severity;
}

// Maps the frozen `designDepth` of a feature to an ordered sequence of plan-structure gate names.
// This module is the single source of truth for that mapping. The `'plan-structure'` gate
// resolver and every other consumer must call `resolvePlanDepthPolicy` and not hardcode a gate list.
// It is the depth-axis twin of `BASE_SEQUENCE_BY_TIER` in `verification-policy.ts`.
//
// The table is pure and frozen. The module does no I/O and reads no configuration file.
// A future override layer composes on top of this table and does not replace it.
//
// The `'standard'` rung must equal the static `'plan-structure'` binding: the registry
// `PLAN_PHASES` set, in plan-validation order. This equality keeps the default depth
// behavior-neutral. `thin` is a strict prefix of `standard`, and `deep` adds an exploration obligation.

import type { ResolvedProjectConfig } from '../config/resolve.js';

/** Ordered planning depth for the design+plan-collapse ladder (thin ⊂ standard ⊂ deep). */
export type DesignDepth = 'thin' | 'standard' | 'deep';

/**
 * Every plan-structure gate name that a depth sequence can hold.
 * Consumers type their gate code against `PlanDepthGateName`, so a typo fails at compile time.
 * The first five names are the registry `PLAN_PHASES` set. `check_exploration_depth` runs only at `deep`.
 */
export const PLAN_DEPTH_GATE_NAMES = [
  'check_task_decomposition',
  'check_plan_coverage',
  'spec_coverage_check',
  'check_provenance_chain',
  'generate_traceability',
  'check_exploration_depth',
] as const;

/** Union of every plan-structure gate name appearing in the depth policy table. */
export type PlanDepthGateName = (typeof PLAN_DEPTH_GATE_NAMES)[number];

/**
 * The base plan-structure sequence for each design depth. It reads no configuration.
 * Each higher rung is a strict superset of the rung below it.
 * `ResolvePlanDepthPolicy_ThinSubsetOfStandardSubsetOfDeep_Holds` pins this structure cell by cell.
 */
const BASE_SEQUENCE_BY_DEPTH: Readonly<Record<DesignDepth, readonly PlanDepthGateName[]>> =
  Object.freeze({
    thin: Object.freeze(['check_task_decomposition', 'check_plan_coverage'] as const),
    standard: Object.freeze([
      'check_task_decomposition',
      'check_plan_coverage',
      'spec_coverage_check',
      'check_provenance_chain',
      'generate_traceability',
    ] as const),
    deep: Object.freeze([
      'check_task_decomposition',
      'check_plan_coverage',
      'spec_coverage_check',
      'check_provenance_chain',
      'generate_traceability',
      'check_exploration_depth',
    ] as const),
  });

/** A resolved plan-depth sequence (shape mirrors the verification policy's `{ sequence }`). */
export interface ResolvedPlanDepthPolicy {
  /** Ordered, frozen plan-structure gate sequence for the requested design depth. */
  readonly sequence: readonly PlanDepthGateName[];
}

/**
 * Returns the frozen plan-structure gate sequence for a design depth. It does no I/O.
 * `config` is the only configuration source for a future override layer. `ResolvedProjectConfig` has no such override, so the function ignores it.
 * @throws when `designDepth` is not in the table.
 */
export function resolvePlanDepthPolicy(
  designDepth: DesignDepth,
  config?: ResolvedProjectConfig,
): ResolvedPlanDepthPolicy {
  void config;

  const sequence = BASE_SEQUENCE_BY_DEPTH[designDepth];
  if (sequence === undefined) {
    throw new Error(
      `resolvePlanDepthPolicy: unknown designDepth '${String(designDepth)}' ` +
        `(expected one of ${Object.keys(BASE_SEQUENCE_BY_DEPTH).join(', ')})`,
    );
  }

  return { sequence };
}

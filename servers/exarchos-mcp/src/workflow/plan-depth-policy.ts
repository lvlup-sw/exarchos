// ─── Planning-Depth Policy (Single Source of Truth) ─────────────────────────
//
// The planning-depth ladder maps a feature's frozen `designDepth` to an ORDERED
// sequence of plan-structure gate names. This module is the single source of
// truth for that mapping — the `'plan-structure'` gate resolver and every
// consumer that describes "which plan-structure gates run at this depth" MUST
// reference `resolvePlanDepthPolicy` rather than hardcoding gate lists. It is
// the depth-axis twin of `verification-policy.ts`'s `BASE_SEQUENCE_BY_TIER`
// (the risk-tier axis): same const-table idiom, same strict-superset rungs,
// same purity contract.
//
// ── NO CONFIG READS, NO I/O (mirror of verification-policy R2 boundary) ─────
// This module is a pure, frozen table. It performs NO I/O — it does not read
// the project config file, the config loader, or the filesystem. The threaded
// `ResolvedProjectConfig` is the ONLY config source the function may read; the
// base rungs are config-blind by design, and the consumer-override layer (a
// future resolver sibling, mirroring `verification-policy-resolver.ts`)
// composes ON TOP of this table rather than replacing it. Keeping the base
// table config-free makes the rungs deterministic and unit-testable in
// isolation.
//
// ── Behavior-neutral default (DR-2) ─────────────────────────────────────────
// The `'standard'` rung MUST equal today's static 5-gate `'plan-structure'`
// binding (the registry `PLAN_PHASES` set, in plan-validation order). That
// equality is the load-bearing pin: graduating `GATE_RESOLVERS['plan-structure']`
// to read `ctx.designDepth` (task 003) must NOT change behavior at the default
// depth. `thin` is a strict prefix of `standard`; `deep` is `standard` plus an
// exploration obligation.
// ────────────────────────────────────────────────────────────────────────────

import type { ResolvedProjectConfig } from '../config/resolve.js';

/** Ordered planning depth for the design+plan-collapse ladder (thin ⊂ standard ⊂ deep). */
export type DesignDepth = 'thin' | 'standard' | 'deep';

/**
 * The complete set of plan-structure gate names that may appear in any
 * depth sequence. `PlanDepthGateName` is the union derived from this tuple;
 * consumers type their gate handling against it so a typo or an out-of-table
 * name fails at compile time. The first five names are the registry
 * `PLAN_PHASES` set (pinned == today's static binding at `'standard'`);
 * `check_exploration_depth` is the deep-only exploration obligation (DR-7).
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
 * Base plan-structure sequence per design depth (config-blind).
 * Each higher rung is a strict superset of the lower rung's sequence:
 *   thin     → decomposition + coverage (minimal preamble)
 *   standard → + spec coverage + provenance + traceability  (== today's static
 *              `PLAN_PHASES` binding; behavior-neutral default)
 *   deep     → + exploration obligation (the DR-7 divergent-loop rung)
 *
 * The superset structure is intentional and is pinned cell-by-cell by
 * `ResolvePlanDepthPolicy_ThinSubsetOfStandardSubsetOfDeep_Holds` — mirror of
 * the verification-policy superset test.
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
 * Resolve the ordered plan-structure gate sequence for a feature's design depth.
 *
 * Pure and synchronous: it does NO I/O. The threaded `config` argument is the
 * ONLY config source — the function reads the plan-depth overlay (if any) from
 * it via optional-chaining and NEVER reaches the filesystem or a config loader.
 * No plan-depth overlay seam exists on `ResolvedProjectConfig` yet, so today the
 * read always degrades to the config-blind base table; the optional-chain is the
 * forward-compatible seam the consumer-override layer fills, mirroring how
 * `verification-policy-resolver.ts` reads `config?.verification?.policy`. The
 * base sequence is already frozen by `Object.freeze`, so it is never aliased to
 * a caller-mutable array.
 *
 * @param designDepth the feature's frozen planning depth (thin ⊂ standard ⊂ deep)
 * @param config      the resolved project config (threaded overlay source); the
 *                    sole config seam — read by optional-chain, never the
 *                    filesystem. Absent / partial ⇒ the config-blind base table
 * @returns an immutable, ordered plan-structure gate sequence for the depth
 */
export function resolvePlanDepthPolicy(
  designDepth: DesignDepth,
  config?: ResolvedProjectConfig,
): ResolvedPlanDepthPolicy {
  // Forward-compatible overlay read: the plan-depth override seam is consulted
  // ONLY through the threaded config (never the filesystem). No such overlay
  // field exists on `ResolvedProjectConfig` today, so this degrades to the
  // base table — but it pins the config-read seam to the argument, exactly as
  // `verification-policy-resolver.ts` optional-chains `config?.verification`.
  void config;

  return { sequence: BASE_SEQUENCE_BY_DEPTH[designDepth] };
}

// ─── Verification Policy (Single Source of Truth) ───────────────────────────
//
// The verification ladder maps a task's (riskTier, boundaryTouching) profile to
// an ORDERED sequence of verification gate names. This module is the single
// source of truth for that mapping — the delegation classifier, the phase
// playbook, and every consumer that describes "which gates run for a task" MUST
// reference `resolveVerificationSequence` rather than hardcoding gate lists.
// Mirrors the `review-contract.ts` const-table pattern.
//
// ── R2 BOUNDARY (#1517): NO CONFIG READS ───────────────────────────────────
// This module is a pure, frozen table. It reads NO config — not the project
// config file, not the config loader, not the filesystem. Config-resolved gate
// overrides (e.g. a consumer adding/removing a gate per repo) are explicitly
// out of scope here and tracked as R2 (#1517). Keeping this module config-free
// makes the base policy deterministic and unit-testable in isolation; the
// override layer composes ON TOP of this table, it does not replace it.
//
// ── Gate registration status ───────────────────────────────────────────────
// `check_static_analysis` and `check_integration_suite` are already registered
// orchestrate actions. `check_test_adequacy` (task 014), `check_contract_drift`
// (task 023), and `check_mock_boundary` (task 026) are registered by SIBLING
// bundles in this same verification-ladder slice. This table names them ahead
// of their registration by design — the policy is the contract those bundles
// implement against.
// ────────────────────────────────────────────────────────────────────────────

/** Ordered risk tier for the verification ladder. */
export type RiskTier = 'low' | 'medium' | 'high';

/**
 * The complete set of gate names that may appear in any verification sequence.
 * `GateName` is the union derived from this tuple; consumers type their gate
 * handling against it so a typo or an out-of-table name fails at compile time.
 */
export const VERIFICATION_GATE_NAMES = [
  'check_static_analysis',
  'check_test_adequacy',
  'check_integration_suite',
  'check_contract_drift',
  'check_mock_boundary',
] as const;

/** Union of every gate name appearing in the policy table. */
export type GateName = (typeof VERIFICATION_GATE_NAMES)[number];

/**
 * Base verification sequence per risk tier (boundaryTouching === false).
 * Each higher tier is a strict superset of the lower tier's prefix:
 *   low    → static analysis only
 *   medium → + test adequacy
 *   high   → + integration suite
 */
const BASE_SEQUENCE_BY_TIER: Readonly<Record<RiskTier, readonly GateName[]>> = Object.freeze({
  low: Object.freeze(['check_static_analysis'] as const),
  medium: Object.freeze(['check_static_analysis', 'check_test_adequacy'] as const),
  high: Object.freeze([
    'check_static_analysis',
    'check_test_adequacy',
    'check_integration_suite',
  ] as const),
});

/**
 * Boundary-touching gates, APPENDED AFTER the base sequence in this order:
 *   - `check_contract_drift` is added for EVERY tier when boundaryTouching.
 *   - `check_mock_boundary`  is added for MEDIUM and HIGH tiers only (a
 *     low-blast boundary edit does not warrant mock-boundary verification).
 */
const BOUNDARY_GATE_CONTRACT_DRIFT: GateName = 'check_contract_drift';
const BOUNDARY_GATE_MOCK_BOUNDARY: GateName = 'check_mock_boundary';

/**
 * Resolve the ordered verification gate sequence for a task profile.
 *
 * @param riskTier         the task's blast-radius tier
 * @param boundaryTouching whether the task crosses an I/O / schema boundary
 * @returns an immutable, duplicate-free, ordered list of gate names
 */
export function resolveVerificationSequence(
  riskTier: RiskTier,
  boundaryTouching: boolean,
): readonly GateName[] {
  const base = BASE_SEQUENCE_BY_TIER[riskTier];
  if (!boundaryTouching) {
    return base;
  }

  const sequence: GateName[] = [...base, BOUNDARY_GATE_CONTRACT_DRIFT];
  // mock-boundary only for medium / high tiers.
  if (riskTier === 'medium' || riskTier === 'high') {
    sequence.push(BOUNDARY_GATE_MOCK_BOUNDARY);
  }
  return Object.freeze(sequence);
}

// ─── Workflow-level Risk Tier (max-of-tiers) ────────────────────────────────

/**
 * Ordinal rank of each tier — the single source of the `low < medium < high`
 * ordering. Frozen so the comparison can never silently widen.
 */
const RISK_TIER_RANK: Readonly<Record<RiskTier, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

/**
 * Derive the workflow-level risk tier as the MAXIMUM tier across a wave's
 * decomposed tasks, under the ordering `low < medium < high` ({@link RISK_TIER_RANK}).
 *
 * This is the per-feature analog of a task's `riskTier`: the verification
 * ladder's top rung (`high`) gates the `mutation-adequacy` review backstop at
 * the `/review` boundary, so the workflow tier is `high` iff ANY task is `high`.
 * Max-of-tiers is the general monotone rule; the "any task high" boolean is its
 * degenerate case.
 *
 * A task with no tier is treated as `low` and never raises the max. An empty
 * wave — or a wave of all-untiered tasks — resolves to `low`, the floor.
 *
 * Pure: no I/O, no config reads.
 */
export function deriveWorkflowRiskTier(
  tasks: readonly { readonly riskTier?: RiskTier }[],
): RiskTier {
  let maxTier: RiskTier = 'low';
  for (const task of tasks) {
    const tier = task.riskTier ?? 'low';
    if (RISK_TIER_RANK[tier] > RISK_TIER_RANK[maxTier]) {
      maxTier = tier;
    }
  }
  return maxTier;
}

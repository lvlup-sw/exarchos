/**
 * The verification policy: the single source of truth for the verification ladder.
 *
 * It maps the `riskTier` and `boundaryTouching` profile of a task to an ordered list
 * of gate names. The module is a pure, frozen table and reads no config. Consumers
 * must not hardcode gate lists. They call `resolveVerificationPolicy`, which composes
 * config overrides on top of this table.
 */

/** Ordered risk tier for the verification ladder. */
export type RiskTier = 'low' | 'medium' | 'high';

/**
 * Every gate name that can occur in a verification sequence. A gate name that is
 * not in this tuple fails at compile time.
 */
export const VERIFICATION_GATE_NAMES = [
  'check_static_analysis',
  'check_integration_suite',
  'check_contract_drift',
  'check_mock_boundary',
] as const;

/** Union of every gate name appearing in the policy table. */
export type GateName = (typeof VERIFICATION_GATE_NAMES)[number];

/**
 * The gate names of earlier policy tables. A configured policy cell can still name one, and the parse removes it.
 * The source-revert kill probe left the table on 2026-11-25.
 */
export const RETIRED_VERIFICATION_GATE_NAMES = ['check_test_adequacy'] as const;

/**
 * The base sequence for each risk tier, when the task does not touch a boundary.
 * The low and medium tiers run static analysis. The high tier adds the integration suite.
 */
const BASE_SEQUENCE_BY_TIER: Readonly<Record<RiskTier, readonly GateName[]>> = Object.freeze({
  low: Object.freeze(['check_static_analysis'] as const),
  medium: Object.freeze(['check_static_analysis'] as const),
  high: Object.freeze([
    'check_static_analysis',
    'check_integration_suite',
  ] as const),
});

/** The gate added after the base sequence for each boundary-touching task. */
const BOUNDARY_GATE_CONTRACT_DRIFT: GateName = 'check_contract_drift';
/** The gate added after the drift gate for a boundary-touching `medium` or `high` task. */
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
  if (riskTier === 'medium' || riskTier === 'high') {
    sequence.push(BOUNDARY_GATE_MOCK_BOUNDARY);
  }
  return Object.freeze(sequence);
}

/** The rank of each tier, in the order `low < medium < high`. */
const RISK_TIER_RANK: Readonly<Record<RiskTier, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

/**
 * The workflow risk tier: the highest tier of the decomposed tasks. The review
 * contract reads it to select the tier-coupled review dimensions at `/review`. A
 * task with no tier counts as `low`. An empty task list gives `low`.
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

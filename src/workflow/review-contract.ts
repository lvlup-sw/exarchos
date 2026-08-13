// ─── Review Contract (Single Source of Truth) ───────────────────────────
//
// Review dimension names are derived from the skill folder names under
// `skills-src/`. The engine, the phase playbook, and every consumer that
// describes the review-state contract MUST reference the constants in this
// file rather than hardcoding strings. This prevents the drift that caused
// GitHub issues #1073, #1074, #1075 — where PR #1045 introduced new
// dimension names in `tools.ts` without updating `playbooks.ts` or the
// skill documentation, silently breaking the review → synthesize transition.
// ────────────────────────────────────────────────────────────────────────

/**
 * Required review dimensions per workflow type.
 *
 * The dimension key MUST match the skill folder name (kebab-case) under
 * `skills-src/`. This keeps three things aligned by construction:
 *   1. The skill an agent runs          (`skills-src/<name>/SKILL.md`)
 *   2. The state key the agent writes   (`reviews[<name>].status`)
 *   3. The dimension the engine expects (`_requiredReviews: [<name>, …]`)
 *
 * If you need to add a required dimension for a workflow type, add its
 * skill folder under `skills-src/<name>/` first, then add the name here.
 * Do not introduce new dimension naming conventions.
 */
export const REQUIRED_REVIEWS_BY_WORKFLOW_TYPE: Readonly<Record<string, readonly string[]>> = {
  feature: ['review'],
};

/**
 * A review dimension name. Dimensions are dynamic — they vary per workflow type
 * and risk tier and MUST equal a `skills-src/<name>/` folder — so this is the
 * open `string` type, not a closed literal union. This is the single place the
 * type is named; the phase-kind layer re-exports it for the `ResolvedGate`
 * `review` family rather than re-declaring the dimension vocabulary (which would
 * duplicate this source of truth). See design open-question #1.
 */
export type ReviewDimension = string;

/**
 * The ordered risk tier carried by a workflow / task classification.
 * Mirrors `workflow/verification-policy.ts`'s `RiskTier`; redeclared here as a
 * narrow string-literal union so the review contract stays free of a runtime
 * import cycle. `getRequiredReviews` accepts the wider `string` and treats any
 * unrecognised tier as "no tier-coupled dimensions" (backward-compatible).
 */
export type ReviewRiskTier = 'low' | 'medium' | 'high';

/**
 * Tier-coupled required review dimensions (verification ladder slice 3 / R5).
 *
 * The coupling of a dimension to a risk tier is POLICY DATA (INV-6), not a
 * branching conditional in prose: `mutation-adequacy` gates the HIGH tier only
 * (the `/review`-boundary adequacy backstop, design §4.3). Resolution is a pure
 * table lookup — adding a tier-coupled dimension is a one-line edit here, and
 * every consumer (`getRequiredReviews` / `getRequiredReviewsPrerequisite`)
 * picks it up by construction.
 *
 * Like {@link REQUIRED_REVIEWS_BY_WORKFLOW_TYPE}, every dimension key MUST equal
 * a skill folder name under `skills-src/` (here `skills-src/mutation-adequacy/`).
 */
export const REQUIRED_REVIEWS_BY_TIER: Readonly<Record<ReviewRiskTier, readonly string[]>> = {
  low: [],
  medium: [],
  high: ['mutation-adequacy'],
};

/**
 * Returns the required review dimensions for a given workflow type, or
 * an empty array if the workflow type does not enforce required reviews.
 *
 * When `riskTier` is supplied (the `/review`-boundary path that carries a task
 * classification), the tier-coupled dimensions from {@link REQUIRED_REVIEWS_BY_TIER}
 * are appended. Omitting `riskTier` — or passing an unrecognised tier — yields
 * exactly the workflow-type roster (backward-compatible with the pre-slice-3
 * single-argument call). The result is a fresh array so callers cannot mutate
 * the underlying tables.
 */
export function getRequiredReviews(
  workflowType: string,
  riskTier?: string,
): readonly string[] {
  const base = REQUIRED_REVIEWS_BY_WORKFLOW_TYPE[workflowType] ?? [];
  const tierDimensions =
    riskTier !== undefined
      ? REQUIRED_REVIEWS_BY_TIER[riskTier as ReviewRiskTier] ?? []
      : [];
  if (tierDimensions.length === 0) return [...base];
  // Append tier-coupled dimensions, de-duplicating against the base roster so a
  // future overlap never produces a doubled dimension name.
  const seen = new Set(base);
  return [...base, ...tierDimensions.filter((d) => !seen.has(d))];
}

/**
 * Renders the review contract as a human-readable `guardPrerequisites`
 * string for use in phase playbook documentation. Consumers must not
 * hand-write this string — it MUST be generated from the constants above
 * so any change to the required dimensions is reflected everywhere.
 *
 * Example: `getRequiredReviewsPrerequisite('feature')` →
 *   `reviews.review.status pass`
 *
 * `riskTier` threads through to {@link getRequiredReviews} so the high-tier
 * `mutation-adequacy` dimension appears in the rendered prerequisite at the
 * `/review` boundary; omitting it reproduces the pre-slice-3 string verbatim.
 */
export function getRequiredReviewsPrerequisite(
  workflowType: string,
  riskTier?: string,
): string {
  const dimensions = getRequiredReviews(workflowType, riskTier);
  if (dimensions.length === 0) return 'no required reviews';
  const clauses = dimensions.map((d) => `reviews.${d}.status`);
  return `${clauses.join(' AND ')} must be a passing value (pass|passed|approved|fixes-applied, case-insensitive)`;
}

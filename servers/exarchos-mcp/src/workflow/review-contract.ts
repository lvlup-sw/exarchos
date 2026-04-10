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
  feature: ['spec-review', 'quality-review'],
};

/**
 * Returns the required review dimensions for a given workflow type, or
 * an empty array if the workflow type does not enforce required reviews.
 */
export function getRequiredReviews(workflowType: string): readonly string[] {
  return REQUIRED_REVIEWS_BY_WORKFLOW_TYPE[workflowType] ?? [];
}

/**
 * Renders the review contract as a human-readable `guardPrerequisites`
 * string for use in phase playbook documentation. Consumers must not
 * hand-write this string — it MUST be generated from the constants above
 * so any change to the required dimensions is reflected everywhere.
 *
 * Example: `getRequiredReviewsPrerequisite('feature')` →
 *   `reviews.spec-review.status AND reviews.quality-review.status pass`
 */
export function getRequiredReviewsPrerequisite(workflowType: string): string {
  const dimensions = getRequiredReviews(workflowType);
  if (dimensions.length === 0) return 'no required reviews';
  const clauses = dimensions.map((d) => `reviews.${d}.status`);
  return `${clauses.join(' AND ')} must be a passing value (pass|passed|approved|fixes-applied, case-insensitive)`;
}

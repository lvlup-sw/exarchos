// The single source of truth for review dimension names. A dimension name equals a skill folder name.
// The engine, the phase playbook, and every consumer of the review-state contract must use these constants.
// A hardcoded dimension string can drift and break the transition from review to synthesize.

/**
 * The required review dimensions for each workflow type.
 * Each dimension name must equal a skill folder name under `content/<domain>/skills/`.
 * Thus the skill, the `reviews[<name>].status` state key, and the engine roster use one name.
 * To add a dimension, add its skill folder first.
 */
export const REQUIRED_REVIEWS_BY_WORKFLOW_TYPE: Readonly<Record<string, readonly string[]>> = {
  feature: ['review'],
};

/**
 * A review dimension name. It is an open `string` because the dimensions change with workflow type and risk tier.
 * The phase-kind layer re-exports this type and does not declare its own.
 */
export type ReviewDimension = string;

/**
 * The risk tier of a workflow or task classification. It copies `RiskTier` from `verification-policy.ts`.
 * The copy keeps this module free of an import cycle.
 */
export type ReviewRiskTier = 'low' | 'medium' | 'high';

/**
 * The extra required review dimensions for each risk tier. This table is policy data.
 * No tier adds a dimension now. Each name in it must equal a skill folder name.
 */
export const REQUIRED_REVIEWS_BY_TIER: Readonly<Record<ReviewRiskTier, readonly string[]>> = {
  low: [],
  medium: [],
  high: [],
};

/** The two tables that decide the required review dimensions. A test can pass its own tables to prove tier escalation. */
export interface ReviewContract {
  readonly byWorkflowType: Readonly<Record<string, readonly string[]>>;
  readonly byTier: Readonly<Record<ReviewRiskTier, readonly string[]>>;
}

/** The live review contract. */
export const DEFAULT_REVIEW_CONTRACT: ReviewContract = {
  byWorkflowType: REQUIRED_REVIEWS_BY_WORKFLOW_TYPE,
  byTier: REQUIRED_REVIEWS_BY_TIER,
};

/** True when `tier` names a row of the tier table. */
function isReviewRiskTier(tier: string): tier is ReviewRiskTier {
  return tier === 'low' || tier === 'medium' || tier === 'high';
}

/**
 * Returns the required review dimensions for a workflow type, or an empty array.
 * A known `riskTier` appends its dimensions from the tier table of `contract` without duplicates.
 * The result is a new array, so a caller cannot change the tables.
 */
export function getRequiredReviews(
  workflowType: string,
  riskTier?: string,
  contract: ReviewContract = DEFAULT_REVIEW_CONTRACT,
): readonly string[] {
  const base = contract.byWorkflowType[workflowType] ?? [];
  const tierDimensions =
    riskTier !== undefined && isReviewRiskTier(riskTier) ? contract.byTier[riskTier] : [];
  if (tierDimensions.length === 0) return [...base];
  const seen = new Set(base);
  return [...base, ...tierDimensions.filter((d) => !seen.has(d))];
}

/**
 * Renders the review contract as the `guardPrerequisites` text of the phase playbook.
 * Consumers must generate this text here and must not write it by hand.
 * `riskTier` and `contract` go to {@link getRequiredReviews}.
 */
export function getRequiredReviewsPrerequisite(
  workflowType: string,
  riskTier?: string,
  contract: ReviewContract = DEFAULT_REVIEW_CONTRACT,
): string {
  const dimensions = getRequiredReviews(workflowType, riskTier, contract);
  if (dimensions.length === 0) return 'no required reviews';
  const clauses = dimensions.map((d) => `reviews.${d}.status`);
  return `${clauses.join(' AND ')} must be a passing value (pass|passed|approved|fixes-applied, case-insensitive)`;
}

/**
 * The guard config of a phase transition.
 *
 * The transition guards read config values that are not facts of the workflow, such as the required reviews and the mutation budget.
 * This module computes them from the state that it gets and from the handler options.
 * So the state document and the ledger fold can each compute the config from their own risk tier.
 */
import { resolveGateSet } from '../../workflow/phase-kind.js';
import { resolveBoundaryTouching, resolveRiskTier } from '../../workflow/verification-policy-resolver.js';

/** The handler options that the guard config reads. */
export interface GuardConfigOptions {
  /**
   * The review dimensions for the `allReviewsPassed` guard. An explicit value, also `[]`, wins.
   * Without it, the config takes the REVIEW gate set of the workflow type and the risk tier of the state.
   */
  readonly requiredReviews?: readonly string[];
  /** The plan-revision cap for the `revisionsExhausted` guard. Only a finite number goes into the config. */
  readonly maxPlanRevisions?: number;
  /** The mutation enforcement mode for the score check of `allReviewsPassed`. Only the high tier gets it. */
  readonly mutationEnforcement?: 'block' | 'advisory';
  /** The mutation score threshold. Only the high tier gets it, and only as a finite number. */
  readonly mutationThreshold?: number;
  /** The NoCoverage budget for `allReviewsPassed`. Only the high tier gets it, and only as a non-negative integer. */
  readonly maxNoCoverage?: number;
}

/**
 * Sets the guard config fields on `state` in place.
 * It reads the workflow type, the risk tier and the boundary status of `state`, and the values of `options`.
 * With no options, it sets the review gates of the type and the tier, as a call with `{}` does.
 * It sets each field only when its rule holds, and it removes no field.
 */
export function injectGuardConfig(state: Record<string, unknown>, options: GuardConfigOptions = {}): void {
  if (options.requiredReviews !== undefined) {
    state._requiredReviews = options.requiredReviews;
  } else {
    const workflowType = state.workflowType;
    const typeDefaults = resolveGateSet('REVIEW', {
      riskTier: resolveRiskTier(state.riskTier),
      boundaryTouching: resolveBoundaryTouching(state.boundaryTouching),
      ...(typeof workflowType === 'string' ? { workflowType } : {}),
    }).flatMap((g) => (g.family === 'review' ? [g.gate] : []));
    if (typeDefaults.length > 0) {
      state._requiredReviews = typeDefaults;
    }
  }

  if (typeof options.maxPlanRevisions === 'number' && Number.isFinite(options.maxPlanRevisions)) {
    state._maxPlanRevisions = options.maxPlanRevisions;
  }

  if (resolveRiskTier(state.riskTier) === 'high') {
    if (options.mutationEnforcement !== undefined) {
      state._mutationEnforcement = options.mutationEnforcement;
    }
    if (typeof options.mutationThreshold === 'number' && Number.isFinite(options.mutationThreshold)) {
      state._mutationThreshold = options.mutationThreshold;
    }
    if (
      typeof options.maxNoCoverage === 'number' &&
      Number.isInteger(options.maxNoCoverage) &&
      options.maxNoCoverage >= 0
    ) {
      state._maxNoCoverage = options.maxNoCoverage;
    }
  }
}

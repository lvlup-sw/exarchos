/**
 * The review contract. The live contract requires only the `review` dimension at every risk tier.
 * The tier table stays, so an injected contract proves that a tier can add a dimension.
 * The roster resolves from data alone, so the working directory does not change it.
 */

import { describe, it, expect } from 'vitest';

import {
  getRequiredReviews,
  getRequiredReviewsPrerequisite,
  type ReviewContract,
} from '../../../src/workflow/review-contract.js';

/** An injected contract whose high tier adds one dimension. Only the tier mechanics are under test. */
const ESCALATING_CONTRACT: ReviewContract = {
  byWorkflowType: { feature: ['review'] },
  byTier: { low: [], medium: [], high: ['tier-probe'] },
};

describe('review contract — live roster', () => {
  it('ReviewContract_FreshHighTierWorkflow_RequiresOnlyTheReviewDimension', () => {
    expect(getRequiredReviews('feature', 'high')).toEqual(['review']);
    expect(getRequiredReviews('feature', 'high')).not.toContain('mutation-adequacy');
  });

  it('ReviewContract_EveryTier_ReproducesTheNoTierRoster', () => {
    const noTier = getRequiredReviews('feature');
    expect(noTier).toEqual(['review']);
    for (const tier of ['low', 'medium', 'high']) {
      expect(getRequiredReviews('feature', tier)).toEqual(noTier);
    }
  });

  it('ReviewContract_HighTierPrerequisite_NamesOnlyTheReviewDimension', () => {
    const prerequisite = getRequiredReviewsPrerequisite('feature', 'high');
    expect(prerequisite).toContain('reviews.review.status');
    expect(prerequisite).not.toContain('mutation-adequacy');
    expect(prerequisite).toBe(getRequiredReviewsPrerequisite('feature'));
  });
});

describe('review contract — tier escalation on an injected contract', () => {
  it('ReviewContract_InjectedHighTier_AddsItsDimension', () => {
    expect(getRequiredReviews('feature', 'high', ESCALATING_CONTRACT)).toEqual(['review', 'tier-probe']);
  });

  it('ReviewContract_InjectedMediumLowAndNoTier_AddNoDimension', () => {
    expect(getRequiredReviews('feature', undefined, ESCALATING_CONTRACT)).toEqual(['review']);
    expect(getRequiredReviews('feature', 'medium', ESCALATING_CONTRACT)).toEqual(['review']);
    expect(getRequiredReviews('feature', 'low', ESCALATING_CONTRACT)).toEqual(['review']);
  });

  /** A tier name outside the table adds no dimension. */
  it('ReviewContract_UnknownTierName_AddsNoDimension', () => {
    expect(getRequiredReviews('feature', 'critical', ESCALATING_CONTRACT)).toEqual(['review']);
  });

  it('ReviewContract_InjectedHighTierPrerequisite_NamesItsDimension', () => {
    expect(getRequiredReviewsPrerequisite('feature', 'high', ESCALATING_CONTRACT)).toContain(
      'reviews.tier-probe.status',
    );
    expect(getRequiredReviewsPrerequisite('feature', 'medium', ESCALATING_CONTRACT)).not.toContain('tier-probe');
  });

  /** A change of `process.cwd()` stands in for a managed worktree path, and it must not change the roster. */
  it('ReviewContract_HighTierRoster_ResolvesTheSameFromAnyWorkingDirectory', () => {
    const baseline = getRequiredReviews('feature', 'high', ESCALATING_CONTRACT);

    const originalCwd = process.cwd();
    try {
      process.chdir('/');
      expect(getRequiredReviews('feature', 'high', ESCALATING_CONTRACT)).toEqual(baseline);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('ReviewContract_RepeatedCalls_GiveEqualRosters', () => {
    const a = getRequiredReviews('feature', 'high', ESCALATING_CONTRACT);
    const b = getRequiredReviews('feature', 'high', ESCALATING_CONTRACT);
    expect(a).toEqual(b);
  });
});

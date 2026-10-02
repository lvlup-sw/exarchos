// The review contract is tier-aware. At the `/review` boundary, only the high
// risk tier requires the `mutation-adequacy` dimension. The medium and low
// tiers, and a call with no tier, return the roster of the workflow type.
// The roster resolves from data alone, so the working directory does not
// change it.

import { describe, it, expect } from 'vitest';

import {
  getRequiredReviews,
  getRequiredReviewsPrerequisite,
} from '../../../src/workflow/review-contract.js';

describe('review contract — tier-aware mutation-adequacy dimension (R5)', () => {
  describe('ReviewContract_MutationAdequacy_RequiredForHighTierOnly', () => {
    it('feature workflow at the HIGH tier includes mutation-adequacy', () => {
      const dims = getRequiredReviews('feature', 'high');
      expect(dims).toContain('mutation-adequacy');
      expect(dims).toContain('review');
    });
  });

  describe('ReviewContract_MutationAdequacy_AbsentForMediumLow', () => {
    it('medium tier does NOT include mutation-adequacy', () => {
      expect(getRequiredReviews('feature', 'medium')).not.toContain('mutation-adequacy');
    });

    it('low tier does NOT include mutation-adequacy', () => {
      expect(getRequiredReviews('feature', 'low')).not.toContain('mutation-adequacy');
    });

    it('the no-tier legacy call does NOT include mutation-adequacy (backward-compat)', () => {
      expect(getRequiredReviews('feature')).not.toContain('mutation-adequacy');
      expect(getRequiredReviews('feature')).toEqual(['review']);
    });

    it('medium and low tiers reproduce the no-tier roster exactly', () => {
      const noTier = getRequiredReviews('feature');
      expect(getRequiredReviews('feature', 'medium')).toEqual(noTier);
      expect(getRequiredReviews('feature', 'low')).toEqual(noTier);
    });
  });

  describe('MutationAdequacyDimension_ResolvesOnNonNativeWorktreePath', () => {
    /** A change of `process.cwd()` stands in for a managed worktree path, and it must not change the roster. */
    it('high-tier dimension resolves identically regardless of cwd / worktree context', () => {
      const baseline = getRequiredReviews('feature', 'high');

      const originalCwd = process.cwd();
      try {
        process.chdir('/');
        const fromOtherCwd = getRequiredReviews('feature', 'high');
        expect(fromOtherCwd).toEqual(baseline);
        expect(fromOtherCwd).toContain('mutation-adequacy');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('repeated calls are referentially stable (no per-call side effects)', () => {
      const a = getRequiredReviews('feature', 'high');
      const b = getRequiredReviews('feature', 'high');
      expect(a).toEqual(b);
    });
  });

  describe('getRequiredReviewsPrerequisite is tier-aware', () => {
    it('high tier prerequisite names mutation-adequacy', () => {
      expect(getRequiredReviewsPrerequisite('feature', 'high')).toContain(
        'reviews.mutation-adequacy.status',
      );
    });

    it('no-tier prerequisite is unchanged (backward-compat)', () => {
      expect(getRequiredReviewsPrerequisite('feature')).not.toContain(
        'mutation-adequacy',
      );
      expect(getRequiredReviewsPrerequisite('feature', 'medium')).not.toContain(
        'mutation-adequacy',
      );
    });
  });
});

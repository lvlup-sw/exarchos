// ─── Review Contract — tier-aware required-review dimensions (R5 / task 007) ──
//
// R5 (verification ladder slice 3) makes the review contract TIER-AWARE: the
// `mutation-adequacy` review dimension gates the HIGH risk tier ONLY, at the
// `/review` boundary. These tests pin:
//   1. high tier adds `mutation-adequacy` to the required-reviews roster;
//   2. medium/low (and the legacy no-tier call) do NOT include it;
//   3. the dimension resolves from PURE DATA, independent of harness / worktree
//      / runtime (INV-4 parity, design open Q4) — no fs, no native-isolation
//      dependency, identical regardless of any cwd/worktree context.
//
// The no-tier call signature is preserved verbatim (backward-compat): omitting
// `riskTier` reproduces today's per-workflow-type behaviour exactly.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';

import {
  getRequiredReviews,
  getRequiredReviewsPrerequisite,
} from './review-contract.js';

describe('review contract — tier-aware mutation-adequacy dimension (R5)', () => {
  // ── high-tier-only coupling ──────────────────────────────────────────────
  describe('ReviewContract_MutationAdequacy_RequiredForHighTierOnly', () => {
    it('feature workflow at the HIGH tier includes mutation-adequacy', () => {
      const dims = getRequiredReviews('feature', 'high');
      expect(dims).toContain('mutation-adequacy');
      // the base dimensions are preserved alongside the high-tier addition
      expect(dims).toContain('spec-review');
      expect(dims).toContain('quality-review');
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
      // backward-compat: the legacy call reproduces today's roster exactly
      expect(getRequiredReviews('feature')).toEqual(['spec-review', 'quality-review']);
    });

    it('medium and low tiers reproduce the no-tier roster exactly', () => {
      const noTier = getRequiredReviews('feature');
      expect(getRequiredReviews('feature', 'medium')).toEqual(noTier);
      expect(getRequiredReviews('feature', 'low')).toEqual(noTier);
    });
  });

  // ── INV-4 parity (design open Q4) — pure data, harness-independent ────────
  describe('MutationAdequacyDimension_ResolvesOnNonNativeWorktreePath', () => {
    it('high-tier dimension resolves identically regardless of cwd / worktree context', () => {
      // The contract is PURE: no fs, no native-isolation dependency. Mutating
      // process.cwd() (the cheapest proxy for a managed / non-native worktree
      // path) must not change the resolved dimension roster.
      const baseline = getRequiredReviews('feature', 'high');

      const originalCwd = process.cwd();
      try {
        // simulate a managed (non-native) worktree by changing cwd to one
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

  // ── prerequisite string mirrors the tier-aware roster ────────────────────
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

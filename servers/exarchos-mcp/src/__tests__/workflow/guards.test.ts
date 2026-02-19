import { describe, it, expect } from 'vitest';
import { guards, type GuardResult } from '../../workflow/guards.js';

// ─── T6: Guard null safety edge cases (ARCH-6) ──────────────────────────────

describe('Guard Null Safety', () => {
  describe('AllReviewsPassed_NullReviews_ReturnsFalseWithReason', () => {
    it('should return { passed: false, reason } when reviews is explicitly null', () => {
      const state = { reviews: null } as unknown as Record<string, unknown>;

      const result = guards.allReviewsPassed.evaluate(state);

      expect(result).not.toBe(false);
      expect(typeof result).toBe('object');
      const obj = result as { passed: false; reason: string };
      expect(obj.passed).toBe(false);
      expect(typeof obj.reason).toBe('string');
      expect(obj.reason.length).toBeGreaterThan(0);
    });
  });

  describe('MergeVerified_MissingCleanup_ReturnsFalseWithReason', () => {
    it('should return { passed: false, reason } when _cleanup is missing', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.mergeVerified.evaluate(state);

      expect(result).not.toBe(false);
      expect(typeof result).toBe('object');
      const obj = result as { passed: false; reason: string };
      expect(obj.passed).toBe(false);
      expect(typeof obj.reason).toBe('string');
      expect(obj.reason).toContain('mergeVerified');
    });

    it('should return { passed: false, reason } when _cleanup exists but mergeVerified is false', () => {
      const state = { _cleanup: { mergeVerified: false } } as Record<string, unknown>;

      const result = guards.mergeVerified.evaluate(state);

      expect(typeof result).toBe('object');
      const obj = result as { passed: false; reason: string };
      expect(obj.passed).toBe(false);
    });
  });
});

// ─── T7: Guard consistent return types (ARCH-6) ─────────────────────────────

describe('Guard Consistent Return Types', () => {
  describe('AllGuards_OnFailure_ReturnObjectWithReason', () => {
    it('should return { passed: false, reason } (not bare false) for all guards on failure', () => {
      // Empty state should make most guards fail
      const emptyState: Record<string, unknown> = {};

      // Guards that should fail on empty state (skip 'always' and 'implementationComplete')
      const failableGuards = Object.entries(guards).filter(
        ([key]) => key !== 'always' && key !== 'implementationComplete',
      );

      for (const [key, guard] of failableGuards) {
        const result = guard.evaluate(emptyState);

        // If the guard passed (returns true), skip — we only care about failures
        if (result === true) continue;

        // On failure, the result MUST be an object with { passed: false, reason }
        // It should NOT be bare `false`
        expect(
          typeof result,
          `Guard '${key}' returned bare false instead of { passed: false, reason }`,
        ).toBe('object');

        const obj = result as { passed: false; reason: string };
        expect(obj.passed, `Guard '${key}' missing passed: false`).toBe(false);
        expect(
          typeof obj.reason,
          `Guard '${key}' missing reason string`,
        ).toBe('string');
        expect(
          obj.reason.length,
          `Guard '${key}' has empty reason`,
        ).toBeGreaterThan(0);
      }
    });
  });
});

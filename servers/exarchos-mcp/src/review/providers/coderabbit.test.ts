import { describe, it, expect } from 'vitest';
import { coderabbitAdapter } from './coderabbit.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeComment(overrides: Partial<VcsPrComment> = {}): VcsPrComment {
  return {
    id: 1,
    author: 'coderabbitai[bot]',
    body: '',
    createdAt: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('coderabbitAdapter', () => {
  it('CoderabbitAdapter_PotentialIssueTier_NormalizesToHigh', () => {
    const comment = makeComment({
      body: '_:warning: Potential issue_\n\nThis check can throw at runtime.',
    });

    const result = coderabbitAdapter.parse(comment);

    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('HIGH');
    expect(result?.reviewer).toBe('coderabbit');
    expect(result?.type).toBe('comment-reply');
  });

  it('CoderabbitAdapter_RefactorSuggestionTier_NormalizesToMedium', () => {
    const comment = makeComment({
      body: '_:hammer_and_wrench: Refactor suggestion_\n\nConsider extracting this helper.',
    });

    const result = coderabbitAdapter.parse(comment);

    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('MEDIUM');
  });

  it('CoderabbitAdapter_VerificationAgentTier_NormalizesToLow', () => {
    const comment = makeComment({
      body: '_:bulb: Verification agent_\n\nLet us verify this hypothesis.',
    });

    const result = coderabbitAdapter.parse(comment);

    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('LOW');
  });

  it('CoderabbitAdapter_NitpickHeader_NormalizesToLow', () => {
    const comment = makeComment({
      body: '**Nitpick**: prefer `const` over `let` here.',
    });

    const result = coderabbitAdapter.parse(comment);

    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('LOW');
  });

  it('CoderabbitAdapter_UnrecognizedTier_DefaultsToMedium', () => {
    const comment = makeComment({
      body: 'Some prose with no tier marker whatsoever.',
    });

    const result = coderabbitAdapter.parse(comment);

    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('MEDIUM');
    // Sibling indicator that the tier was not recognized; the spec leaves the
    // exact field name to the implementer. We assert that the returned object
    // contains some marker keyed on "unknownTier" so callers can distinguish
    // explicit MEDIUM from default-MEDIUM.
    const withMarker = result as unknown as Record<string, unknown>;
    expect(withMarker.unknownTier).toBe(true);
  });

  it('CoderabbitAdapter_NonCoderabbitAuthor_ReturnsNull', () => {
    const comment = makeComment({
      author: 'github-actions[bot]',
      body: '_:warning: Potential issue_',
    });

    const result = coderabbitAdapter.parse(comment);

    expect(result).toBeNull();
  });

  it('CoderabbitAdapter_PopulatesFileAndLine', () => {
    const comment = makeComment({
      body: '_:warning: Potential issue_\n\nGuard against null.',
      path: 'src/foo.ts',
      line: 42,
    });

    const result = coderabbitAdapter.parse(comment);

    expect(result).not.toBeNull();
    expect(result?.file).toBe('src/foo.ts');
    expect(result?.line).toBe(42);
  });
});

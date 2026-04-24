/**
 * T048 — Prose lint on document template (DR-13).
 *
 * Ensures the rehydration document's prose surface (behavioralGuidance
 * template strings and surrounding doc comments) does not drift into
 * AI-writing patterns cataloged by the `humanize` skill. The lint here is
 * deliberately a small subset of that catalog — the highest-signal tells —
 * so it stays deterministic and fast enough for a CI pre-commit gate.
 */
import { describe, it, expect } from 'vitest';
import { lintProse, lintTemplate } from './prose-lint.js';

describe('prose-lint', () => {
  describe('ProseLint_BehavioralGuidanceTemplate_NoViolations', () => {
    it('returns zero violations for the current template prose', () => {
      const violations = lintTemplate();
      expect(violations).toEqual([]);
    });
  });

  describe('ProseLint_SeededViolation_Fails', () => {
    it('flags a string containing multiple known AI tells', () => {
      const seeded =
        "Let's delve into the tapestry — moreover, we must leverage the intricate landscape.";
      const violations = lintProse(seeded);

      expect(violations.length).toBeGreaterThanOrEqual(4);
      const patternNames = violations.map((v) => v.pattern);
      expect(patternNames).toContain('ai-vocabulary:delve');
      expect(patternNames).toContain('ai-vocabulary:tapestry');
      expect(patternNames).toContain('ai-vocabulary:leverage');
      expect(patternNames).toContain('conjunction-overuse:moreover');
    });

    it('records line numbers and excerpts per violation', () => {
      const seeded = 'Line one is clean.\nWe must leverage synergies now.';
      const violations = lintProse(seeded);

      expect(violations.length).toBeGreaterThanOrEqual(1);
      const leverageHit = violations.find(
        (v) => v.pattern === 'ai-vocabulary:leverage',
      );
      expect(leverageHit).toBeDefined();
      expect(leverageHit?.line).toBe(2);
      expect(leverageHit?.excerpt).toContain('leverage');
    });
  });

  describe('ProseLint_CleanProse_NoViolations', () => {
    it('returns zero violations for natural technical prose', () => {
      const clean =
        'The reducer folds events into a projection. If the projection is absent, the loader reconstructs it from the event log. Callers pin a sequence number so two readers see the same document.';
      const violations = lintProse(clean);
      expect(violations).toEqual([]);
    });

    it('tolerates a single em dash used as punctuation', () => {
      const clean =
        'The loader reads the fingerprint file — a tiny SHA-256 digest — and compares it to the committed value.';
      const violations = lintProse(clean);
      // A single em-dash pair is acceptable punctuation; only sustained chains
      // (three or more within one paragraph) should trip the lint.
      const emdashHits = violations.filter((v) => v.pattern === 'em-dash-chain');
      expect(emdashHits).toEqual([]);
    });
  });

  describe('ProseLint_EmDashChain_Flagged', () => {
    it('flags three or more em dashes in a single line', () => {
      const chain =
        'Not a word — not a whisper — not a sigh — escapes this AI paragraph.';
      const violations = lintProse(chain);
      const emdashHits = violations.filter((v) => v.pattern === 'em-dash-chain');
      expect(emdashHits.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ProseLint_NavigateComplexities_Flagged', () => {
    it('flags the "navigate the complexities" cliché', () => {
      const text = 'Teams must navigate the complexities of distributed consensus.';
      const violations = lintProse(text);
      expect(violations.map((v) => v.pattern)).toContain(
        'cliche:navigate-complexities',
      );
    });
  });

  describe('ProseLint_InConclusion_Flagged', () => {
    it('flags "in conclusion" as a canned AI closer', () => {
      const text = 'In conclusion, the system behaves as expected.';
      const violations = lintProse(text);
      expect(violations.map((v) => v.pattern)).toContain('closer:in-conclusion');
    });
  });
});

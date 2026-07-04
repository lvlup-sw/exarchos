import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { assignSplit, filterBySplit } from '../calibration-split.js';
import type { HumanGradedCase } from '../calibration-types.js';

// ─── Helper ────────────────────────────────────────────────────────────

function makeCase(caseId: string): HumanGradedCase {
  return {
    caseId,
    input: { prompt: `input-${caseId}` },
    expectedOutput: { result: `output-${caseId}` },
    humanScore: 0.9,
    humanRationale: 'Test rationale',
    tags: [],
  };
}

// ─── assignSplit ───────────────────────────────────────────────────────

describe('assignSplit', () => {
  it('AssignSplit_DeterministicHash_SameInputSameSplit', () => {
    // Arrange
    const caseId = 'case-abc-123';

    // Act
    const first = assignSplit(caseId);
    const second = assignSplit(caseId);
    const third = assignSplit(caseId);

    // Assert
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('AssignSplit_HashMod5_CorrectDistribution', () => {
    // Arrange — generate enough IDs for statistical significance
    const ids = Array.from({ length: 1000 }, (_, i) => `case-${i}`);

    // Act
    const counts = { train: 0, validation: 0, test: 0 };
    for (const id of ids) {
      counts[assignSplit(id)]++;
    }

    // Assert — all three splits receive cases
    expect(counts.train).toBeGreaterThan(0);
    expect(counts.validation).toBeGreaterThan(0);
    expect(counts.test).toBeGreaterThan(0);
  });

  it('AssignSplit_TrainSplit_Returns20Percent', () => {
    // Arrange — use a large sample for stable distribution
    const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);

    // Act
    const trainCount = ids.filter((id) => assignSplit(id) === 'train').length;
    const ratio = trainCount / ids.length;

    // Assert — 20% target (mod 5: bucket 0), allow +-5% tolerance
    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.25);
  });

  it('AssignSplit_ValidationSplit_Returns40Percent', () => {
    // Arrange
    const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);

    // Act
    const validationCount = ids.filter((id) => assignSplit(id) === 'validation').length;
    const ratio = validationCount / ids.length;

    // Assert — 40% target (mod 5: buckets 1-2), allow +-5% tolerance
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.45);
  });

  it('AssignSplit_TestSplit_Returns40Percent', () => {
    // Arrange
    const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);

    // Act
    const testCount = ids.filter((id) => assignSplit(id) === 'test').length;
    const ratio = testCount / ids.length;

    // Assert — 40% target (mod 5: buckets 3-4), allow +-5% tolerance
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.45);
  });
});

// ─── filterBySplit ─────────────────────────────────────────────────────

describe('filterBySplit', () => {
  it('FilterBySplit_ValidationOnly_ExcludesTrainAndTest', () => {
    // Arrange — build a set of cases spanning all splits
    const cases = Array.from({ length: 200 }, (_, i) => makeCase(`filter-val-${i}`));

    // Act
    const validationCases = filterBySplit(cases, 'validation');

    // Assert — every returned case should be in validation split
    for (const c of validationCases) {
      expect(assignSplit(c.caseId)).toBe('validation');
    }
    // And we should have fewer cases than the full set
    expect(validationCases.length).toBeGreaterThan(0);
    expect(validationCases.length).toBeLessThan(cases.length);
  });

  it('FilterBySplit_TestOnly_ExcludesTrainAndValidation', () => {
    // Arrange
    const cases = Array.from({ length: 200 }, (_, i) => makeCase(`filter-test-${i}`));

    // Act
    const testCases = filterBySplit(cases, 'test');

    // Assert — every returned case should be in test split
    for (const c of testCases) {
      expect(assignSplit(c.caseId)).toBe('test');
    }
    expect(testCases.length).toBeGreaterThan(0);
    expect(testCases.length).toBeLessThan(cases.length);
  });
});

// ─── Property-Based Tests ──────────────────────────────────────────────

describe('Property-Based Tests', () => {
  it('Determinism_SameId_AlwaysReturnsSameSplit', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 100 }), (id) => {
        const a = assignSplit(id);
        const b = assignSplit(id);
        expect(a).toBe(b);
      }),
    );
  });

  it('Distribution_ManyRandomIds_Approximates20_40_40', () => {
    // Use fast-check to generate a batch of unique IDs.
    // SEEDED for determinism: unseeded, fast-check eventually shrinks to an input
    // where a bucket lands exactly on a tolerance boundary (e.g. 250/500 = 0.50),
    // which the strict `<` rejected — a real flake that surfaced on CI. A fixed
    // seed pins the explored inputs so pass/fail is reproducible across runs and
    // platforms; the bounds are also inclusive to match the documented ±10% band.
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 50 }), {
          minLength: 500,
          maxLength: 500,
        }),
        (ids) => {
          const counts = { train: 0, validation: 0, test: 0 };
          for (const id of ids) {
            counts[assignSplit(id)]++;
          }
          const total = ids.length;

          // 20% train (+-10% tolerance for random strings) → [0.10, 0.30]
          expect(counts.train / total).toBeGreaterThanOrEqual(0.10);
          expect(counts.train / total).toBeLessThanOrEqual(0.30);

          // 40% validation (+-10% tolerance) → [0.30, 0.50]
          expect(counts.validation / total).toBeGreaterThanOrEqual(0.30);
          expect(counts.validation / total).toBeLessThanOrEqual(0.50);

          // 40% test (+-10% tolerance) → [0.30, 0.50]
          expect(counts.test / total).toBeGreaterThanOrEqual(0.30);
          expect(counts.test / total).toBeLessThanOrEqual(0.50);
        },
      ),
      { seed: 4242, numRuns: 100 },
    );
  });
});

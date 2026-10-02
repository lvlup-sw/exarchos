import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { assignSplit, filterBySplit } from '../calibration-split.js';
import type { HumanGradedCase } from '../calibration-types.js';

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

describe('assignSplit', () => {
  it('AssignSplit_DeterministicHash_SameInputSameSplit', () => {
    const caseId = 'case-abc-123';

    const first = assignSplit(caseId);
    const second = assignSplit(caseId);
    const third = assignSplit(caseId);

    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it('AssignSplit_HashMod5_CorrectDistribution', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `case-${i}`);

    const counts = { train: 0, validation: 0, test: 0 };
    for (const id of ids) {
      counts[assignSplit(id)]++;
    }

    expect(counts.train).toBeGreaterThan(0);
    expect(counts.validation).toBeGreaterThan(0);
    expect(counts.test).toBeGreaterThan(0);
  });

  /** Train is bucket 0 of the hash mod 5, so about 20% of IDs, with a tolerance of 5 points. */
  it('AssignSplit_TrainSplit_Returns20Percent', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);

    const trainCount = ids.filter((id) => assignSplit(id) === 'train').length;
    const ratio = trainCount / ids.length;

    expect(ratio).toBeGreaterThan(0.15);
    expect(ratio).toBeLessThan(0.25);
  });

  /** Validation is buckets 1 and 2 of the hash mod 5, so about 40% of IDs. */
  it('AssignSplit_ValidationSplit_Returns40Percent', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);

    const validationCount = ids.filter((id) => assignSplit(id) === 'validation').length;
    const ratio = validationCount / ids.length;

    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.45);
  });

  /** Test is buckets 3 and 4 of the hash mod 5, so about 40% of IDs. */
  it('AssignSplit_TestSplit_Returns40Percent', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);

    const testCount = ids.filter((id) => assignSplit(id) === 'test').length;
    const ratio = testCount / ids.length;

    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.45);
  });
});

describe('filterBySplit', () => {
  it('FilterBySplit_ValidationOnly_ExcludesTrainAndTest', () => {
    const cases = Array.from({ length: 200 }, (_, i) => makeCase(`filter-val-${i}`));

    const validationCases = filterBySplit(cases, 'validation');

    for (const c of validationCases) {
      expect(assignSplit(c.caseId)).toBe('validation');
    }
    expect(validationCases.length).toBeGreaterThan(0);
    expect(validationCases.length).toBeLessThan(cases.length);
  });

  it('FilterBySplit_TestOnly_ExcludesTrainAndValidation', () => {
    const cases = Array.from({ length: 200 }, (_, i) => makeCase(`filter-test-${i}`));

    const testCases = filterBySplit(cases, 'test');

    for (const c of testCases) {
      expect(assignSplit(c.caseId)).toBe('test');
    }
    expect(testCases.length).toBeGreaterThan(0);
    expect(testCases.length).toBeLessThan(cases.length);
  });
});

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

  /**
   * The bounds are inclusive, with a tolerance of 10 points for random strings, so a ratio exactly on
   * a bound passes. The fixed seed keeps the inputs and the result the same on every run.
   */
  it('Distribution_ManyRandomIds_Approximates20_40_40', () => {
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

          expect(counts.train / total).toBeGreaterThanOrEqual(0.10);
          expect(counts.train / total).toBeLessThanOrEqual(0.30);

          expect(counts.validation / total).toBeGreaterThanOrEqual(0.30);
          expect(counts.validation / total).toBeLessThanOrEqual(0.50);

          expect(counts.test / total).toBeGreaterThanOrEqual(0.30);
          expect(counts.test / total).toBeLessThanOrEqual(0.50);
        },
      ),
      { seed: 4242, numRuns: 100 },
    );
  });
});

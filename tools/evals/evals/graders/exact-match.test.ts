import { describe, it, expect } from 'vitest';
import { fc } from '@fast-check/vitest';
import { ExactMatchGrader } from './exact-match.js';

describe('ExactMatchGrader', () => {
  const grader = new ExactMatchGrader();

  it('Name_ReturnsExactMatch', () => {
    expect(grader.name).toBe('exact-match');
    expect(grader.type).toBe('exact-match');
  });

  it('Grade_FullMatch_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { a: 1, b: 'hello' },
      { a: 1, b: 'hello' }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  /** Two of three fields match. The default threshold is 1.0, so the grade fails. */
  it('Grade_PartialMatch_ReturnsProportionalScore', async () => {
    const result = await grader.grade(
      {},
      { a: 1, b: 'wrong', c: 3 },
      { a: 1, b: 'hello', c: 3 }
    );
    expect(result.score).toBeCloseTo(2 / 3);
    expect(result.passed).toBe(false);
  });

  it('Grade_NoMatch_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { a: 'x', b: 'y' },
      { a: 1, b: 2 }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('Grade_NestedObjects_DeepEquals', async () => {
    const result = await grader.grade(
      {},
      { data: { nested: { value: 42 } } },
      { data: { nested: { value: 42 } } }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('Grade_NestedObjectsMismatch_Fails', async () => {
    const result = await grader.grade(
      {},
      { data: { nested: { value: 99 } } },
      { data: { nested: { value: 42 } } }
    );
    expect(result.score).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('Grade_MatchingArrays_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { items: [1, 2, 3] },
      { items: [1, 2, 3] }
    );
    expect(result.score).toBe(1.0);
  });

  it('Grade_DifferentArrays_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { items: [1, 2, 4] },
      { items: [1, 2, 3] }
    );
    expect(result.score).toBe(0.0);
  });

  it('Grade_TypeMismatch_ReturnsScoreZero', async () => {
    const result = await grader.grade(
      {},
      { a: '1' },
      { a: 1 }
    );
    expect(result.score).toBe(0.0);
  });

  it('Grade_FieldSelection_OnlyChecksSelectedFields', async () => {
    const result = await grader.grade(
      {},
      { a: 1, b: 'wrong', c: 3 },
      { a: 1, b: 'hello', c: 3 },
      { fields: ['a', 'c'] }
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('Grade_ScoreAboveThreshold_Passes', async () => {
    const result = await grader.grade(
      {},
      { a: 1, b: 'wrong', c: 3 },
      { a: 1, b: 'hello', c: 3 },
      { threshold: 0.5 }
    );
    expect(result.passed).toBe(true);
  });

  it('Grade_ScoreBelowThreshold_Fails', async () => {
    const result = await grader.grade(
      {},
      { a: 1, b: 'wrong', c: 'wrong' },
      { a: 1, b: 'hello', c: 3 },
      { threshold: 0.5 }
    );
    expect(result.passed).toBe(false);
  });

  it('Grade_EmptyExpected_ReturnsScoreOne', async () => {
    const result = await grader.grade(
      {},
      { a: 1 },
      {}
    );
    expect(result.score).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('Grade_MissingFieldInOutput_CountsAsMismatch', async () => {
    const result = await grader.grade(
      {},
      { a: 1 },
      { a: 1, b: 2 }
    );
    expect(result.score).toBe(0.5);
  });

  describe('Property Tests', () => {
    const arbRecord = fc.dictionary(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.jsonValue()
    );

    it('Score_AlwaysInZeroOneRange', async () => {
      await fc.assert(
        fc.asyncProperty(arbRecord, arbRecord, async (output, expected) => {
          const result = await grader.grade({}, output, expected);
          expect(result.score).toBeGreaterThanOrEqual(0);
          expect(result.score).toBeLessThanOrEqual(1);
        })
      );
    });

    it('Grade_Idempotent_SameInputSameResult', async () => {
      await fc.assert(
        fc.asyncProperty(arbRecord, arbRecord, async (output, expected) => {
          const r1 = await grader.grade({}, output, expected);
          const r2 = await grader.grade({}, output, expected);
          expect(r1.score).toBe(r2.score);
          expect(r1.passed).toBe(r2.passed);
        })
      );
    });

    it('Grade_Identity_SameDataReturnsOne', async () => {
      await fc.assert(
        fc.asyncProperty(arbRecord, async (data) => {
          const result = await grader.grade({}, data, data);
          expect(result.score).toBe(1.0);
          expect(result.passed).toBe(true);
        })
      );
    });
  });
});

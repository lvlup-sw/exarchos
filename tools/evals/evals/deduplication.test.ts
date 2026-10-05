import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { EvalCase } from './types.js';
import { isDuplicate, computeStructuralSimilarity } from './deduplication.js';

function makeCase(id: string, input: Record<string, unknown>): EvalCase {
  return {
    id,
    type: 'single',
    description: `Test case ${id}`,
    input,
    expected: {},
    tags: [],
    layer: 'regression',
  };
}

describe('isDuplicate', () => {
  it('IsDuplicate_IdenticalInput_ReturnsTrue', () => {
    const candidate = makeCase('c-1', { tool: 'workflow', action: 'set', featureId: 'feat-1' });
    const existing = [
      makeCase('e-1', { tool: 'workflow', action: 'set', featureId: 'feat-1' }),
    ];

    const result = isDuplicate(candidate, existing);

    expect(result).toBe(true);
  });

  it('IsDuplicate_CompletelyDifferent_ReturnsFalse', () => {
    const candidate = makeCase('c-1', { tool: 'workflow', action: 'set' });
    const existing = [
      makeCase('e-1', { x: 42, y: 'hello', nested: { a: true } }),
    ];

    const result = isDuplicate(candidate, existing);

    expect(result).toBe(false);
  });

  it('IsDuplicate_SlightVariation_BelowThreshold_ReturnsFalse', () => {
    const candidate = makeCase('c-1', {
      tool: 'workflow',
      action: 'set',
      featureId: 'feat-1',
      extra1: 'value1',
      extra2: 'value2',
    });
    const existing = [
      makeCase('e-1', {
        tool: 'workflow',
        action: 'get',
        featureId: 'feat-2',
        different1: 'other1',
        different2: 'other2',
      }),
    ];

    const result = isDuplicate(candidate, existing, 0.9);

    expect(result).toBe(false);
  });

  it('IsDuplicate_SlightVariation_AboveThreshold_ReturnsTrue', () => {
    const candidate = makeCase('c-1', {
      tool: 'workflow',
      action: 'set',
      featureId: 'feat-1',
      phase: 'delegate',
    });
    const existing = [
      makeCase('e-1', {
        tool: 'workflow',
        action: 'set',
        featureId: 'feat-1',
        phase: 'review',
      }),
    ];

    const result = isDuplicate(candidate, existing, 0.7);

    expect(result).toBe(true);
  });

  it('IsDuplicate_DifferentTypes_ReturnsFalse', () => {
    const candidate = makeCase('c-1', {
      a: 'string',
      b: 42,
      c: true,
    });
    const existing = [
      makeCase('e-1', {
        a: 100,
        b: { nested: true },
        c: [1, 2, 3],
      }),
    ];

    const result = isDuplicate(candidate, existing);

    expect(result).toBe(false);
  });
});

describe('computeStructuralSimilarity', () => {
  it('ComputeSimilarity_NestedObjects_ComparesStructurally', () => {
    const a = {
      tool: 'workflow',
      config: { phase: 'delegate', retry: true },
      tags: ['feature'],
    };
    const b = {
      tool: 'workflow',
      config: { phase: 'delegate', retry: false },
      tags: ['feature'],
    };

    const similarity = computeStructuralSimilarity(a, b);

    expect(similarity).toBeGreaterThan(0.7);
    expect(similarity).toBeLessThan(1.0);
  });

  it('ComputeSimilarity_EmptyObjects_Returns1', () => {
    const a = {};
    const b = {};

    const similarity = computeStructuralSimilarity(a, b);

    expect(similarity).toBe(1.0);
  });
});

describe('computeStructuralSimilarity properties', () => {
  it('symmetry: similarity(a, b) === similarity(b, a)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        expect(computeStructuralSimilarity(a, b)).toBe(
          computeStructuralSimilarity(b, a),
        );
      }),
    );
  });

  it('identity: similarity(a, a) === 1.0', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (a) => {
        expect(computeStructuralSimilarity(a, a)).toBe(1.0);
      }),
    );
  });

  it('range: 0 <= similarity(a, b) <= 1.0', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        const score = computeStructuralSimilarity(a, b);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1.0);
      }),
    );
  });
});

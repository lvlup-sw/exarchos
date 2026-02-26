import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { EvalCase } from './types.js';
import { isDuplicate, computeStructuralSimilarity } from './deduplication.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

// ─── isDuplicate Tests ──────────────────────────────────────────────────────

describe('isDuplicate', () => {
  it('IsDuplicate_IdenticalInput_ReturnsTrue', () => {
    // Arrange
    const candidate = makeCase('c-1', { tool: 'workflow', action: 'set', featureId: 'feat-1' });
    const existing = [
      makeCase('e-1', { tool: 'workflow', action: 'set', featureId: 'feat-1' }),
    ];

    // Act
    const result = isDuplicate(candidate, existing);

    // Assert
    expect(result).toBe(true);
  });

  it('IsDuplicate_CompletelyDifferent_ReturnsFalse', () => {
    // Arrange
    const candidate = makeCase('c-1', { tool: 'workflow', action: 'set' });
    const existing = [
      makeCase('e-1', { x: 42, y: 'hello', nested: { a: true } }),
    ];

    // Act
    const result = isDuplicate(candidate, existing);

    // Assert
    expect(result).toBe(false);
  });

  it('IsDuplicate_SlightVariation_BelowThreshold_ReturnsFalse', () => {
    // Arrange — enough structural differences to fall below 0.9
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

    // Act
    const result = isDuplicate(candidate, existing, 0.9);

    // Assert
    expect(result).toBe(false);
  });

  it('IsDuplicate_SlightVariation_AboveThreshold_ReturnsTrue', () => {
    // Arrange — nearly identical, one small value change
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

    // Act — use a lower threshold that this variation should exceed
    const result = isDuplicate(candidate, existing, 0.7);

    // Assert
    expect(result).toBe(true);
  });

  it('IsDuplicate_DifferentTypes_ReturnsFalse', () => {
    // Arrange — same keys but completely different value types
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

    // Act
    const result = isDuplicate(candidate, existing);

    // Assert
    expect(result).toBe(false);
  });
});

// ─── computeStructuralSimilarity Tests ──────────────────────────────────────

describe('computeStructuralSimilarity', () => {
  it('ComputeSimilarity_NestedObjects_ComparesStructurally', () => {
    // Arrange
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

    // Act
    const similarity = computeStructuralSimilarity(a, b);

    // Assert — mostly similar structure, one nested value differs
    expect(similarity).toBeGreaterThan(0.7);
    expect(similarity).toBeLessThan(1.0);
  });

  it('ComputeSimilarity_EmptyObjects_Returns1', () => {
    // Arrange
    const a = {};
    const b = {};

    // Act
    const similarity = computeStructuralSimilarity(a, b);

    // Assert
    expect(similarity).toBe(1.0);
  });
});

// ─── Property-Based Tests ───────────────────────────────────────────────────

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

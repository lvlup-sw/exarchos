import type { EvalCase } from './types.js';

/**
 * Computes the structural similarity of two values, from 0 to 1. Equal values score 1. Unequal
 * numbers, strings, or booleans score 0.5. Values of different types, an array against an object,
 * or `null` against a non-null value score 0. Arrays and plain objects score the mean over all
 * positions or keys, and a position or key on one side only scores 0.
 */
export function computeStructuralSimilarity(a: unknown, b: unknown): number {
  if (a === b) return 1.0;

  if (a === null && b === null) return 1.0;

  if (a === null || b === null) return 0.0;

  const typeA = typeof a;
  const typeB = typeof b;

  if (typeA !== typeB) return 0.0;

  if (typeA === 'number') {
    return a === b ? 1.0 : 0.5;
  }

  if (typeA === 'string') {
    return a === b ? 1.0 : 0.5;
  }

  if (typeA === 'boolean') {
    return a === b ? 1.0 : 0.5;
  }

  if (typeA === 'object') {
    return compareObjects(a as object, b as object);
  }

  return a === b ? 1.0 : 0.0;
}

function compareObjects(a: object, b: object): number {
  const isArrayA = Array.isArray(a);
  const isArrayB = Array.isArray(b);

  if (isArrayA !== isArrayB) return 0.0;

  if (isArrayA && isArrayB) {
    return compareArrays(a as unknown[], b as unknown[]);
  }

  return comparePlainObjects(
    a as Record<string, unknown>,
    b as Record<string, unknown>,
  );
}

function compareArrays(a: unknown[], b: unknown[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;

  let totalSimilarity = 0;

  for (let i = 0; i < maxLen; i++) {
    if (i < a.length && i < b.length) {
      totalSimilarity += computeStructuralSimilarity(a[i], b[i]);
    }
  }

  return totalSimilarity / maxLen;
}

function comparePlainObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  const allKeys = new Set([...keysA, ...keysB]);

  if (allKeys.size === 0) return 1.0;

  let totalSimilarity = 0;

  for (const key of allKeys) {
    const inA = key in a;
    const inB = key in b;

    if (inA && inB) {
      totalSimilarity += computeStructuralSimilarity(a[key], b[key]);
    }
  }

  return totalSimilarity / allKeys.size;
}

/**
 * Check whether a candidate eval case's input is structurally similar
 * to any existing case above the given threshold.
 */
export function isDuplicate(
  candidate: EvalCase,
  existingCases: ReadonlyArray<EvalCase>,
  threshold: number = 0.9,
): boolean {
  return existingCases.some(
    (existing) =>
      computeStructuralSimilarity(candidate.input, existing.input) >= threshold,
  );
}

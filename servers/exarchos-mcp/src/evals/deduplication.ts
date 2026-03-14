import type { EvalCase } from './types.js';

// ─── Structural Similarity ──────────────────────────────────────────────────

/**
 * Compute structural similarity between two values (0-1).
 *
 * Compares keys, value types, and primitive values recursively.
 * Identical values yield 1.0, completely different structures yield 0.0.
 */
export function computeStructuralSimilarity(a: unknown, b: unknown): number {
  // Identical references or equal primitives
  if (a === b) return 1.0;

  // Both null
  if (a === null && b === null) return 1.0;

  // One null, one not
  if (a === null || b === null) return 0.0;

  const typeA = typeof a;
  const typeB = typeof b;

  // Different primitive types
  if (typeA !== typeB) return 0.0;

  // Both are numbers
  if (typeA === 'number') {
    return a === b ? 1.0 : 0.5;
  }

  // Both are strings
  if (typeA === 'string') {
    return a === b ? 1.0 : 0.5;
  }

  // Both are booleans
  if (typeA === 'boolean') {
    return a === b ? 1.0 : 0.5;
  }

  // Both are objects (arrays or plain objects)
  if (typeA === 'object') {
    return compareObjects(a as object, b as object);
  }

  // Fallback for other types (undefined, function, symbol, bigint)
  return a === b ? 1.0 : 0.0;
}

function compareObjects(a: object, b: object): number {
  const isArrayA = Array.isArray(a);
  const isArrayB = Array.isArray(b);

  // Mismatched array vs object
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
    // Elements beyond the shorter array contribute 0
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
      // Key present in both -- recurse on values
      totalSimilarity += computeStructuralSimilarity(a[key], b[key]);
    }
    // Key in only one side contributes 0
  }

  return totalSimilarity / allKeys.size;
}

// ─── Duplicate Detection ────────────────────────────────────────────────────

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

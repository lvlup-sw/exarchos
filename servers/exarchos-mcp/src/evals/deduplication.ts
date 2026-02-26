import type { EvalCase } from './types.js';

/**
 * Check whether a candidate eval case is a duplicate of any case
 * in the existing dataset. Duplicates are identified by matching `id`.
 */
export function isDuplicate(candidate: EvalCase, existing: EvalCase[]): boolean {
  return existing.some((e) => e.id === candidate.id);
}

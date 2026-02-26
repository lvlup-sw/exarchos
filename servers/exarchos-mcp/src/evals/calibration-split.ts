import * as crypto from 'node:crypto';
import type { HumanGradedCase } from './calibration-types.js';

/**
 * Deterministically assign a case to a split based on its ID.
 * Uses a hash to ensure stable assignment: ~70% validation, ~30% test.
 */
export function assignSplit(caseId: string): 'validation' | 'test' {
  const hash = crypto.createHash('sha256').update(caseId).digest();
  // Use first byte as a deterministic value 0-255
  const value = hash[0];
  // 70/30 split: values 0-178 => validation, 179-255 => test
  return value <= 178 ? 'validation' : 'test';
}

/**
 * Filter cases by their assigned split.
 */
export function filterBySplit(
  cases: HumanGradedCase[],
  split: 'validation' | 'test',
): HumanGradedCase[] {
  return cases.filter((c) => assignSplit(c.id) === split);
}

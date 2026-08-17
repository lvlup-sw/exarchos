import type { HumanGradedCase, CalibrationSplit } from './calibration-types.js';

// ─── Hash Function ─────────────────────────────────────────────────────

/**
 * Simple deterministic hash: sum of character codes.
 * Sufficient for split assignment — not cryptographic.
 */
function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    // djb2-style: hash * 31 + charCode for better distribution
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// ─── Split Assignment ──────────────────────────────────────────────────

/**
 * Deterministically assigns a case ID to a split.
 *
 * Uses `hash(caseId) mod 5`:
 * - 0       → train       (20%)
 * - 1, 2    → validation  (40%)
 * - 3, 4    → test        (40%)
 */
export function assignSplit(caseId: string): CalibrationSplit {
  const bucket = hashString(caseId) % 5;

  if (bucket === 0) return 'train';
  if (bucket <= 2) return 'validation';
  return 'test';
}

// ─── Filter by Split ───────────────────────────────────────────────────

/**
 * Filters a list of human-graded cases to only those
 * belonging to the given split.
 */
export function filterBySplit(
  cases: HumanGradedCase[],
  split: CalibrationSplit,
): HumanGradedCase[] {
  return cases.filter((c) => assignSplit(c.caseId) === split);
}

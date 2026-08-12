import { describe, it, expect } from 'vitest';
import { computeVerdict } from './review-verdict.js';

describe('behavioral parity with review-verdict.sh', () => {
  it('no HIGH findings returns APPROVED (h:0 m:2 l:5)', () => {
    const verdict = computeVerdict({ high: 0, medium: 2, low: 5 });

    expect(verdict).toBe('APPROVED');
  });

  it('HIGH findings returns NEEDS_FIXES (h:3 m:1 l:0)', () => {
    const verdict = computeVerdict({ high: 3, medium: 1, low: 0 });

    expect(verdict).toBe('NEEDS_FIXES');
  });

  it('blocked reason returns BLOCKED regardless of finding counts', () => {
    const verdict = computeVerdict({
      high: 0,
      medium: 0,
      low: 0,
      blockedReason: 'Architecture redesign needed',
    });

    expect(verdict).toBe('BLOCKED');
  });

  it('zero findings across all severities returns APPROVED', () => {
    const verdict = computeVerdict({ high: 0, medium: 0, low: 0 });

    expect(verdict).toBe('APPROVED');
  });
});

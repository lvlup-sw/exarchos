import { describe, it, expect } from 'vitest';
import { percentile } from './percentile.js';

describe('percentile', () => {
  it('should return 0 for empty array', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('should return the single value for array of one', () => {
    expect(percentile([1], 0.5)).toBe(1);
  });

  it('should compute p50 for odd-length array', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it('should compute p95 for small array', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
  });

  it('should compute p95 for 10-element array', () => {
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.95)).toBe(100);
  });

  it('should not mutate the original array', () => {
    const arr = [5, 3, 1, 4, 2];
    percentile(arr, 0.5);
    expect(arr).toEqual([5, 3, 1, 4, 2]);
  });
});

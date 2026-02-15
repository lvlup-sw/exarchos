/**
 * Computes the percentile value from an array of numbers.
 * Creates a sorted copy — does not mutate the input.
 *
 * @param values - Array of numeric values
 * @param rank - Percentile rank between 0 and 1 (e.g. 0.95 for p95)
 * @returns The value at the given percentile, or 0 for an empty array
 */
export function percentile(values: number[], rank: number): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(rank * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

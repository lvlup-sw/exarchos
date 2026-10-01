/**
 * Return the value at a percentile rank. It sorts a copy, so the input does not change.
 *
 * @param values - The numeric values
 * @param rank - The percentile rank, from 0 to 1 (0.95 for p95)
 * @returns The value at the rank, or 0 for an empty array
 */
export function percentile(values: number[], rank: number): number {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index] ?? 0;
}

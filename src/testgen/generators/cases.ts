import type { TestInput } from '../contract/schemas.js';

export function expandCases(input: TestInput): string[][] {
  const cases = [...input.cases];
  const anchor = cases[0];
  if (!anchor) return cases;
  const seen = new Set(cases.map((values) => values.join(',')));
  for (const axis of input.boundaryAxes ?? []) {
    const min = BigInt(axis.min);
    const max = BigInt(axis.max);
    for (const value of [min, min + 1n, max - 1n, max]) {
      if (value < min || value > max) continue;
      const candidate = [...anchor];
      candidate[axis.index] = value.toString();
      const key = candidate.join(',');
      if (!seen.has(key)) {
        cases.push(candidate);
        seen.add(key);
      }
    }
  }
  return cases;
}

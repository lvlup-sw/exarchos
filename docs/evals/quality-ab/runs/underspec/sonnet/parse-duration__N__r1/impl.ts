/** Parse a human duration string into a total number of milliseconds. */

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

// Order matters: "ms" must be tried before "m" and "s" so it isn't
// shadowed by the shorter single-character alternatives.
const SEGMENT_RE = /(\d+)(ms|s|m|h|d)/g;

export function parseDuration(input: string): number {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  let totalMs = 0;
  let matchedLength = 0;
  let expectedIndex = 0;

  SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT_RE.exec(input)) !== null) {
    // Segments must be contiguous: no gaps, no invalid characters between them.
    if (match.index !== expectedIndex) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    const [full, amountStr, unit] = match;
    const amount = Number(amountStr);
    const unitMs = UNIT_MS[unit];

    totalMs += amount * unitMs;
    matchedLength += full.length;
    expectedIndex = match.index + full.length;

    // Guard against zero-length matches causing an infinite loop.
    if (full.length === 0) {
      SEGMENT_RE.lastIndex++;
    }
  }

  // The whole input must be consumed by at least one segment.
  if (matchedLength === 0 || matchedLength !== input.length) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  return totalMs;
}

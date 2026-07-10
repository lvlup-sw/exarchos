/** Parse a human duration string into a total number of milliseconds. */

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// Sticky regex: `y` flag forces each match to start exactly at `lastIndex`,
// so segments must be contiguous (no gaps, no stray characters allowed).
const SEGMENT_RE = /(\d+)(ms|s|m|h|d)/y;

export function parseDuration(input: string): number {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  let total = 0;
  let index = 0;

  while (index < input.length) {
    SEGMENT_RE.lastIndex = index;
    const match = SEGMENT_RE.exec(input);
    if (!match) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    const [full, amountStr, unit] = match;
    const amount = Number(amountStr);
    total += amount * UNIT_TO_MS[unit];
    index += full.length;
  }

  return total;
}

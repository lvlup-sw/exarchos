/** Parse a human duration string into a total number of milliseconds. */

/** Milliseconds represented by one unit of each supported duration suffix. */
const UNIT_TO_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

// Order matters: "ms" must be tried before "m" and "s" so the two-letter
// unit is preferred over accidentally matching a lone "m" or "s".
const SEGMENT_RE = /(\d+)(ms|s|m|h|d)/g;

export function parseDuration(input: string): number {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  SEGMENT_RE.lastIndex = 0;

  let totalMs = 0;
  let cursor = 0;
  let matchedAny = false;
  let match: RegExpExecArray | null;

  while ((match = SEGMENT_RE.exec(input)) !== null) {
    // A gap between the end of the previous segment and the start of this
    // match means there were unparseable characters in between (or, on the
    // first iteration, leading garbage) — reject the whole input.
    if (match.index !== cursor) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    const [fullMatch, amountStr, unit] = match;
    const amount = Number(amountStr);
    totalMs += amount * UNIT_TO_MS[unit];
    cursor = match.index + fullMatch.length;
    matchedAny = true;
  }

  if (!matchedAny || cursor !== input.length) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  return totalMs;
}

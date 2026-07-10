/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  const UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  // NOTE: "ms" must be tried before "m" and "s" so the longer unit wins.
  const segmentRegex = /(\d+)(ms|s|m|h|d)/g;

  let totalMs = 0;
  let lastIndex = 0;
  let matchCount = 0;
  let match: RegExpExecArray | null;

  while ((match = segmentRegex.exec(input)) !== null) {
    // A valid duration string is a *contiguous* run of segments starting at
    // index 0 with no gaps (extra chars, whitespace, out-of-order units).
    if (match.index !== lastIndex) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    const amount = Number(match[1]);
    const unit = match[2];
    totalMs += amount * UNIT_MS[unit];

    lastIndex = segmentRegex.lastIndex;
    matchCount++;
  }

  if (matchCount === 0 || lastIndex !== input.length) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  return totalMs;
}

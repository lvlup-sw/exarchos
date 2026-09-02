/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`parseDuration: input must be a non-empty string, got ${JSON.stringify(input)}`);
  }

  const UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  // Match one or more <digits><unit> segments. Order units longest-first so
  // "ms" is preferred over "m" + trailing "s".
  const segmentPattern = /(\d+)(ms|s|m|h|d)/g;

  let totalMs = 0;
  let matchedLength = 0;
  let sawSegment = false;
  let match: RegExpExecArray | null;

  while ((match = segmentPattern.exec(input)) !== null) {
    // Ensure segments are contiguous (no gaps / invalid characters between them).
    if (match.index !== matchedLength) {
      throw new Error(
        `parseDuration: invalid duration string ${JSON.stringify(input)} (unexpected characters at position ${matchedLength})`
      );
    }

    const [full, amountStr, unit] = match;
    const amount = Number(amountStr);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error(`parseDuration: invalid amount "${amountStr}" in ${JSON.stringify(input)}`);
    }

    const unitMs = UNIT_MS[unit];
    if (unitMs === undefined) {
      throw new Error(`parseDuration: unknown unit "${unit}" in ${JSON.stringify(input)}`);
    }

    totalMs += amount * unitMs;
    matchedLength += full.length;
    sawSegment = true;
  }

  if (!sawSegment || matchedLength !== input.length) {
    throw new Error(`parseDuration: invalid duration string ${JSON.stringify(input)}`);
  }

  return totalMs;
}

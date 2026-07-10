/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError('parseDuration: input must be a string');
  }
  if (input.length === 0) {
    throw new Error('parseDuration: empty input');
  }

  // Milliseconds per unit. `ms` must precede `s`/`m` in the alternation below
  // so that "500ms" is not mis-tokenised as "500m" + "s".
  const UNIT_MS = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  } as const;

  type Unit = keyof typeof UNIT_MS;

  const segmentRe = /(\d+)(ms|s|m|h|d)/g;

  let total = 0;
  let expectedIndex = 0;
  let sawSegment = false;
  let match: RegExpExecArray | null;

  while ((match = segmentRe.exec(input)) !== null) {
    // Enforce that segments are contiguous from the start — reject leading or
    // interior junk (e.g. " 1h", "1h x2m").
    if (match.index !== expectedIndex) {
      throw new Error(`parseDuration: invalid duration "${input}"`);
    }

    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount)) {
      throw new Error(
        `parseDuration: amount "${match[1]}" is out of safe integer range`,
      );
    }

    const unit = match[2] as Unit;
    total += amount * UNIT_MS[unit];

    sawSegment = true;
    expectedIndex = segmentRe.lastIndex;
  }

  // Reject empty matches or trailing junk (e.g. "1", "1h ", "1hfoo").
  if (!sawSegment || expectedIndex !== input.length) {
    throw new Error(`parseDuration: invalid duration "${input}"`);
  }

  return total;
}

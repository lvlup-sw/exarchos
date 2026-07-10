/** Milliseconds per recognized unit. */
const UNIT_TO_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Sticky segment matcher: one `<amount><unit>` pair anchored at `lastIndex`.
 * `ms` is listed before `m` so the two-character unit wins over the prefix.
 */
const SEGMENT = /(\d+)(ms|s|m|h|d)/y;

/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError('parseDuration: input must be a string');
  }

  let index = 0;
  let total = 0;
  let matchedAny = false;

  while (index < input.length) {
    SEGMENT.lastIndex = index;
    const match = SEGMENT.exec(input);

    // With the sticky flag a successful match always starts at `index`, so a
    // null result means the remaining text is not a valid `<amount><unit>`.
    if (match === null) {
      throw new Error(
        `parseDuration: invalid duration segment in "${input}" at position ${index}`,
      );
    }

    matchedAny = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * UNIT_TO_MS[unit];
    index += match[0].length;
  }

  if (!matchedAny) {
    throw new Error(`parseDuration: empty or invalid duration "${input}"`);
  }

  return total;
}

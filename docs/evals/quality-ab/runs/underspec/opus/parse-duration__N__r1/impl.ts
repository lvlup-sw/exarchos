/** Milliseconds per unit. `ms` is the only two-character unit. */
const UNIT_TO_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Matches a single `<amount><unit>` segment.
 *
 * Sticky (`y`) so we can walk the string segment-by-segment and guarantee the
 * entire input is consumed — any gap or trailing garbage yields a null match.
 * `ms` precedes the single-char units in the alternation so it is preferred
 * before `m`/`s` are considered.
 */
const SEGMENT = /(\d+)(ms|s|m|h|d)/y;

/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError('parseDuration: input must be a string');
  }
  if (input.length === 0) {
    throw new SyntaxError('parseDuration: input must contain at least one segment');
  }

  let index = 0;
  let total = 0;

  while (index < input.length) {
    SEGMENT.lastIndex = index;
    const match = SEGMENT.exec(input);
    if (match === null) {
      throw new SyntaxError(
        `parseDuration: invalid duration segment at index ${index} in "${input}"`,
      );
    }

    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * UNIT_TO_MS[unit];

    index = SEGMENT.lastIndex;
  }

  return total;
}

/** Parse a human duration string into a total number of milliseconds. */

/** Milliseconds represented by a single unit of each supported suffix. */
const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

/**
 * Sticky matcher for a single `<amount><unit>` segment.
 *
 * The `ms` alternative precedes `m`/`s` so that a `500ms` segment is parsed as
 * "500 milliseconds" rather than "500 minutes" followed by a stray `s`.
 * The `y` (sticky) flag anchors each match at `lastIndex`, which lets us prove
 * the entire input is consumed with no gaps or trailing garbage.
 */
const SEGMENT = /(\d+)(ms|s|m|h|d)/y;

/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError(
      `parseDuration expected a string, received ${typeof input}`,
    );
  }
  if (input.length === 0) {
    throw new Error('parseDuration: input must not be empty');
  }

  let total = 0;
  let index = 0;

  while (index < input.length) {
    SEGMENT.lastIndex = index;
    const match = SEGMENT.exec(input);
    if (match === null) {
      throw new Error(
        `parseDuration: invalid duration segment at position ${index} in "${input}"`,
      );
    }

    const amount = Number(match[1]);
    const unit = match[2];
    // Unit is guaranteed to be a known key by the regex alternation.
    total += amount * UNIT_MS[unit];

    index = SEGMENT.lastIndex;
  }

  return total;
}

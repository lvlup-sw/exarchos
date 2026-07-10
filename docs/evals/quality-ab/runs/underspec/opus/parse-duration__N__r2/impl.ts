/** Milliseconds represented by a single instance of each supported unit. */
const UNIT_TO_MS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

/**
 * Matches a single `<amount><unit>` segment.
 *
 * The unit alternation lists `ms` before `m` so that the two-character
 * millisecond unit is preferred over the single-character minute unit
 * (regex alternation is ordered at each match position).
 */
const SEGMENT = /(\d+)(ms|s|m|h|d)/g;

/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError(
      `parseDuration: expected a string, got ${typeof input}`,
    );
  }

  // Reset the shared regex's cursor (it carries state across calls).
  SEGMENT.lastIndex = 0;

  let total = 0;
  let cursor = 0;
  let matchedAny = false;
  let match: RegExpExecArray | null;

  while ((match = SEGMENT.exec(input)) !== null) {
    // Reject any characters between the previous segment and this one:
    // a valid input is a gap-free concatenation of segments.
    if (match.index !== cursor) {
      throw new SyntaxError(
        `parseDuration: unexpected characters in ${JSON.stringify(input)} at index ${cursor}`,
      );
    }

    const amount = Number(match[1]);
    const unit = match[2];
    const unitMs = UNIT_TO_MS[unit];

    // `\d+` guarantees a non-negative integer; Number is exact for these.
    total += amount * unitMs;

    matchedAny = true;
    cursor = SEGMENT.lastIndex;
  }

  // Must have matched at least one segment and consumed the entire string.
  if (!matchedAny || cursor !== input.length) {
    throw new SyntaxError(
      `parseDuration: invalid duration string ${JSON.stringify(input)}`,
    );
  }

  if (!Number.isSafeInteger(total)) {
    throw new RangeError(
      `parseDuration: duration ${JSON.stringify(input)} exceeds the safe integer range`,
    );
  }

  return total;
}

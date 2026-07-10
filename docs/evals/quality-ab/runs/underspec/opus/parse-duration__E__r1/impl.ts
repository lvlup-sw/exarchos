/** Milliseconds per recognized unit. */
const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

/**
 * Matches a single `<amount><unit>` segment.
 * The unit alternation lists `ms` before `s`/`m` so the two-character unit is
 * preferred over the single-character ones (e.g. `500ms` is milliseconds, not
 * `500m` + `s`).
 */
const SEGMENT = /(\d+)(ms|s|m|h|d)/g;

/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError('parseDuration: input must be a string');
  }

  // Reset the shared regex's lastIndex; it carries state across calls.
  SEGMENT.lastIndex = 0;

  let total = 0;
  let cursor = 0;
  let sawSegment = false;
  let match: RegExpExecArray | null;

  while ((match = SEGMENT.exec(input)) !== null) {
    // Reject any gap between the previous segment and this one, which would
    // mean the input contained an unrecognized token.
    if (match.index !== cursor) {
      throw new SyntaxError(
        `parseDuration: unexpected token at index ${cursor} in ${JSON.stringify(input)}`,
      );
    }

    const amount = Number(match[1]);
    const unit = match[2] as keyof typeof UNIT_MS;

    total += amount * UNIT_MS[unit];
    cursor = SEGMENT.lastIndex;
    sawSegment = true;
  }

  // Require at least one segment and full consumption of the input.
  if (!sawSegment || cursor !== input.length) {
    throw new SyntaxError(
      `parseDuration: invalid duration string ${JSON.stringify(input)}`,
    );
  }

  return total;
}

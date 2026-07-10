/** Milliseconds represented by one of each supported unit. */
const UNIT_TO_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * A single `<amount><unit>` segment, matched with the sticky flag so segments
 * must be contiguous. The `ms` alternative precedes `m` so that `"500ms"` is
 * read as milliseconds rather than `500` minutes followed by a stray `s`.
 */
const SEGMENT = /(\d+)(ms|s|m|h|d)/y;

/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError(
      `parseDuration expected a string, received ${typeof input}`,
    );
  }

  SEGMENT.lastIndex = 0;
  let total = 0;
  let consumed = 0;
  let segments = 0;
  let match: RegExpExecArray | null;

  while ((match = SEGMENT.exec(input)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * UNIT_TO_MS[unit];
    consumed = SEGMENT.lastIndex;
    segments += 1;
  }

  if (segments === 0 || consumed !== input.length) {
    throw new SyntaxError(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  return total;
}

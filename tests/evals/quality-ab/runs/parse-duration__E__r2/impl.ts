/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  // Whitespace anywhere in the input is ignored.
  const cleaned = input.replace(/\s+/g, '');

  if (cleaned.length === 0) {
    throw new Error('parseDuration: empty input');
  }

  const unitToMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  // Match one <amount><unit> segment at a time. `ms` must precede `m` in the
  // alternation so "500ms" parses as milliseconds, not "500m" + leftover "s".
  const segment = /(\d+)(ms|s|m|h|d)/y;

  let total = 0;
  let pos = 0;
  let matched = false;

  segment.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = segment.exec(cleaned)) !== null) {
    matched = true;
    const amountStr = match[1];
    const unit = match[2];
    const unitMs = unit === undefined ? undefined : unitToMs[unit];
    if (amountStr === undefined || unitMs === undefined) {
      throw new Error(`parseDuration: invalid segment: ${JSON.stringify(input)}`);
    }
    total += Number(amountStr) * unitMs;
    pos = segment.lastIndex;
  }

  // The concatenation of segments must cover the entire cleaned input.
  if (!matched || pos !== cleaned.length) {
    throw new Error(`parseDuration: invalid duration string: ${JSON.stringify(input)}`);
  }

  return total;
}

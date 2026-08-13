/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  const UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  // Whitespace anywhere is ignored.
  const cleaned = input.replace(/\s+/g, '');

  if (cleaned.length === 0) {
    throw new Error(`Invalid duration: empty input ${JSON.stringify(input)}`);
  }

  // Match <digits><unit> segments. `ms` must precede `m` in the alternation
  // so "500ms" parses as milliseconds, not "500m" + trailing "s".
  const segment = /(\d+)(ms|s|m|h|d)/y;

  let total = 0;
  let matched = false;
  let lastIndex = 0;

  segment.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = segment.exec(cleaned)) !== null) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * UNIT_MS[unit];
    lastIndex = segment.lastIndex;
  }

  // The sticky regex must have consumed the entire cleaned string; any
  // leftover means an unrecognized unit, a number without a unit, or stray
  // characters.
  if (!matched || lastIndex !== cleaned.length) {
    throw new Error(`Invalid duration: ${JSON.stringify(input)}`);
  }

  return total;
}

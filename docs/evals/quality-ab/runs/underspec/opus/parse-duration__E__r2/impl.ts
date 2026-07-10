/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string') {
    throw new TypeError('parseDuration: input must be a string');
  }
  if (input.length === 0) {
    throw new Error('parseDuration: input must not be empty');
  }

  // Milliseconds per unit. Order in the alternation below matters:
  // `ms` must be tried before `m` so "500ms" is not read as "500m" + "s".
  const UNIT_MS: Record<string, number> = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };

  // Sticky regex: each match must start exactly where the previous one ended,
  // guaranteeing the whole string is a run of <amount><unit> segments with
  // no gaps, stray characters, or trailing junk.
  const segment = /(\d+)(ms|s|m|h|d)/y;

  let total = 0;
  let matched = false;
  let endIndex = 0;

  segment.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = segment.exec(input)) !== null) {
    matched = true;
    const amount = Number(m[1]);
    const unit = m[2];
    total += amount * UNIT_MS[unit];
    endIndex = segment.lastIndex;
  }

  if (!matched || endIndex !== input.length) {
    throw new Error(
      `parseDuration: invalid duration string: ${JSON.stringify(input)}`,
    );
  }

  return total;
}

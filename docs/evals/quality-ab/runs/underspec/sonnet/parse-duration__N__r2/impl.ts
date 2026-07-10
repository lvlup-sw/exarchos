/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  const unitToMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  // Sticky regex so each match must start exactly where the previous one ended.
  // "ms" is listed before "s"/"m" so it is preferred over the single-letter units.
  const segmentRegex = /(\d+)(ms|s|m|h|d)/y;

  let total = 0;
  let index = 0;
  let matchedAny = false;

  while (index < input.length) {
    segmentRegex.lastIndex = index;
    const match = segmentRegex.exec(input);

    if (!match || match.index !== index) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    const amount = Number(match[1]);
    const unit = match[2];
    total += amount * unitToMs[unit];

    index += match[0].length;
    matchedAny = true;
  }

  if (!matchedAny) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  return total;
}

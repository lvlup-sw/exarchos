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

  // Sticky regex: matches a "<digits><unit>" segment starting exactly at lastIndex.
  const segmentRegex = /(\d+)(ms|s|m|h|d)/y;

  let total = 0;
  let index = 0;
  let matchedAny = false;

  while (index < input.length) {
    segmentRegex.lastIndex = index;
    const match = segmentRegex.exec(input);
    if (!match) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    const [full, amountStr, unit] = match;
    const amount = Number(amountStr);
    total += amount * unitToMs[unit];
    index += full.length;
    matchedAny = true;
  }

  if (!matchedAny) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  return total;
}

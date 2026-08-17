/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  // Whitespace anywhere is ignored.
  const normalized = input.replace(/\s+/g, '');

  if (normalized.length === 0) {
    throw new Error(`Invalid duration: empty input`);
  }

  const unitToMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  // One or more <amount><unit> segments. `ms` must be tried before `s`/`m`.
  const segmentPattern = /(\d+)(ms|s|m|h|d)/g;

  let total = 0;
  let lastIndex = 0;
  let matched = false;

  for (const match of normalized.matchAll(segmentPattern)) {
    // Reject anything between the previous match and this one.
    if (match.index !== lastIndex) {
      throw new Error(`Invalid duration: ${input}`);
    }
    matched = true;
    const amount = Number.parseInt(match[1], 10);
    const unit = match[2];
    total += amount * unitToMs[unit];
    lastIndex = match.index + match[0].length;
  }

  // Ensure the entire string was consumed by valid segments.
  if (!matched || lastIndex !== normalized.length) {
    throw new Error(`Invalid duration: ${input}`);
  }

  return total;
}

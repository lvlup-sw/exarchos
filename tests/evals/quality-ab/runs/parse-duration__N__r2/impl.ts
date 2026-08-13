/** Parse a human duration string into a total number of milliseconds. */
export function parseDuration(input: string): number {
  // Whitespace anywhere in the input is ignored.
  const stripped = input.replace(/\s+/g, '');

  if (stripped.length === 0) {
    throw new Error(`Invalid duration: empty input`);
  }

  // Milliseconds per unit. `ms` must precede `s`/`m` in the alternation so the
  // longer match wins (e.g. "500ms" is 500 milliseconds, not 500 minutes).
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  const segment = /(\d+)(ms|s|m|h|d)/y;
  let total = 0;
  let matched = false;

  while (segment.lastIndex < stripped.length) {
    const match = segment.exec(stripped);
    if (match === null) {
      throw new Error(`Invalid duration: ${JSON.stringify(input)}`);
    }
    matched = true;
    const amount = Number(match[1]);
    total += amount * unitMs[match[2]];
  }

  if (!matched) {
    throw new Error(`Invalid duration: ${JSON.stringify(input)}`);
  }

  return total;
}

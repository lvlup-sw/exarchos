/** Parse a human duration string into a total number of milliseconds. */

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

// Matches one <amount><unit> segment. Order of alternation matters: "ms"
// must be tried before "m" and "s" so it isn't shadowed by the shorter units.
const SEGMENT_RE = /(\d+)(ms|s|m|h|d)/g;

export function parseDuration(input: string): number {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  let total = 0;
  let cursor = 0;
  let matchedAny = false;

  SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SEGMENT_RE.exec(input)) !== null) {
    // Reject gaps/garbage between segments (e.g. "1h x30m", "1hh30m").
    if (match.index !== cursor) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    matchedAny = true;
    const amountStr = match[1];
    const unit = match[2];
    const msPerUnit = UNIT_TO_MS[unit];

    if (msPerUnit === undefined) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
      throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
    }

    total += amount * msPerUnit;
    cursor = SEGMENT_RE.lastIndex;
  }

  // Nothing matched at all, or trailing garbage after the last segment.
  if (!matchedAny || cursor !== input.length) {
    throw new Error(`Invalid duration string: ${JSON.stringify(input)}`);
  }

  return total;
}

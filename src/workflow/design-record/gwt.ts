/** Shared keyword detection preserves the legacy Given/When/Then advisory rule. */
const gwtPattern = /(?:\*\*(Given|When|Then)\*\*|^[-*]\s+(Given|When|Then)\b|^\s+[-*]\s+(Given|When|Then)\b|(Given|When|Then)\s*:)/i;

export function extractGwtKeyword(line: string): string | null {
  const m = gwtPattern.exec(line);
  if (!m) return null;
  const kw = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
  return kw;
}

/** Each keyword must occur in the requirement body. The legacy detector reads one keyword per line. */
export function hasGwtCriteria(body: string): boolean {
  return new Set(body.split('\n').map(extractGwtKeyword).filter((keyword) => keyword !== null)).size === 3;
}

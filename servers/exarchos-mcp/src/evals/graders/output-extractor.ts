/**
 * Extracts text from eval output using an optional dot-notation path.
 * Returns null when a path is specified but does not resolve — callers
 * should treat null as "field not present" and skip grading.
 * Falls back to JSON.stringify of the entire output when no path is given.
 */
export function extractOutputText(output: Record<string, unknown>, outputPath?: string): string | null {
  if (!outputPath) return JSON.stringify(output);

  const parts = outputPath.split('.');
  let current: unknown = output;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined) return null;
  if (typeof current === 'string') return current;
  return JSON.stringify(current);
}

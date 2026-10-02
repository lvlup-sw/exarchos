/**
 * Extracts text from eval output with an optional dot-notation path.
 * It returns null when the path does not resolve. Null means that the field is not present, and the caller must skip the grade.
 * When no path is given, it returns `JSON.stringify` of the whole output.
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

/**
 * Extracts text from eval output using an optional dot-notation path.
 * Falls back to JSON.stringify of the entire output if the path is missing or invalid.
 */
export function extractOutputText(output: Record<string, unknown>, outputPath?: string): string {
  if (!outputPath) return JSON.stringify(output);

  const parts = outputPath.split('.');
  let current: unknown = output;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return JSON.stringify(output);
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (current === undefined) return JSON.stringify(output);
  if (typeof current === 'string') return current;
  return JSON.stringify(current);
}

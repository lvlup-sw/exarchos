import * as fs from 'node:fs/promises';
import type { z } from 'zod';

/**
 * Load and validate records from a JSONL file against a Zod schema.
 *
 * Each non-blank line is parsed as JSON and validated against the provided schema.
 * Throws with line number on parse or validation errors.
 */
export async function loadJsonl<S extends z.ZodTypeAny>(
  filePath: string,
  schema: S,
): Promise<z.output<S>[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const records: z.output<S>[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    const lineNumber = i + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON at line ${lineNumber}: ${line}`);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const fieldPath = firstIssue.path.join('.');
      const fieldInfo = fieldPath ? ` (field: ${fieldPath})` : ` (field: ${firstIssue.code})`;
      throw new Error(
        `Schema validation failed at line ${lineNumber}${fieldInfo}: ${firstIssue.message}`,
      );
    }

    records.push(result.data as z.output<S>);
  }

  return records;
}

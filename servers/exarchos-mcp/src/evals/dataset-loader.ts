import * as fs from 'node:fs/promises';
import { EvalCaseSchema, type EvalCase } from './types.js';

/**
 * Load eval cases from a JSONL file, optionally filtering by tags.
 *
 * Each non-blank line is parsed as JSON and validated against EvalCaseSchema.
 * Throws with line number on parse or validation errors.
 */
export async function loadDataset(
  filePath: string,
  filter?: { tags?: string[] },
): Promise<EvalCase[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const cases: EvalCase[] = [];

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

    const result = EvalCaseSchema.safeParse(parsed);
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const fieldPath = firstIssue.path.join('.');
      const fieldInfo = fieldPath ? ` (field: ${fieldPath})` : ` (field: ${firstIssue.code})`;
      throw new Error(
        `Schema validation failed at line ${lineNumber}${fieldInfo}: ${firstIssue.message}`,
      );
    }

    cases.push(result.data);
  }

  if (!filter?.tags || filter.tags.length === 0) {
    return cases;
  }

  const filterTags = new Set(filter.tags);
  return cases.filter((c) => c.tags.some((tag) => filterTags.has(tag)));
}

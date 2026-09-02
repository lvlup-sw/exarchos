import { EvalCaseSchema, type EvalCase } from './types.js';
import { loadJsonl } from './jsonl-reader.js';

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
  const cases = await loadJsonl(filePath, EvalCaseSchema);

  if (!filter?.tags || filter.tags.length === 0) {
    return cases;
  }

  const filterTags = new Set(filter.tags);
  return cases.filter((c) => c.tags.some((tag) => filterTags.has(tag)));
}

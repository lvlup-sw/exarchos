/**
 * Contract-seam lint (DR-10).
 *
 * Every top-level exported Zod schema in `invariant-schema.ts` is the
 * hand-written stand-in for a future `Strategos.Contracts` TypeSpec model.
 * To keep the "hand-written now, generated later" seam honest, each such
 * export must carry a `// contract-shaped: <ModelName>` comment on the line
 * immediately above it.
 *
 * This lint reads the schema source and returns a finding for any exported
 * schema missing its seam comment. It introduces NO runtime dependency on
 * Strategos.Contracts — it is a pure source-text check.
 */
import fs from 'node:fs';
import type { PluginFinding } from '../../../servers/exarchos-mcp/src/review/check-catalog.js';

/** Matches `export const FooSchema = ...` declarations. */
const EXPORTED_SCHEMA_RE = /^export\s+const\s+([A-Za-z0-9_]+Schema)\b/;

/** Matches a `// contract-shaped: <Name>` seam comment. */
const SEAM_COMMENT_RE = /^\s*\/\/\s*contract-shaped:\s*\S+/;

/**
 * Lint the seam comments in a schema module.
 *
 * @param filePath Path to the schema source (used for the finding's `file`,
 *   and read from disk when `source` is not supplied).
 * @param source  Optional source text (dependency injection for tests). When
 *   omitted the file at `filePath` is read.
 * @returns One finding per exported `*Schema` lacking a `// contract-shaped:`
 *   comment on the immediately-preceding non-blank line.
 */
export function lintSeamComments(
  filePath: string,
  source?: string,
): PluginFinding[] {
  const text = source ?? fs.readFileSync(filePath, 'utf8');
  const lines = text.split('\n');
  const findings: PluginFinding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = EXPORTED_SCHEMA_RE.exec(lines[i] ?? '');
    if (!match) continue;
    const schemaName = match[1];

    // Walk back over blank lines to the nearest non-blank line.
    let j = i - 1;
    while (j >= 0 && lines[j]?.trim() === '') j--;
    const hasSeam = j >= 0 && SEAM_COMMENT_RE.test(lines[j] ?? '');

    if (!hasSeam) {
      findings.push({
        source: 'contract-seam',
        severity: 'HIGH',
        file: filePath,
        line: i + 1,
        message:
          `Exported schema '${schemaName}' is missing a ` +
          `'// contract-shaped: <Model>' seam comment on the line above it.`,
      });
    }
  }

  return findings;
}

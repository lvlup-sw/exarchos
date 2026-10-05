// Grep gates: source-tree checks for invariants that the type system cannot express.
// Each gate walks a directory, scans for a forbidden token, and fails on a match in a file that
// is not exempt.
//
// The gates walk with `node:fs` and do not call `git grep`. A shell call needs a shell and git.
// The walk runs the same in CI, locally, in an agent worktree and on Windows.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ESM has no `__dirname`, so the file derives it from `import.meta.url`. */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** The root of each source walk. The path is relative to this file in `tests/unit/events`. */
const SRC_ROOT = join(__dirname, '../../../src');

/**
 * The repository root, one level above `SRC_ROOT`. The action-set gate also scans the content
 * trees at this root.
 */
const REPO_ROOT = join(SRC_ROOT, '..');

/**
 * Walks a directory recursively and yields the absolute path of each file that `accept` admits.
 * It does not enter a directory whose name is in `excludeDirs`.
 */
function* walk(
  dir: string,
  accept: (file: string) => boolean,
  excludeDirs: ReadonlySet<string>,
): Generator<string> {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (excludeDirs.has(entry)) continue;
      yield* walk(full, accept, excludeDirs);
    } else if (st.isFile() && accept(full)) {
      yield full;
    }
  }
}

describe('Grep Gates (Wave 1, R-1, #1313)', () => {
  /**
   * No production code can issue `UPDATE streams SET workflow_type`. The column is immutable after
   * the insert. The recovery backfill of the migration in `sqlite-backend.ts` is the only allowed
   * UPDATE, and that file is exempt. Another write can replace the registered type of a stream.
   * `events/event-migration.ts` is also exempt, although it holds no such UPDATE.
   * The gate tests one line at a time, so it does not see a statement that spans two lines.
   */
  it('GrepGate_NoUpdateStreamsSetWorkflowType', () => {
    const pattern = /UPDATE\s+streams\s+SET\s+workflow_type/i;

    const exempt = new Set<string>([
      join(SRC_ROOT, 'storage', 'sqlite-backend.ts'),
      join(SRC_ROOT, 'events', 'event-migration.ts'),
      join(SRC_ROOT, '../tests/unit/events/grep-gates.test.ts'),
    ]);

    const matches: Array<{ file: string; line: number; text: string }> = [];
    const accept = (f: string) =>
      (f.endsWith('.ts') || f.endsWith('.tsx')) && !exempt.has(f);
    const excludeDirs = new Set<string>(['node_modules', 'dist', '__shims__']);

    for (const file of walk(SRC_ROOT, accept, excludeDirs)) {
      const contents = readFileSync(file, 'utf-8');
      const lines = contents.split('\n');
      lines.forEach((text, i) => {
        if (pattern.test(text)) {
          matches.push({ file: relative(SRC_ROOT, file), line: i + 1, text });
        }
      });
    }

    expect(
      matches,
      `Found forbidden UPDATE streams SET workflow_type writes:\n` +
        matches.map((m) => `  ${m.file}:${m.line}: ${m.text.trim()}`).join('\n'),
    ).toEqual([]);
  });

  /**
   * No agent-facing surface can declare or document `exarchos_workflow` with `action: 'set'`.
   * The workflow tool has no `set` action, and the canonical name is `update`. An agent that
   * copies a stale payload calls an unregistered action and fails at the MCP schema boundary.
   *
   * Scope: the production TypeScript in `src/workflow/`, and the markdown in `rendered/commands`
   * and `content`. Test files are out of scope, because they probe the rejection of the old action.
   * `handlers/set.ts` is exempt: its event payload `data: { action: 'set' }` names the substrate
   * handler, and old streams replay with that identifier.
   * The `action:` anchor in the pattern prevents a match on `Set` or on the verb in prose.
   */
  it('GrepGate_NoActionSetOnExarchosWorkflowSurfaces', () => {
    const pattern = /action:\s*['"]set['"]|["']action["']:\s*["']set["']/;

    type Match = { file: string; line: number; text: string };
    const matches: Match[] = [];

    const tsExempt = new Set<string>([
      join(SRC_ROOT, 'workflow', 'handlers', 'set.ts'),
    ]);
    {
      const accept = (f: string) =>
        (f.endsWith('.ts') || f.endsWith('.tsx')) &&
        !f.endsWith('.test.ts') &&
        !f.endsWith('.test.tsx') &&
        !tsExempt.has(f);
      const excludeDirs = new Set<string>(['node_modules', 'dist', '__shims__']);
      const tsRoot = join(SRC_ROOT, 'workflow');
      for (const file of walk(tsRoot, accept, excludeDirs)) {
        const contents = readFileSync(file, 'utf-8');
        contents.split('\n').forEach((text, i) => {
          if (pattern.test(text)) {
            matches.push({ file: relative(REPO_ROOT, file), line: i + 1, text });
          }
        });
      }
    }

    {
      const accept = (f: string) => f.endsWith('.md');
      const excludeDirs = new Set<string>(['node_modules', 'dist']);
      for (const root of [join(REPO_ROOT, 'rendered/commands'), join(REPO_ROOT, 'content')]) {
        for (const file of walk(root, accept, excludeDirs)) {
          const contents = readFileSync(file, 'utf-8');
          contents.split('\n').forEach((text, i) => {
            if (pattern.test(text)) {
              matches.push({ file: relative(REPO_ROOT, file), line: i + 1, text });
            }
          });
        }
      }
    }

    expect(
      matches,
      `Found forbidden \`action: 'set'\` references on exarchos_workflow surfaces. ` +
        `Action 'set' was removed in v2.11 (#1332); use canonical 'update' ` +
        `(#1340 / Wave 0). Offending sites:\n` +
        matches.map((m) => `  ${m.file}:${m.line}: ${m.text.trim()}`).join('\n'),
    ).toEqual([]);
  });
});

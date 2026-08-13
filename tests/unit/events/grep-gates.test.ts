// ─── Wave 1 (R-1, #1313): grep-gate CI checks ────────────────────────────
//
// Compile-time invariants that the type system can't express live here as
// source-tree grep checks. Each gate walks `src/` (or
// a focused subset), scans for a forbidden token, and fails when any
// match appears in non-exempt files.
//
// Why a JS file walker rather than `git grep` shelled out: the test must
// run identically under vitest in CI, locally, and inside agent
// worktrees. Shelling out adds shell + git availability assumptions and
// loses the cross-platform guarantee. Walking with `node:fs` keeps the
// gate self-contained and Windows-safe.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// `__dirname` is unavailable under NodeNext ESM — derive it from
// `import.meta.url` so the gate runs identically under Node and Bun.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Anchor walks at src so the gate's reach matches
// what we care about (production handlers + tests, not docs / scripts /
// node_modules). Computed relative to this test file: this file lives
// at src/events/grep-gates.test.ts; the src
// root is two levels up.
const SRC_ROOT = join(__dirname, '../../../src');

// Repository root — one level above SRC_ROOT since task 019 made `src/`
// a direct child of it. The action-set gate (Wave 5 / Task 5.4) scans
// `commands/` and `content/` at the repo root in addition to the core's
// workflow surfaces.
const REPO_ROOT = join(SRC_ROOT, '..');

/**
 * Walk a directory recursively and yield absolute paths of files matching
 * `accept`. Skips entries in `excludeDirs` (basename match) so we don't
 * descend into vendored deps or generated artifacts.
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
  it('GrepGate_NoUpdateStreamsSetWorkflowType', () => {
    // Forbids any production code path from issuing
    //   UPDATE streams SET workflow_type ...
    // The column is immutable post-insert; the migration's recovery
    // backfill (sqlite-backend.ts:backfillWorkflowTypeFromStateFiles) is
    // the ONLY allowed UPDATE and lives in an exempt file. Any other
    // mutation would silently overwrite a stream's typed registry entry,
    // breaking the v2.12 filtered ps view's referential integrity.
    const pattern = /UPDATE\s+streams\s+SET\s+workflow_type/i;

    // Exemptions:
    //   - sqlite-backend.ts: the migration's authorized UPDATE lives here.
    //   - sqlite-backend.ts comments / DDL strings reference the gate.
    //   - event-migration.ts: hosts the per-event migration registry; not
    //     used today but kept for symmetry with the design wording.
    //   - This test file itself: contains the forbidden pattern as a
    //     regex literal.
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

  it('GrepGate_NoActionSetOnExarchosWorkflowSurfaces', () => {
    // Wave 5 / Task 5.4 (#1341): forbids any agent-facing surface from
    // declaring or documenting `exarchos_workflow` with `action: 'set'`.
    //
    // Background: `action: 'set'` was removed from the workflow tool
    // registry in v2.11's DR-4 substrate cut (#1332) and reintroduced
    // under the canonical name `action: 'update'` by Wave 0 of
    // v2.10.0-preview.2 (#1340). Any remaining reference (in TS, in
    // skill prose, or in command markdown) causes agents that copy the
    // payload verbatim to invoke an unregistered action and fail at
    // the MCP schema boundary.
    //
    // Scope: workflow-mutation TS code (`src/workflow/`)
    // plus the two agent-facing content trees (`commands/`, `content/`).
    // The generated `skills/` tree is intentionally NOT scanned — it
    // mirrors `content/` via `npm run build:skills` and is already
    // protected by `npm run skills:guard`. Scanning it again would
    // double-count violations and obscure the actionable source.
    //
    // Pattern: matches `action: "set"`, `action: 'set'`, and
    // `"action": "set"` (the JSON shape sometimes shown inside fenced
    // examples). The `action:` anchor prevents false positives on
    // unrelated tokens like `Set` (capital) or `set` as a verb in prose.
    const pattern = /action:\s*['"]set['"]|["']action["']:\s*["']set["']/;

    type Match = { file: string; line: number; text: string };
    const matches: Match[] = [];

    // ── Scope 1: workflow TS surfaces (production code, not tests) ────
    //
    // The gate fences agent-facing payload construction. We exempt:
    //   - `*.test.ts` files inside `workflow/`: tests intentionally
    //     probe the renamed-action rejection path
    //     (composite.test.ts:'set action (DR-4 hard-cut)') and assert
    //     historical event payload shapes (`hsm.deprecated_action_invoked`
    //     records `'set({phase})'`). These are load-bearing negative
    //     tests; rewriting them would erase the regression guard the
    //     hard cut depends on.
    //   - The `tools.ts` checkpoint-state-missing event payload
    //     (`data: { action: 'set' }`): this is an internal event-data
    //     field naming the substrate handler, not an agent-facing
    //     `exarchos_workflow` action. Keeping the historical identifier
    //     preserves event-log replayability for streams written before
    //     the rename.
    const tsExempt = new Set<string>([
      join(SRC_ROOT, 'workflow', 'tools.ts'),
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

    // ── Scope 2: agent-facing markdown (commands + content) ───────
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

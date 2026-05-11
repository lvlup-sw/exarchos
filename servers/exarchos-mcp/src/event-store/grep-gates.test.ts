// ─── Wave 1 (R-1, #1313): grep-gate CI checks ────────────────────────────
//
// Compile-time invariants that the type system can't express live here as
// source-tree grep checks. Each gate walks `servers/exarchos-mcp/src/` (or
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
import { join, relative } from 'node:path';

// Anchor walks at servers/exarchos-mcp/src so the gate's reach matches
// what we care about (production handlers + tests, not docs / scripts /
// node_modules). Computed relative to this test file: this file lives
// at servers/exarchos-mcp/src/event-store/grep-gates.test.ts; the src
// root is two levels up.
const SRC_ROOT = join(__dirname, '..');

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
      join(SRC_ROOT, 'event-store', 'event-migration.ts'),
      join(SRC_ROOT, 'event-store', 'grep-gates.test.ts'),
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
});

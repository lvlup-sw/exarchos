import { describe, it, expect } from 'vitest';
import { readdir, stat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * T61 — AtomicAppender consumer enumeration witness (DR-13 AC3, #1259).
 *
 * Two complementary witnesses guard the seam:
 *
 *   T49 (poc.acceptance.test.ts AC3) — substring match, catches doc/comment
 *   coupling drift across all production .ts files (excluding tests +
 *   benches). Currently 7 sites; that count includes files that mention
 *   `AtomicAppender` only in jsdoc/comments.
 *
 *   T61 (this file) — strict `import .* AtomicAppender` regex, catches drift
 *   in the IMPORT graph specifically. Currently 3 sites; any addition or
 *   removal must be acknowledged by updating the frozen baseline below.
 *
 * Both witnesses are intentional: T49 measures doc-coupling (prose
 * references that would also need updating if the seam changed); T61
 * measures actual-import drift (the call sites whose code path runs
 * through AtomicAppender). They are not redundant; they catch different
 * regressions.
 *
 * Removing a consumer (e.g. a v2.10 retirement of jsonl-importer) requires
 * updating the baseline AND the corresponding T49 list. Adding a consumer
 * requires updating the baseline AND confirming the new caller doesn't
 * reach into AtomicAppender internals (the seam contract from DR-13).
 *
 * NOTE: this test file deliberately does NOT import AtomicAppender — doing
 * so would create a fourth match and break the assertion. We read files as
 * text only.
 */

const FROZEN_IMPORT_BASELINE = [
  'src/events/store.ts',
  // WLM operational-core (#1578): the serialize_merge optimistic lease claims
  // the worktrees stream via the AtomicAppender decide seam.
  'src/verbs/worktree/merge-serializer.ts',
] as const;

/**
 * Resolve `servers/exarchos-mcp/src` from this file's URL. The test sits
 * at `src/events/atomic-appender-consumers.test.ts`, so two `..`
 * jumps land at `src/`.
 */
function resolveSrcRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

/**
 * Recursively walk `dir` and return every production `.ts` file path
 * (relative to `dir`'s parent — i.e. starting with `src/...`) that does
 * NOT live under `__tests__/` or `__shims__/` and does NOT end with
 * `.test.ts` or `.bench.ts`.
 */
async function listProductionTsFiles(srcRoot: string): Promise<string[]> {
  const results: string[] = [];
  const repoRoot = path.dirname(srcRoot); // .../servers/exarchos-mcp

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir);
    for (const name of entries) {
      const full = path.join(dir, name);
      const st = await stat(full);
      if (st.isDirectory()) {
        if (name === '__tests__' || name === '__shims__') continue;
        await walk(full);
        continue;
      }
      if (!st.isFile()) continue;
      if (!name.endsWith('.ts')) continue;
      if (name.endsWith('.test.ts')) continue;
      if (name.endsWith('.bench.ts')) continue;
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      results.push(rel);
    }
  }

  await walk(srcRoot);
  return results;
}

/**
 * Per-line `import` regex. Anchored to line starts (multiline flag); allows
 * leading whitespace, any import flavor (`import {}`, `import type {}`,
 * `import * as X`, default import), and trailing tokens before the
 * semicolon. The `\bAtomicAppender\b` boundary prevents partial-name
 * matches (e.g. a hypothetical `AtomicAppenderShim`).
 */
const IMPORT_REGEX = /^\s*import\b[^;]*\bAtomicAppender\b/m;

describe('AtomicAppender_ConsumerCount_MatchesBaselineEnumeration', () => {
  it('exactly the frozen-baseline production .ts files import AtomicAppender', async () => {
    const srcRoot = resolveSrcRoot();
    const repoRoot = path.dirname(srcRoot);
    const candidates = await listProductionTsFiles(srcRoot);

    const consumers: string[] = [];
    for (const rel of candidates) {
      const abs = path.join(repoRoot, rel);
      const text = await readFile(abs, 'utf-8');
      if (IMPORT_REGEX.test(text)) {
        consumers.push(rel);
      }
    }

    consumers.sort();
    expect(consumers).toEqual([...FROZEN_IMPORT_BASELINE]);
  });
});

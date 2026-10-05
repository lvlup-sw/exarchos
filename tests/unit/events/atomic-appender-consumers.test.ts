/**
 * The production files that import `AtomicAppender` must equal a frozen baseline.
 *
 * Two suites guard the seam. The AC3 test in `poc.acceptance.test.ts` matches the substring
 * `AtomicAppender`, so it also finds a mention in a comment. This suite matches an `import`
 * statement, so it finds a change in the import graph only.
 *
 * To add or remove a consumer, update the baseline here and the list in `poc.acceptance.test.ts`.
 * A new consumer must not reach into the internals of `AtomicAppender`.
 */
import { describe, it, expect } from 'vitest';
import { readdir, stat, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The files under `src/` that import `AtomicAppender`, in sorted order. */
const FROZEN_IMPORT_BASELINE = [
  'src/events/store.ts',
  /** The `serialize_merge` optimistic lease claims the worktrees stream through the `decide` seam. */
  'src/verbs/worktree/merge-serializer.ts',
] as const;

/** Resolves `src` from the URL of this file. */
function resolveSrcRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../src');
}

/**
 * Walks `srcRoot` and returns each production `.ts` file as a path that starts with `src/`.
 * It skips the `__tests__` and `__shims__` directories, and the `.test.ts` and `.bench.ts` files.
 */
async function listProductionTsFiles(srcRoot: string): Promise<string[]> {
  const results: string[] = [];
  const repoRoot = path.dirname(srcRoot);

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
 * Matches each form of `import` statement that names `AtomicAppender`. The match starts at an
 * `import` at a line start and reaches `AtomicAppender` before the next semicolon. The `\b`
 * boundaries reject a longer name such as `AtomicAppenderShim`.
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

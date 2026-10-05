/**
 * Acceptance test for the consumers of the SQLite event-store substrate.
 *
 * The files under `src/` that name `AtomicAppender` must be exactly the listed consumers.
 * A new consumer, or a lost one, fails the test.
 * `append-cost-budget.test.ts` gates append throughput with exact statement counts.
 * `store.bench.ts` only reports speed.
 */

import { describe, it, expect } from 'vitest';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Each file under `src/` whose text holds `AtomicAppender`, in sorted order.
 * The match is on the substring, so a mention in a comment also counts.
 */
const EXPECTED_CONSUMERS = [
  'src/events/atomic-appender.ts',
  'src/events/index.ts',
  'src/events/store.ts',
  /**
   * The four SQLite files hold the declarations that the appender shares with the database. They are the
   * error family, the DDL, the prepared statements and the wire types.
   */
  'src/storage/sqlite/errors.ts',
  'src/storage/sqlite/schema.ts',
  'src/storage/sqlite/statements.ts',
  'src/storage/sqlite/wire-types.ts',
  'src/verbs/merge/execute-merge.ts',
  'src/verbs/merge/merge-orchestrate.ts',
  'src/verbs/worktree/merge-serializer.ts',
  /** The admission chokepoint appends its decision and the lifecycle event in one transaction. */
  'src/workflow/admission/transition-command.ts',
] as const;

/** Resolve the `src` directory of the repository from the URL of this file. */
function resolveSrcRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../src');
}

/**
 * List each production `.ts` file below `srcRoot`, as a `src/...` path with `/` separators.
 * The walk skips `__tests__` and `__shims__` directories, and `.test.ts` and `.bench.ts` files.
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

describe('Poc_SqliteBackend_AllConsumersUnchanged', () => {
  it('AC3 — exactly the expected src consumers reference AtomicAppender', async () => {
    const srcRoot = resolveSrcRoot();
    const candidates = await listProductionTsFiles(srcRoot);

    const consumers: string[] = [];
    for (const rel of candidates) {
      const repoRoot = path.dirname(srcRoot);
      const abs = path.join(repoRoot, rel);
      const text = await readFile(abs, 'utf-8');
      if (text.includes('AtomicAppender')) {
        consumers.push(rel);
      }
    }
    consumers.sort();

    expect(consumers).toEqual([...EXPECTED_CONSUMERS]);
  });

});

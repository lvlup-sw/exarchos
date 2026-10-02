/**
 * These assertions compare two populations that cannot observe each other. `tracked-population`
 * asks git what the repository contains. The walks it corroborates ask the filesystem.
 *
 * A guard that judges itself by its own walk agrees with itself by construction. Git is the
 * second authority because it is not the walker.
 *
 * @oracle-sources: ./tracked-population.ts, the filesystem walks it is compared against
 */
import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTrackedFiles, countTrackedFiles, trackedFilesMissedBy } from './tracked-population.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const REPO_ROOT = join(HERE, '..', '..');

describe('tracked-population — the second authority is itself checked', () => {
  it('TrackedPopulation_ListsRootRelativeForwardSlashedPaths', async () => {
    const files = await listTrackedFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('test-helpers/tracked-population.ts');
    expect(files.every((f) => !f.includes('\\'))).toBe(true);
    expect(files.every((f) => !f.startsWith('/'))).toBe(true);
  });

  it('TrackedPopulation_IsSortedAndDeduplicatedByGit', async () => {
    const files = await listTrackedFiles(SRC_ROOT);
    expect([...files].sort()).toEqual(files);
    expect(new Set(files).size).toBe(files.length);
  });

  /**
   * A repo-root query is the case that matters. `dist/` holds real build output and
   * `.claude/worktrees/` holds full sibling checkouts. A walk into either counts the same
   * modules many times. The last assertion proves that the query resolved a real repository.
   */
  it('TrackedPopulation_ExcludesBuildOutputAndDotDirsByProperty', async () => {
    const files = await listTrackedFiles(REPO_ROOT);
    expect(files.filter((f) => f.split('/').includes('dist'))).toEqual([]);
    expect(files.filter((f) => f.split('/').includes('node_modules'))).toEqual([]);
    expect(files.filter((f) => f.split('/').some((s) => s.startsWith('.')))).toEqual([]);
    expect(files).toContain('tools/test-helpers/tracked-population.ts');
  });

  it('TrackedPopulation_HonorsTheCallerSuppliedExclusion', async () => {
    const all = await listTrackedFiles(SRC_ROOT);
    const production = await listTrackedFiles(SRC_ROOT, {
      exclude: (path) => path.endsWith('.test.ts'),
    });
    expect(production.length).toBeLessThan(all.length);
    expect(production.filter((f) => f.endsWith('.test.ts'))).toEqual([]);
    expect(await countTrackedFiles(SRC_ROOT)).toBe(all.length);
  });

  it('TrackedPopulation_SelectsByExtension', async () => {
    const markdown = await listTrackedFiles(join(REPO_ROOT, 'content'), { extensions: ['.md'] });
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown.every((f) => f.endsWith('.md'))).toBe(true);
  });

  /**
   * An authority that answers zero corroborates nothing. If it returns `[]`, every
   * `expect(missed).toEqual([])` built on it passes vacuously. An exclusion that rejects every
   * file must throw too, because an over-wide exclusion hides files as a moved root does.
   */
  it('TrackedPopulation_EmptyResult_ThrowsRatherThanCorroboratingNothing', async () => {
    await expect(listTrackedFiles(SRC_ROOT, { extensions: ['.no-such-extension'] })).rejects.toThrow(
      /second authority is empty/,
    );
    await expect(listTrackedFiles(SRC_ROOT, { exclude: () => true })).rejects.toThrow(
      /second authority is empty/,
    );
  });

  /** Extra files in the walk are not a finding. Only a shortfall is a finding. */
  it('TrackedPopulation_MissedFiles_NamesWhatAWalkDidNotReach', () => {
    const tracked = ['a.ts', 'b.ts', 'c.ts'];
    expect(trackedFilesMissedBy(['a.ts', 'b.ts', 'c.ts'], tracked)).toEqual([]);
    expect(trackedFilesMissedBy(['a.ts'], tracked)).toEqual(['b.ts', 'c.ts']);
    expect(trackedFilesMissedBy(['a.ts', 'b.ts', 'c.ts', 'scratch.ts'], tracked)).toEqual([]);
  });

  it('TrackedPopulation_MissedFiles_CapsTheReportSoAFailureStaysLegible', () => {
    const tracked = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, '0')}.ts`);
    const missed = trackedFilesMissedBy([], tracked);
    expect(missed).toHaveLength(21);
    expect(missed.at(-1)).toBe('…and 10 more');
  });
});

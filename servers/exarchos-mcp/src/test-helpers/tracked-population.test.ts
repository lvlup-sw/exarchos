import { describe, it, expect } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTrackedFiles, countTrackedFiles, trackedFilesMissedBy } from './tracked-population.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..');
const REPO_ROOT = join(SRC_ROOT, '..', '..', '..');

describe('tracked-population — the second authority is itself checked', () => {
  it('TrackedPopulation_ListsRootRelativeForwardSlashedPaths', () => {
    const files = listTrackedFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(0);
    // Root-relative (no leading `servers/`), forward-slashed on every platform.
    expect(files).toContain('test-helpers/tracked-population.ts');
    expect(files.every((f) => !f.includes('\\'))).toBe(true);
    expect(files.every((f) => !f.startsWith('/'))).toBe(true);
  });

  it('TrackedPopulation_IsSortedAndDeduplicatedByGit', () => {
    const files = listTrackedFiles(SRC_ROOT);
    expect([...files].sort()).toEqual(files);
    expect(new Set(files).size).toBe(files.length);
  });

  it('TrackedPopulation_ExcludesBuildOutputAndDotDirsByProperty', () => {
    // A repo-root query is the case that matters: `dist/` is real build output
    // and `.claude/worktrees/` holds complete sibling checkouts, so a walk that
    // recursed into either would count the same modules many times over.
    const files = listTrackedFiles(REPO_ROOT);
    expect(files.filter((f) => f.split('/').includes('dist'))).toEqual([]);
    expect(files.filter((f) => f.split('/').includes('node_modules'))).toEqual([]);
    expect(files.filter((f) => f.split('/').some((s) => s.startsWith('.')))).toEqual([]);
    // …and the query still resolved a real repository.
    expect(files).toContain('servers/exarchos-mcp/src/test-helpers/tracked-population.ts');
  });

  it('TrackedPopulation_HonorsTheCallerSuppliedExclusion', () => {
    const all = listTrackedFiles(SRC_ROOT);
    const production = listTrackedFiles(SRC_ROOT, {
      exclude: (path) => path.endsWith('.test.ts'),
    });
    expect(production.length).toBeLessThan(all.length);
    expect(production.filter((f) => f.endsWith('.test.ts'))).toEqual([]);
    expect(countTrackedFiles(SRC_ROOT)).toBe(all.length);
  });

  it('TrackedPopulation_SelectsByExtension', () => {
    const markdown = listTrackedFiles(join(REPO_ROOT, 'skills-src'), { extensions: ['.md'] });
    expect(markdown.length).toBeGreaterThan(0);
    expect(markdown.every((f) => f.endsWith('.md'))).toBe(true);
  });

  // ── The tooth on the tooth ────────────────────────────────────────────────
  // An authority that answers zero corroborates nothing. If it returned `[]`
  // instead of throwing, every `expect(missed).toEqual([])` built on it would
  // pass vacuously — the exact defect this module exists to catch, reproduced
  // inside the detector.
  it('TrackedPopulation_EmptyResult_ThrowsRatherThanCorroboratingNothing', () => {
    expect(() => listTrackedFiles(SRC_ROOT, { extensions: ['.no-such-extension'] })).toThrow(
      /second authority is empty/,
    );
    // Same tooth via an exclusion that rejects everything — an over-wide mirror
    // of a scanner's exclusions is as blinding as a moved root.
    expect(() => listTrackedFiles(SRC_ROOT, { exclude: () => true })).toThrow(
      /second authority is empty/,
    );
  });

  it('TrackedPopulation_MissedFiles_NamesWhatAWalkDidNotReach', () => {
    const tracked = ['a.ts', 'b.ts', 'c.ts'];
    expect(trackedFilesMissedBy(['a.ts', 'b.ts', 'c.ts'], tracked)).toEqual([]);
    expect(trackedFilesMissedBy(['a.ts'], tracked)).toEqual(['b.ts', 'c.ts']);
    // Extra modules in the walk are benign; only a shortfall is a finding.
    expect(trackedFilesMissedBy(['a.ts', 'b.ts', 'c.ts', 'scratch.ts'], tracked)).toEqual([]);
  });

  it('TrackedPopulation_MissedFiles_CapsTheReportSoAFailureStaysLegible', () => {
    const tracked = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, '0')}.ts`);
    const missed = trackedFilesMissedBy([], tracked);
    expect(missed).toHaveLength(21);
    expect(missed.at(-1)).toBe('…and 10 more');
  });
});

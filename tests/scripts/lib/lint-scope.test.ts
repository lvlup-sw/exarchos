/**
 * @fileoverview Tests for the shared lint scope, and the check that its consumers agree with it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LINT_GLOBS, expandBraces, globsMatch, isInLintScope } from '../../../tools/audit/lib/lint-scope.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

describe('expandBraces', () => {
  it('ExpandBraces_NestedSets_ExpandToEveryCombination', () => {
    expect(expandBraces('{a,b}/*.{x,y}').sort()).toEqual(['a/*.x', 'a/*.y', 'b/*.x', 'b/*.y']);
    expect(expandBraces('plain/**')).toEqual(['plain/**']);
  });
});

describe('globsMatch', () => {
  it('GlobsMatch_DoubleStarCrossesDirectoriesAndSingleStarDoesNot', () => {
    expect(globsMatch(['a/**/c.ts'], 'a/b/d/c.ts')).toBe(true);
    expect(globsMatch(['a/**/c.ts'], 'a/c.ts')).toBe(true);
    expect(globsMatch(['a/*.ts'], 'a/b/c.ts')).toBe(false);
  });
});

describe('isInLintScope', () => {
  it('IsInLintScope_EveryRootAndExtension_IsIn', () => {
    for (const p of ['src/a.ts', 'tools/x/y.mjs', 'tests/z.cjs', 'tools/a.mts', 'vitest.config.ts', '.dependency-cruiser.cjs']) {
      expect(isInLintScope(p), p).toBe(true);
    }
  });

  it('IsInLintScope_OtherFilesAndIgnoredFixtures_AreOut', () => {
    for (const p of ['docs/a.ts', 'src/a.md', 'tools/evals/evals/benchmarks/seeded-defects/fixtures/x.ts']) {
      expect(isInLintScope(p), p).toBe(false);
    }
  });
});

describe('consumers', () => {
  it('LintScript_QuotedGlobs_EqualTheSharedConstant', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const quoted = [...(pkg.scripts.lint ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    expect(quoted).toEqual([...LINT_GLOBS]);
  });
});

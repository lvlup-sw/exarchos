// ─── test-adequacy unit tests ────────────────────────────────────────────────
//
// Bundle B2. Covers the pure pieces of the kill-probe gate in isolation:
//   • task 011 — splitHunks: file-level test/source classification of a task diff
//
// Snapshot/restore (task 012) and probe orchestration (task 013) live in their
// own describe blocks below as the bundle progresses; the acceptance contract
// (dispatch through handleOrchestrate against real git) is in
// test-adequacy.integration.test.ts.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { splitHunks } from './test-adequacy.js';

// ─── task 011: splitHunks ────────────────────────────────────────────────────

describe('splitHunks (file-level test/source classification)', () => {
  it('SplitHunks_CoLocatedTestFile_ClassifiedTest', () => {
    const result = splitHunks(['src/calc.test.ts']);
    expect(result.testFiles).toEqual(['src/calc.test.ts']);
    expect(result.sourceFiles).toEqual([]);
  });

  it('SplitHunks_SourceFile_ClassifiedSource', () => {
    const result = splitHunks(['src/calc.ts']);
    expect(result.sourceFiles).toEqual(['src/calc.ts']);
    expect(result.testFiles).toEqual([]);
  });

  it('SplitHunks_MixedDiff_PartitionsBoth', () => {
    const files = [
      'src/calc.ts',
      'src/calc.test.ts',
      'src/widget.spec.ts',
      'src/__tests__/legacy.ts',
      'lib/util.js',
    ];
    const result = splitHunks(files);
    expect(result.sourceFiles).toEqual(['src/calc.ts', 'lib/util.js']);
    expect(result.testFiles).toEqual([
      'src/calc.test.ts',
      'src/widget.spec.ts',
      'src/__tests__/legacy.ts',
    ]);
  });

  it('SplitHunks_CustomGlobs_OverrideDefault', () => {
    // When the resolved toolchain supplies test globs, those win over the
    // co-located defaults: here only `tests/**` counts as test.
    const result = splitHunks(['src/calc.test.ts', 'tests/calc.py'], {
      testGlobs: ['tests/**'],
    });
    expect(result.testFiles).toEqual(['tests/calc.py']);
    expect(result.sourceFiles).toEqual(['src/calc.test.ts']);
  });

  // Property: every changed file is classified exactly once, and the union of
  // test ∪ source equals the input set (no file dropped, none duplicated).
  it('SplitHunks_Partition_EveryFileClassifiedExactlyOnce', () => {
    const segment = fc
      .stringMatching(/^[a-z][a-z0-9_]{0,7}$/)
      .filter((s) => s.length > 0);
    const fileArb = fc
      .tuple(
        fc.array(segment, { minLength: 1, maxLength: 4 }),
        fc.constantFrom('.ts', '.tsx', '.js', '.jsx', '.test.ts', '.spec.ts'),
      )
      .map(([parts, ext]) => parts.join('/') + ext);

    fc.assert(
      fc.property(fc.uniqueArray(fileArb, { maxLength: 20 }), (files) => {
        const { testFiles, sourceFiles } = splitHunks(files);
        const union = [...testFiles, ...sourceFiles];

        // No overlap.
        const testSet = new Set(testFiles);
        for (const s of sourceFiles) expect(testSet.has(s)).toBe(false);

        // Union (as a set) equals the input set — every file classified once.
        expect(new Set(union)).toEqual(new Set(files));
        expect(union.length).toBe(files.length);
      }),
    );
  });
});

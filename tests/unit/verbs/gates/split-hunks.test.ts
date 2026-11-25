/**
 * The file-level classification of the mock-boundary gate. `splitHunks` puts each changed file of a task diff in one class:
 * test, test support or source. The mock-boundary gate scans only the files that it classifies as tests.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';

import { DEFAULT_TEST_SUPPORT_SEGMENTS } from '../../../../src/config/toolchains.js';
import { splitHunks } from '../../../../src/verbs/gates/mock-boundary.js';

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

  /** Test globs from the toolchain override the co-located defaults. */
  it('SplitHunks_CustomGlobs_OverrideDefault', () => {
    const result = splitHunks(['src/calc.test.ts', 'tests/calc.py'], {
      testGlobs: ['tests/**'],
    });
    expect(result.testFiles).toEqual(['tests/calc.py']);
    expect(result.sourceFiles).toEqual(['src/calc.test.ts']);
  });

  /** Each changed file is in exactly one class, and the three classes together equal the input set. */
  it('SplitHunks_Partition_EveryFileClassifiedExactlyOnce', () => {
    const segment = fc.oneof(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/).filter((s) => s.length > 0),
      fc.constantFrom(...DEFAULT_TEST_SUPPORT_SEGMENTS),
    );
    const fileArb = fc
      .tuple(
        fc.array(segment, { minLength: 1, maxLength: 4 }),
        fc.constantFrom('.ts', '.tsx', '.js', '.jsx', '.test.ts', '.spec.ts'),
      )
      .map(([parts, ext]) => parts.join('/') + ext);

    fc.assert(
      fc.property(fc.uniqueArray(fileArb, { maxLength: 20 }), (files) => {
        const { testFiles, sourceFiles, supportFiles } = splitHunks(files);
        const union = [...testFiles, ...sourceFiles, ...supportFiles];

        expect(new Set(union)).toEqual(new Set(files));
        expect(union.length).toBe(files.length);
      }),
    );
  });

  /**
   * A file that is not a test and sits under a directory with a test-support name is test support. It is in neither the
   * test list nor the source list. The table holds the seven names, and each one counts.
   */
  it('SplitHunks_TestSupportSegments_AreNeitherTestNorSource', () => {
    expect(DEFAULT_TEST_SUPPORT_SEGMENTS).toEqual([
      'tests',
      'test',
      '__tests__',
      '__mocks__',
      '__fixtures__',
      'fixtures',
      'test-helpers',
    ]);
    const files = DEFAULT_TEST_SUPPORT_SEGMENTS.map((name) => `pkg/${name}/support.ts`);

    const result = splitHunks(files, { testGlobs: ['**/*.test.*'] });

    expect(result.supportFiles).toEqual(files);
    expect(result.testFiles).toEqual([]);
    expect(result.sourceFiles).toEqual([]);
  });

  /**
   * The rule matches a whole directory name. A name that only holds a support name, a file named like a support
   * directory, and a singular form stay source. A test file under a support directory stays a test.
   */
  it('SplitHunks_NearMissNamesAndTestsUnderSupport_KeepTheirClass', () => {
    const result = splitHunks([
      'src/contest/value.ts',
      'src/testing/value.ts',
      'src/fixture/value.ts',
      'bin/tests',
      'src/tests.ts',
      'tests/helpers/fixture.ts',
      'tools/test-helpers/spawn.ts',
      'tests/helpers/fixture.test.ts',
    ]);

    expect(result.sourceFiles).toEqual([
      'src/contest/value.ts',
      'src/testing/value.ts',
      'src/fixture/value.ts',
      'bin/tests',
      'src/tests.ts',
    ]);
    expect(result.supportFiles).toEqual(['tests/helpers/fixture.ts', 'tools/test-helpers/spawn.ts']);
    expect(result.testFiles).toEqual(['tests/helpers/fixture.test.ts']);
  });
});

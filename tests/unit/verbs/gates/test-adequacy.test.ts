/**
 * Unit tests for the parts of the kill-probe gate.
 *
 * `splitHunks` and `runProbe` are pure. The reverted source image runs against a temporary Git repository and the constrained reader.
 * `test-adequacy.integration.test.ts` dispatches through `handleOrchestrate` against real Git.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_TEST_SUPPORT_SEGMENTS } from '../../../../src/config/toolchains.js';
import {
  splitHunks,
  runProbe,
  type ProbeResult,
  type RunOutcome,
  type TestRunFn,
} from '../../../../src/verbs/gates/test-adequacy.js';
import { readTaskDiff } from '../../../../src/verbs/gates/test-adequacy-handler.js';
import { buildDisposableCopy, type DisposableCopySource } from '../../../../src/verbs/verification/disposable-copy.js';
import { createConstrainedGitReads, processObservationalGitPath } from '../../../../src/utils/git-tree.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

/** A scoped test run with a verdict: green when `green` holds, and red otherwise. */
function ran(green: boolean, stdout?: string): RunOutcome {
  return { kind: 'ran', result: green ? 'green' : 'red', ...(stdout === undefined ? {} : { stdout }) };
}

async function initRepo(prefix: string): Promise<string> {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(repoRoot, ['init', '--initial-branch=main', '-q']);
  await git(repoRoot, ['config', 'user.email', 'test@example.com']);
  await git(repoRoot, ['config', 'user.name', 'Test']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

/**
 * Repo with a base commit (`return 1`) on `main`, then a task commit on a
 * feature branch changing source (`return 2`) + adding a test. The working
 * tree at HEAD is clean. Returns the repoRoot, base ref, and the source file.
 */
async function setupTaskRepo(prefix: string): Promise<{
  repoRoot: string;
  baseRef: string;
  sourceFile: string;
  testFile: string;
}> {
  const repoRoot = await initRepo(prefix);
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 1;\n');
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'base', '-q']);
  const baseRef = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

  await git(repoRoot, ['checkout', '-b', 'feature/x', '-q']);
  writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 2;\n');
  writeFileSync(path.join(repoRoot, 'src', 'calc.test.js'), "// pins value()===2\n");
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'task: bump to 2 + test', '-q']);

  return { repoRoot, baseRef, sourceFile: 'src/calc.js', testFile: 'src/calc.test.js' };
}

/** The source of a disposable copy of the checked-out head, with the constrained reads of the repository. */
async function copySourceOf(repoRoot: string): Promise<DisposableCopySource> {
  const gitPath = processObservationalGitPath();
  if (gitPath === undefined) throw new Error('No Git on PATH');
  const checkout = await realpath(repoRoot);
  const gitDir = path.join(checkout, '.git');
  const head = (await git(checkout, ['rev-parse', 'HEAD'])).trim();
  return { checkout, gitDir, repository: gitDir, head, reads: await createConstrainedGitReads(gitPath) };
}

/** The live state of a repository: its refs, its stash list, its index and its working tree status. */
async function liveState(repoRoot: string): Promise<string> {
  return [
    await git(repoRoot, ['for-each-ref']),
    await git(repoRoot, ['stash', 'list']),
    await git(repoRoot, ['ls-files', '--stage']),
    await git(repoRoot, ['status', '--porcelain', '--ignored']),
  ].join('\n--\n');
}

/** The task paths of the pure probe cases. The probe reads no file, so no repository holds them. */
const sourceFile = 'src/calc.js';
const testFile = 'src/calc.test.js';

/** A runner that is green on the head source and red on the reverted source: the new test pins the new behavior. */
const killingRun: TestRunFn = async ({ source }) => ran(source === 'head');

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
   * test list nor the source list, so the probe does not revert it. The table holds the seven names, and each one counts.
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


describe('the reverted source image (no Git write)', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) {
      try {
        rmrf(r);
      } catch {
      }
    }
  });

  /** The reverted image is a disposable copy. Its build writes no ref, no stash entry, no index entry and no file of the live checkout. */
  it(
    'RevertedImage_WritesNoRefNoStashAndNoLiveFile',
    async () => {
      const { repoRoot, baseRef, sourceFile: source } = await setupTaskRepo('test-adequacy-snap-');
      repos.push(repoRoot);
      const before = await liveState(repoRoot);

      const image = await buildDisposableCopy(await copySourceOf(repoRoot), { base: baseRef, sources: [source] });
      try {
        expect(readFileSync(path.join(image.root, source), 'utf-8')).toContain('=> 1');
      } finally {
        await image.dispose();
      }

      expect(await liveState(repoRoot)).toBe(before);
      expect(readFileSync(path.join(repoRoot, source), 'utf-8')).toContain('=> 2');
    },
    30_000,
  );

  /** The reverted image holds the base source and the head test. The live checkout keeps the head source, and the image goes after the dispose. */
  it(
    'RevertedImage_HoldsTheBaseSourceAndTheHeadTest',
    async () => {
      const { repoRoot, baseRef, sourceFile: source, testFile: test } = await setupTaskRepo('test-adequacy-restore-');
      repos.push(repoRoot);

      const image = await buildDisposableCopy(await copySourceOf(repoRoot), { base: baseRef, sources: [source] });
      const root = image.root;
      try {
        expect(readFileSync(path.join(root, source), 'utf-8')).toContain('=> 1');
        expect(readFileSync(path.join(root, test), 'utf-8')).toContain('pins value()===2');
      } finally {
        await image.dispose();
      }

      expect(existsSync(root)).toBe(false);
      expect(readFileSync(path.join(repoRoot, source), 'utf-8')).toContain('=> 2');
    },
    30_000,
  );

  /** A changed source at the base takes its base bytes. A source that the task added is left out of the image, and the live checkout keeps it. */
  it(
    'RevertedImage_MixedExistingAndAddedSource_HoldsTheBaseAndLeavesOutTheAdded',
    async () => {
      const { repoRoot, baseRef, sourceFile: source } = await setupTaskRepo('test-adequacy-added-source-');
      repos.push(repoRoot);
      const addedSource = 'src/transition-admission-corpus.ts';
      writeFileSync(path.join(repoRoot, addedSource), 'export const corpus = [];\n');
      await git(repoRoot, ['add', addedSource]);
      await git(repoRoot, ['commit', '-m', 'task: add characterization corpus', '-q']);
      const before = await liveState(repoRoot);

      const image = await buildDisposableCopy(await copySourceOf(repoRoot), { base: baseRef, sources: [source, addedSource] });
      try {
        expect(readFileSync(path.join(image.root, source), 'utf-8')).toContain('=> 1');
        expect(existsSync(path.join(image.root, addedSource))).toBe(false);
      } finally {
        await image.dispose();
      }

      expect(existsSync(path.join(repoRoot, addedSource))).toBe(true);
      expect(await liveState(repoRoot)).toBe(before);
    },
    30_000,
  );

  /** A probe whose runner throws on the reverted run rejects. The live checkout never held the reverted source, so nothing needs a restore. */
  it(
    'RevertedImage_ARunThatThrows_LeavesTheLiveCheckoutUnchanged',
    async () => {
      const { repoRoot } = await setupTaskRepo('test-adequacy-restore-err-');
      repos.push(repoRoot);
      const before = await liveState(repoRoot);
      const sourcesSeen: string[] = [];
      const runTests: TestRunFn = async ({ source }) => {
        sourcesSeen.push(source);
        if (source === 'reverted') throw new Error('injected crash of the post-revert run');
        return ran(true);
      };

      await expect(runProbe({ changedFiles: [sourceFile, testFile], runTests })).rejects.toThrow('injected crash of the post-revert run');

      expect(sourcesSeen).toEqual(['head', 'reverted']);
      expect(await liveState(repoRoot)).toBe(before);
    },
    30_000,
  );

  /** A source path that neither the base nor the head holds refuses the image, and no copy stays. */
  it(
    'RevertedImage_ASourceInNeitherTree_Refuses',
    async () => {
      const { repoRoot, baseRef } = await setupTaskRepo('test-adequacy-conflict-');
      repos.push(repoRoot);

      await expect(buildDisposableCopy(await copySourceOf(repoRoot), { base: baseRef, sources: ['src/does-not-exist-at-base.js'] }))
        .rejects.toThrow('in neither the base nor the head');
    },
    30_000,
  );

  /** A task-added source is absent from the reverted image, while the live index keeps its committed bytes. */
  it(
    'RevertedImage_TaskAddedSource_IsAbsentAndTheLiveIndexKeepsIt',
    async () => {
      const { repoRoot, baseRef } = await setupTaskRepo('test-adequacy-added-source-');
      repos.push(repoRoot);
      const addedSource = 'src/new-helper.js';
      const addedContent = 'export const helper = true;\n';
      writeFileSync(path.join(repoRoot, addedSource), addedContent);
      await git(repoRoot, ['add', addedSource]);
      await git(repoRoot, ['commit', '-m', 'task: add source helper', '-q']);

      const image = await buildDisposableCopy(await copySourceOf(repoRoot), { base: baseRef, sources: ['src/calc.js', addedSource] });
      try {
        expect(existsSync(path.join(image.root, addedSource))).toBe(false);
      } finally {
        await image.dispose();
      }

      expect(await git(repoRoot, ['show', `:${addedSource}`])).toBe(addedContent);
    },
    30_000,
  );
});

describe('runProbe (split, then the head run, then the reverted run)', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) {
      try {
        rmrf(r);
      } catch {
      }
    }
  });

  /**
   * The diff holds only a source file, so the probe stops with `no-new-tests` and runs no test command.
   * With nothing to probe, the result is an advisory pass.
   */
  it(
    'Probe_NoNewTests_ReturnsNoNewTestsDiscriminant',
    async () => {
      let testRan = false;
      const testRun: TestRunFn = async () => {
        testRan = true;
        return ran(true);
      };

      const result: ProbeResult = await runProbe({ changedFiles: [sourceFile], runTests: testRun });

      expect(result.discriminant).toBe('no-new-tests');
      expect(result.passed).toBe(true);
      expect(result.report).toContain('nothing to probe');
      expect(result.report).toContain('no tests');
      expect(result.probedTests).toEqual([]);
      expect(testRan).toBe(false);
    },
    30_000,
  );

  /** The test runner fails on the reverted source, because the new test pins the new behavior. */
  it(
    'Probe_NewTestFailsOnRevert_RedObservedTrue_PassedTrue',
    async () => {
      const sourcesSeen: string[] = [];
      const runTests: TestRunFn = async (input) => {
        sourcesSeen.push(input.source);
        return killingRun(input);
      };

      const result = await runProbe({ changedFiles: [sourceFile, testFile], runTests });

      expect(sourcesSeen).toEqual(['head', 'reverted']);
      expect(result.redObserved).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.restoredClean).toBe(true);
      expect(result.probedTests).toEqual([testFile]);
      expect(result.discriminant).toBeUndefined();
    },
    30_000,
  );

  /** A vacuous test passes with the source reverted, so the probe sees no red. */
  it(
    'Probe_NewTestPassesOnRevert_PassedFalse',
    async () => {
      const result = await runProbe({ changedFiles: [sourceFile, testFile], runTests: async () => ran(true) });

      expect(result.redObserved).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.restoredClean).toBe(true);
    },
    30_000,
  );

  /** `probedTests` holds the classified test files, and `restoredClean` holds true, because the probe writes no file. */
  it(
    'Probe_Result_CarriesProbedTestsAndRestoredClean',
    async () => {
      const result = await runProbe({ changedFiles: [sourceFile, testFile], runTests: killingRun });

      expect(result.probedTests).toEqual([testFile]);
      expect(result.restoredClean).toBe(true);
      expect(result.redObserved).toBe(true);
      expect(result.passed).toBe(true);
    },
    30_000,
  );

  /**
   * The test command fails on every run, so the tests are red on the head source before any revert.
   * A red run after the revert then proves nothing. The probe must stop with `baseline-red` and block at every tier.
   */
  it(
    'Probe_TestCommandAlwaysFails_IsBaselineRedAndBlocksAtEveryTier',
    async () => {
      for (const riskTier of [undefined, 'low', 'medium', 'high'] as const) {
        const sourcesSeen: string[] = [];
        const runTests: TestRunFn = async ({ source }) => {
          sourcesSeen.push(source);
          return ran(false, 'line one\nError: Cannot find module ./missing.js');
        };

        const result = await runProbe({
          changedFiles: [sourceFile, testFile],
          runTests,
          ...(riskTier === undefined ? {} : { riskTier }),
        });

        expect(result.verdict.kind, String(riskTier)).toBe('indeterminate');
        expect(result.discriminant, String(riskTier)).toBe('baseline-red');
        expect(result.passed, String(riskTier)).toBe(false);
        expect(result.disposition, String(riskTier)).toBe('blocked');
        expect(result.skipped, String(riskTier)).toBeUndefined();
        expect(result.redObserved, String(riskTier)).toBe(false);
        expect(result.restoredClean, String(riskTier)).toBe(true);
        expect(result.report, String(riskTier)).toContain('Cannot find module ./missing.js');
        expect(result.report, String(riskTier)).not.toContain('did not run');
        expect(sourcesSeen, String(riskTier)).toEqual(['head']);
      }
    },
    30_000,
  );

  /** The detail of a `baseline-red` verdict ends with the tail of the runner output, not with the whole output. */
  it(
    'Probe_BaselineRed_DetailEndsWithTheTailOfTheRunnerOutput',
    async () => {
      const output = Array.from({ length: 50 }, (_, i) => `output line ${i}`).join('\n');
      const result = await runProbe({ changedFiles: [sourceFile, testFile], runTests: async () => ran(false, output) });

      expect(result.discriminant).toBe('baseline-red');
      expect(result.verdict.kind).toBe('indeterminate');
      if (result.verdict.kind !== 'indeterminate') return;
      expect(result.verdict.detail.endsWith('output line 49')).toBe(true);
      expect(result.verdict.detail).toContain('output line 30');
      expect(result.verdict.detail).not.toContain('output line 29');
    },
    30_000,
  );

  /**
   * A task that changes only a test file has no source to revert. The run after the revert is the same run as the first,
   * so the probe runs the tests once. Green tests give `failed`, and red tests give `baseline-red`. Neither is a kill.
   */
  it(
    'Probe_TestOnlyTask_RunsTheTestsOnceAndNeverPasses',
    async () => {
      for (const green of [true, false]) {
        let calls = 0;
        const result = await runProbe({
          changedFiles: [testFile],
          runTests: async () => {
            calls += 1;
            return ran(green);
          },
          riskTier: 'medium',
        });

        expect(calls, String(green)).toBe(1);
        expect(result.passed, String(green)).toBe(false);
        expect(result.redObserved, String(green)).toBe(false);
        if (green) {
          expect(result.verdict.kind).toBe('failed');
          expect(result.report).toContain('changes no source file');
        } else {
          expect(result.discriminant).toBe('baseline-red');
        }
      }
    },
    30_000,
  );

  /**
   * A test file that the task deletes is not at the head, so a run of it collects nothing. The probe must not run it.
   * The remaining test files are probed. With no test file left, the diff still touches a test path, so the verdict is `unprobed-test-paths`.
   */
  it(
    'Probe_DeletedTestFile_IsNeverProbed',
    async () => {
      const deletedTest = 'src/old.test.js';

      const filesSeen: (readonly string[])[] = [];
      const runTests: TestRunFn = async (input) => {
        filesSeen.push(input.testFiles);
        return killingRun(input);
      };

      const mixed = await runProbe({ changedFiles: [sourceFile, testFile, deletedTest], deletedFiles: [deletedTest], runTests });
      expect(mixed.probedTests).toEqual([testFile]);
      expect(mixed.passed).toBe(true);
      expect(filesSeen).toEqual([[testFile], [testFile]]);

      const onlyDeleted = await runProbe({
        changedFiles: [sourceFile, deletedTest],
        deletedFiles: [deletedTest],
        runTests: () => {
          throw new Error('the test command must not run for a deleted test file');
        },
        riskTier: 'high',
      });
      expect(onlyDeleted.discriminant).toBe('unprobed-test-paths');
      expect(onlyDeleted.passed).toBe(false);
    },
    30_000,
  );

  /**
   * The task renames one source file and deletes another. The diff marks both base paths deleted, so the reverted image holds them.
   * The head image holds only the new path. The live tree, the index and the status after the probe equal those before it.
   */
  it(
    'Probe_RenamedAndDeletedSource_TheRevertedImageHoldsTheBasePathsAndTheLiveTreeStays',
    async () => {
      const repoRoot = await initRepo('test-adequacy-probe-rename-');
      repos.push(repoRoot);
      mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      const sharedLines = Array.from({ length: 12 }, (_, i) => `// shared line ${i}\n`).join('');
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 1;\n');
      writeFileSync(path.join(repoRoot, 'src', 'old.js'), `${sharedLines}export const name = 'old';\n`);
      writeFileSync(path.join(repoRoot, 'src', 'dead.js'), 'export const dead = true;\n');
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'base', '-q']);

      await git(repoRoot, ['checkout', '-b', 'feature/rename', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 2;\n');
      await git(repoRoot, ['mv', 'src/old.js', 'src/new.js']);
      await git(repoRoot, ['rm', '-q', 'src/dead.js']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.test.js'), '// pins value()===2\n');
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'task: rename, delete and bump', '-q']);

      const detected = await git(repoRoot, ['diff', '-M', '--name-status', 'main...HEAD']);
      expect(detected).toMatch(/^R\d*\tsrc\/old\.js\tsrc\/new\.js$/m);

      const changed = await readTaskDiff(repoRoot, { kind: 'base', baseRef: 'main' });
      expect(changed.ok).toBe(true);
      if (!changed.ok) return;
      expect([...changed.deletedFiles].sort()).toEqual(['src/dead.js', 'src/old.js']);

      const before = await liveState(repoRoot);
      const source = await copySourceOf(repoRoot);
      const treesSeen: string[] = [];
      const runTests: TestRunFn = async (input) => {
        const image = input.source === 'reverted'
          ? await buildDisposableCopy(source, { base: changed.base, sources: ['src/calc.js', 'src/dead.js', 'src/new.js', 'src/old.js'] })
          : await buildDisposableCopy(source);
        try {
          const present = ['src/new.js', 'src/old.js', 'src/dead.js'].filter((file) => existsSync(path.join(image.root, file)));
          treesSeen.push(present.join(','));
          return ran(existsSync(path.join(image.root, 'src', 'new.js')));
        } finally {
          await image.dispose();
        }
      };

      const result = await runProbe({ changedFiles: changed.files, deletedFiles: changed.deletedFiles, runTests, riskTier: 'high' });

      expect(treesSeen).toEqual(['src/new.js', 'src/old.js,src/dead.js']);
      expect(result.passed).toBe(true);
      expect(result.restoredClean).toBe(true);
      expect(await liveState(repoRoot)).toBe(before);
      expect(existsSync(path.join(repoRoot, 'src', 'old.js'))).toBe(false);
      expect(existsSync(path.join(repoRoot, 'src', 'dead.js'))).toBe(false);
    },
    30_000,
  );

  /** A head image that the runner cannot build gives a run with no verdict. The probe stops before the revert and never reads it as red. */
  it(
    'Probe_AnUnbuiltHeadImage_IsRunNoVerdictBeforeAnyRevert',
    async () => {
      const sourcesSeen: string[] = [];
      const result = await runProbe({
        changedFiles: [sourceFile, testFile],
        runTests: async ({ source }) => {
          sourcesSeen.push(source);
          return { kind: 'no-verdict', cause: 'did-not-start', detail: 'the disposable copy of the head was not built' };
        },
        riskTier: 'low',
      });

      expect(sourcesSeen).toEqual(['head']);
      expect(result.discriminant).toBe('run-no-verdict');
      expect(result.passed).toBe(false);
      expect(result.report).toContain('the disposable copy of the head was not built');
    },
    30_000,
  );

  /**
   * The run on the head source ends with no verdict, for example at a timeout. That run is not a red run, so the probe must not
   * call it `baseline-red`. The verdict is `run-no-verdict`, which blocks at every tier, and the probe runs no reverted source.
   */
  it(
    'Probe_RunOnTheTaskSourceWithNoVerdict_IsRunNoVerdictAndBlocksAtEveryTier',
    async () => {
      for (const riskTier of [undefined, 'low', 'medium', 'high'] as const) {
        const sourcesSeen: string[] = [];
        const runTests: TestRunFn = async ({ source }) => {
          sourcesSeen.push(source);
          return { kind: 'no-verdict', cause: 'timeout', detail: 'the limit is 120000 ms', stdout: 'partial output' };
        };

        const result = await runProbe({
          changedFiles: [sourceFile, testFile],
          runTests,
          ...(riskTier === undefined ? {} : { riskTier }),
        });

        expect(result.discriminant, String(riskTier)).toBe('run-no-verdict');
        expect(result.disposition, String(riskTier)).toBe('blocked');
        expect(result.passed, String(riskTier)).toBe(false);
        expect(result.redObserved, String(riskTier)).toBe(false);
        expect(result.report, String(riskTier)).toContain('on the task source reached no verdict (timeout)');
        expect(result.report, String(riskTier)).toContain('the limit is 120000 ms');
        expect(result.report, String(riskTier)).toContain('partial output');
        expect(result.report, String(riskTier)).not.toContain('failed on the task source');
        expect(sourcesSeen, String(riskTier)).toEqual(['head']);
      }
    },
    30_000,
  );

  /**
   * The run on the head source is green, and the run after the revert ends with no verdict. A timeout,
   * a signal or an overflow of that run must never read as a kill. Each cause must give `run-no-verdict`, never `passed`.
   */
  it(
    'Probe_RunAfterTheRevertWithNoVerdict_IsNeverAKill',
    async () => {
      for (const cause of ['timeout', 'signal', 'overflow', 'unknown-exit-code'] as const) {
        const runTests: TestRunFn = async ({ source }) =>
          source === 'reverted' ? { kind: 'no-verdict', cause, detail: `injected ${cause}` } : ran(true);

        const result = await runProbe({ changedFiles: [sourceFile, testFile], runTests, riskTier: 'high' });

        expect(result.verdict.kind, cause).toBe('indeterminate');
        expect(result.discriminant, cause).toBe('run-no-verdict');
        expect(result.redObserved, cause).toBe(false);
        expect(result.passed, cause).toBe(false);
        expect(result.restoredClean, cause).toBe(true);
        expect(result.report, cause).toContain(`after the revert reached no verdict (${cause})`);
      }
    },
    30_000,
  );

  /** A reverted image that the runner cannot build gives a run with no verdict after a green head run. It is never a kill. */
  it(
    'Probe_AnUnbuiltRevertedImage_IsRunNoVerdictAndNeverAKill',
    async () => {
      const result = await runProbe({
        changedFiles: [sourceFile, testFile],
        runTests: async ({ source }) => source === 'reverted'
          ? { kind: 'no-verdict', cause: 'did-not-start', detail: 'The reverted source image was not built' }
          : ran(true),
        riskTier: 'low',
      });

      expect(result.discriminant).toBe('run-no-verdict');
      expect(result.redObserved).toBe(false);
      expect(result.passed).toBe(false);
    },
    30_000,
  );

  /**
   * vitest writes "No test files found" as the first stderr line, and more lines follow it. The tail of the last 20 lines
   * lost that line, so the detail did not name the cause. The detail must keep the first non-empty stderr line ahead of the tail.
   */
  it(
    'Probe_BaselineRed_DetailKeepsTheFirstStderrLineAheadOfTheTail',
    async () => {
      const stdout = Array.from({ length: 7 }, (_, i) => `stdout line ${i}`).join('\n');
      const stderr = [
        '',
        'No test files found, exiting with code 1',
        ...Array.from({ length: 30 }, (_, i) => `stderr line ${i}`),
      ].join('\n');
      const result = await runProbe({
        changedFiles: [sourceFile, testFile],
        runTests: async () => ({ kind: 'ran', result: 'red', stdout, stderr }),
      });

      expect(result.discriminant).toBe('baseline-red');
      expect(result.verdict.kind).toBe('indeterminate');
      if (result.verdict.kind !== 'indeterminate') return;
      const detail = result.verdict.detail;
      expect(detail).toContain('No test files found, exiting with code 1');
      expect(detail.indexOf('No test files found')).toBeLessThan(detail.indexOf('stderr line 29'));
      expect(detail.endsWith('stderr line 29')).toBe(true);
      expect(detail).not.toContain('stderr line 9\n');
      expect(detail).not.toContain('stdout line 0');
    },
    30_000,
  );
});

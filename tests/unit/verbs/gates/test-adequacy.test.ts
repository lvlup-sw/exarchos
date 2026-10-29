/**
 * Unit tests for the parts of the kill-probe gate.
 *
 * `splitHunks` is pure. The snapshot, revert, and restore steps and `runProbe` run against a temporary git repo.
 * `test-adequacy.integration.test.ts` dispatches through `handleOrchestrate` against real git.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DEFAULT_TEST_SUPPORT_SEGMENTS } from '../../../../src/config/toolchains.js';
import {
  splitHunks,
  snapshotWorkingTree,
  revertSourceFiles,
  restoreWorkingTree,
  runProbe,
  type ProbeResult,
  type RunOutcome,
  type TestRunFn,
} from '../../../../src/verbs/gates/test-adequacy.js';
import { changedFilesFor } from '../../../../src/verbs/gates/test-adequacy-handler.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

/** A scoped test run with a verdict: green when `green` holds, and red otherwise. */
function ran(green: boolean, stdout?: string): RunOutcome {
  return { kind: 'ran', result: green ? 'green' : 'red', ...(stdout === undefined ? {} : { stdout }) };
}

/** Production-shaped GitExec over a real repo (mirrors merge-orchestrate's). */
const realGitExec: GitExec = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 15_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out =
      (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '') +
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '');
    return { stdout: out, exitCode: e.status ?? 1 };
  }
};

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

/**
 * Hash of the full working tree, for equality checks.
 * `git stash create` captures the tree and changes no ref. For a clean tree it gives no sha, so the hash is the HEAD tree.
 */
async function workingTreeHash(repoRoot: string): Promise<string> {
  const stashSha = (await git(repoRoot, ['stash', 'create'])).trim();
  if (!stashSha) {
    return (await git(repoRoot, ['rev-parse', 'HEAD^{tree}'])).trim();
  }
  return (await git(repoRoot, ['rev-parse', `${stashSha}^{tree}`])).trim();
}

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

describe('snapshot/revert/restore (INV-14: refuse-to-discard recovery)', () => {
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
   * The test changes the worktree first.
   * `git stash create` must capture the change and must not change a ref, so the stash list stays the same.
   */
  it(
    'Snapshot_BeforeProbe_UsesRefuseToDiscardRef',
    async () => {
      const { repoRoot } = await setupTaskRepo('test-adequacy-snap-');
      repos.push(repoRoot);

      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 99;\n');

      const stashRefsBefore = await git(repoRoot, ['stash', 'list']);
      const snap = snapshotWorkingTree(realGitExec, repoRoot);

      expect('stashSha' in snap).toBe(true);
      if ('stashSha' in snap) {
        expect(snap.stashSha).toMatch(/^[0-9a-f]{40}$/);
      }
      expect(await git(repoRoot, ['stash', 'list'])).toBe(stashRefsBefore);
    },
    30_000,
  );

  it(
    'Restore_AfterProbe_TreeHashMatchesSnapshot',
    async () => {
      const { repoRoot, baseRef, sourceFile } = await setupTaskRepo('test-adequacy-restore-');
      repos.push(repoRoot);

      const before = await workingTreeHash(repoRoot);
      const snap = snapshotWorkingTree(realGitExec, repoRoot);
      expect('stashSha' in snap).toBe(true);

      const reverted = revertSourceFiles(realGitExec, repoRoot, baseRef, [sourceFile]);
      expect(reverted.ok).toBe(true);
      expect(await workingTreeHash(repoRoot)).not.toBe(before);

      if ('stashSha' in snap) {
        const restore = restoreWorkingTree(realGitExec, repoRoot, snap.stashSha);
        expect(restore.restored).toBe(true);
      }
      expect(await workingTreeHash(repoRoot)).toBe(before);
    },
    30_000,
  );

  it(
    'RevertSourceFiles_MixedExistingAndAddedSource_RevertsAndRestores',
    async () => {
      const { repoRoot, baseRef, sourceFile } = await setupTaskRepo(
        'test-adequacy-added-source-',
      );
      repos.push(repoRoot);
      const addedSource = 'src/transition-admission-corpus.ts';
      const absoluteAddedSource = path.join(repoRoot, addedSource);
      writeFileSync(absoluteAddedSource, 'export const corpus = [];\n');
      await git(repoRoot, ['add', addedSource]);
      await git(repoRoot, ['commit', '-m', 'task: add characterization corpus', '-q']);

      const before = await workingTreeHash(repoRoot);
      const snap = snapshotWorkingTree(realGitExec, repoRoot);
      expect('stashSha' in snap).toBe(true);
      if (!('stashSha' in snap)) throw new Error('snapshot failed');

      const reverted = revertSourceFiles(realGitExec, repoRoot, baseRef, [
        sourceFile,
        addedSource,
      ]);

      expect(reverted.ok).toBe(true);
      expect(readFileSync(path.join(repoRoot, sourceFile), 'utf-8')).toContain('=> 1');
      expect(existsSync(absoluteAddedSource)).toBe(false);

      const restore = restoreWorkingTree(realGitExec, repoRoot, snap.stashSha);
      expect(restore.restored).toBe(true);
      expect(existsSync(absoluteAddedSource)).toBe(true);
      expect(await workingTreeHash(repoRoot)).toBe(before);
    },
    30_000,
  );

  /**
   * The test runner passes on the task source and throws on the reverted source, so only the second run throws.
   * `runProbe` must reject and must leave the working tree as it was before the probe. The restore must be in a `finally`.
   */
  it(
    'Restore_OnProbeError_StillRestores',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo('test-adequacy-restore-err-');
      repos.push(repoRoot);

      const before = await workingTreeHash(repoRoot);
      const sourcesSeen: string[] = [];
      const runTests: TestRunFn = async ({ repoRoot: rr }) => {
        const source = readFileSync(path.join(rr, sourceFile), 'utf-8');
        sourcesSeen.push(source.includes('=> 1') ? 'reverted' : 'task');
        if (source.includes('=> 1')) throw new Error('injected crash of the post-revert run');
        return ran(true);
      };

      await expect(
        runProbe({
          gitExec: realGitExec,
          repoRoot,
          baseRef,
          changedFiles: [sourceFile, testFile],
          runTests,
        }),
      ).rejects.toThrow('injected crash of the post-revert run');

      expect(sourcesSeen).toEqual(['task', 'reverted']);
      expect(await workingTreeHash(repoRoot)).toBe(before);
      expect(readFileSync(path.join(repoRoot, sourceFile), 'utf-8')).toContain('=> 2');
    },
    30_000,
  );

  /**
   * The path does not exist at the base ref, so `git checkout <base> -- <path>` fails.
   * The helper must return the `revert-conflict` discriminant and must not throw.
   */
  it(
    'Revert_Conflict_ReturnsRevertConflictDiscriminant',
    async () => {
      const { repoRoot } = await setupTaskRepo('test-adequacy-conflict-');
      repos.push(repoRoot);

      const reverted = revertSourceFiles(realGitExec, repoRoot, 'main', [
        'src/does-not-exist-at-base.js',
      ]);
      expect(reverted.ok).toBe(false);
      if (!reverted.ok) {
        expect(reverted.discriminant).toBe('revert-conflict');
      }
    },
    30_000,
  );

  it(
    'Revert_TaskAddedSource_RemovesThenRestoresCleanly',
    async () => {
      const { repoRoot, baseRef } = await setupTaskRepo('test-adequacy-added-source-');
      repos.push(repoRoot);
      const addedSource = 'src/new-helper.js';
      const addedContent = 'export const helper = true;\n';
      writeFileSync(path.join(repoRoot, addedSource), addedContent);
      await git(repoRoot, ['add', addedSource]);
      await git(repoRoot, ['commit', '-m', 'task: add source helper', '-q']);

      const snap = snapshotWorkingTree(realGitExec, repoRoot);
      expect('stashSha' in snap).toBe(true);
      if (!('stashSha' in snap)) throw new Error('snapshot failed');

      const reverted = revertSourceFiles(realGitExec, repoRoot, baseRef, [
        'src/calc.js',
        addedSource,
      ]);
      expect(reverted.ok).toBe(true);
      await expect(git(repoRoot, ['show', `:${addedSource}`])).rejects.toThrow();

      const restored = restoreWorkingTree(realGitExec, repoRoot, snap.stashSha);
      expect(restored.restored).toBe(true);
      expect(await git(repoRoot, ['show', `:${addedSource}`])).toBe(addedContent);
    },
    30_000,
  );
});

describe('runProbe (compose split → snapshot → revert → run → restore)', () => {
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
      const { repoRoot, baseRef } = await setupTaskRepo('test-adequacy-probe-notest-');
      repos.push(repoRoot);

      let testRan = false;
      const testRun: TestRunFn = async () => {
        testRan = true;
        return ran(true);
      };

      const result: ProbeResult = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: ['src/calc.js'],
        runTests: testRun,
      });

      expect(result.discriminant).toBe('no-new-tests');
      expect(result.passed).toBe(true);
      expect(result.report).toContain('nothing to probe');
      expect(result.report).toContain('no tests');
      expect(result.probedTests).toEqual([]);
      expect(testRan).toBe(false);
    },
    30_000,
  );

  /** The test runner fails when the source file holds the base content, because the new test pins the new behavior. */
  it(
    'Probe_NewTestFailsOnRevert_RedObservedTrue_PassedTrue',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo(
        'test-adequacy-probe-red-',
      );
      repos.push(repoRoot);

      const before = await workingTreeHash(repoRoot);

      const runTests: TestRunFn = async ({ repoRoot: rr }) => {
        const src = (await git(rr, ['show', ':' + sourceFile])).trim();
        const reverted = src.includes('=> 1');
        return ran(!reverted);
      };

      const result = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, testFile],
        runTests,
      });

      expect(result.redObserved).toBe(true);
      expect(result.passed).toBe(true);
      expect(result.restoredClean).toBe(true);
      expect(result.probedTests).toEqual([testFile]);
      expect(result.discriminant).toBeUndefined();
      expect(await workingTreeHash(repoRoot)).toBe(before);
    },
    30_000,
  );

  /** A vacuous test passes with the source reverted, so the probe sees no red. */
  it(
    'Probe_NewTestPassesOnRevert_PassedFalse',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo(
        'test-adequacy-probe-green-',
      );
      repos.push(repoRoot);

      const before = await workingTreeHash(repoRoot);

      const runTests: TestRunFn = async () => ran(true);

      const result = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, testFile],
        runTests,
      });

      expect(result.redObserved).toBe(false);
      expect(result.passed).toBe(false);
      expect(result.restoredClean).toBe(true);
      expect(await workingTreeHash(repoRoot)).toBe(before);
    },
    30_000,
  );

  /** `probedTests` holds the classified test files, and `restoredClean` shows the restore, which runs in each case. */
  it(
    'Probe_Result_CarriesProbedTestsAndRestoredClean',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo(
        'test-adequacy-probe-carrier-',
      );
      repos.push(repoRoot);

      const runTests: TestRunFn = async ({ repoRoot: rr }) =>
        ran(!readFileSync(path.join(rr, sourceFile), 'utf-8').includes('=> 1'));

      const result = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, testFile],
        runTests,
      });

      expect(result.probedTests).toEqual([testFile]);
      expect(result.restoredClean).toBe(true);
      expect(result.redObserved).toBe(true);
      expect(result.passed).toBe(true);
    },
    30_000,
  );

  /**
   * The test command fails on every run, so the tests are red on the task source before any revert.
   * A red run after the revert then proves nothing. The probe must stop with `baseline-red` and block at every tier.
   */
  it(
    'Probe_TestCommandAlwaysFails_IsBaselineRedAndBlocksAtEveryTier',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo(
        'test-adequacy-probe-baseline-red-',
      );
      repos.push(repoRoot);

      const before = await workingTreeHash(repoRoot);
      for (const riskTier of [undefined, 'low', 'medium', 'high'] as const) {
        const sourcesSeen: string[] = [];
        const runTests: TestRunFn = async ({ repoRoot: rr }) => {
          const reverted = readFileSync(path.join(rr, sourceFile), 'utf-8').includes('=> 1');
          sourcesSeen.push(reverted ? 'reverted' : 'task');
          return ran(false, 'line one\nError: Cannot find module ./missing.js');
        };

        const result = await runProbe({
          gitExec: realGitExec,
          repoRoot,
          baseRef,
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
        expect(sourcesSeen, String(riskTier)).toEqual(['task']);
        expect(await workingTreeHash(repoRoot), String(riskTier)).toBe(before);
      }
    },
    30_000,
  );

  /** The detail of a `baseline-red` verdict ends with the tail of the runner output, not with the whole output. */
  it(
    'Probe_BaselineRed_DetailEndsWithTheTailOfTheRunnerOutput',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo(
        'test-adequacy-probe-baseline-tail-',
      );
      repos.push(repoRoot);

      const output = Array.from({ length: 50 }, (_, i) => `output line ${i}`).join('\n');
      const result = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, testFile],
        runTests: async () => ran(false, output),
      });

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
      const { repoRoot, baseRef, testFile } = await setupTaskRepo('test-adequacy-probe-test-only-');
      repos.push(repoRoot);

      for (const green of [true, false]) {
        let calls = 0;
        const result = await runProbe({
          gitExec: realGitExec,
          repoRoot,
          baseRef,
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
   * The remaining test files are probed. With no test file left, the verdict is `no-new-tests`.
   */
  it(
    'Probe_DeletedTestFile_IsNeverProbed',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo(
        'test-adequacy-probe-deleted-test-',
      );
      repos.push(repoRoot);
      const deletedTest = 'src/old.test.js';

      const filesSeen: (readonly string[])[] = [];
      const runTests: TestRunFn = async ({ repoRoot: rr, testFiles }) => {
        filesSeen.push(testFiles);
        return ran(!readFileSync(path.join(rr, sourceFile), 'utf-8').includes('=> 1'));
      };

      const mixed = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, testFile, deletedTest],
        deletedFiles: [deletedTest],
        runTests,
      });
      expect(mixed.probedTests).toEqual([testFile]);
      expect(mixed.passed).toBe(true);
      expect(filesSeen).toEqual([[testFile], [testFile]]);

      const onlyDeleted = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, deletedTest],
        deletedFiles: [deletedTest],
        runTests: () => {
          throw new Error('the test command must not run for a deleted test file');
        },
        riskTier: 'high',
      });
      expect(onlyDeleted.discriminant).toBe('no-new-tests');
      expect(onlyDeleted.passed).toBe(false);
    },
    30_000,
  );

  /**
   * The task renames one source file and deletes another. The diff marks both base paths deleted, so the revert brings them back.
   * The restore must remove them again, so the tree hash and the git status after the probe equal those before it.
   */
  it(
    'Probe_RenamedAndDeletedSource_RestoresTheTreeAndTheIndexExactly',
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
      const baseRef = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

      await git(repoRoot, ['checkout', '-b', 'feature/rename', '-q']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 2;\n');
      await git(repoRoot, ['mv', 'src/old.js', 'src/new.js']);
      await git(repoRoot, ['rm', '-q', 'src/dead.js']);
      writeFileSync(path.join(repoRoot, 'src', 'calc.test.js'), '// pins value()===2\n');
      await git(repoRoot, ['add', '.']);
      await git(repoRoot, ['commit', '-m', 'task: rename, delete and bump', '-q']);

      const detected = await git(repoRoot, ['diff', '-M', '--name-status', `${baseRef}...HEAD`]);
      expect(detected).toMatch(/^R\d*\tsrc\/old\.js\tsrc\/new\.js$/m);

      const changed = changedFilesFor(realGitExec, repoRoot, baseRef);
      expect(changed.ok).toBe(true);
      if (!changed.ok) return;
      expect([...changed.deletedFiles].sort()).toEqual(['src/dead.js', 'src/old.js']);

      const statusBefore = await git(repoRoot, ['status', '--porcelain']);
      const hashBefore = await workingTreeHash(repoRoot);
      const treesSeen: string[] = [];
      const runTests: TestRunFn = async ({ repoRoot: rr }) => {
        const present = ['src/new.js', 'src/old.js', 'src/dead.js'].filter((file) =>
          existsSync(path.join(rr, file)),
        );
        treesSeen.push(present.join(','));
        return ran(existsSync(path.join(rr, 'src', 'new.js')));
      };

      const result = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: changed.files,
        deletedFiles: changed.deletedFiles,
        runTests,
        riskTier: 'high',
      });

      expect(treesSeen).toEqual(['src/new.js', 'src/old.js,src/dead.js']);
      expect(result.passed).toBe(true);
      expect(result.restoredClean).toBe(true);
      expect(await git(repoRoot, ['status', '--porcelain'])).toBe(statusBefore);
      expect(await workingTreeHash(repoRoot)).toBe(hashBefore);
      expect(existsSync(path.join(repoRoot, 'src', 'old.js'))).toBe(false);
      expect(existsSync(path.join(repoRoot, 'src', 'dead.js'))).toBe(false);
    },
    30_000,
  );

  /** A failed restore wins over `baseline-red`, because a tree that did not restore makes every other fact untrusted. */
  it(
    'Probe_RestoreFailsAfterBaselineRed_IsRestoreFailed',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo(
        'test-adequacy-probe-restore-wins-',
      );
      repos.push(repoRoot);

      const restoreRefusingGitExec: GitExec = (root, args) =>
        args[0] === 'checkout' && args.at(-1) === '.'
          ? { stdout: 'injected restore failure', exitCode: 1 }
          : realGitExec(root, args);

      const result = await runProbe({
        gitExec: restoreRefusingGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, testFile],
        runTests: async () => ran(false, 'red on the task source'),
        riskTier: 'low',
      });

      expect(result.discriminant).toBe('restore-failed');
      expect(result.restoredClean).toBe(false);
      expect(result.passed).toBe(false);
    },
    30_000,
  );

  /**
   * The run on the task source ends with no verdict, for example at a timeout. That run is not a red run, so the probe must not
   * call it `baseline-red`. The verdict is `run-no-verdict`, which blocks at every tier, and the probe does not revert the source.
   */
  it(
    'Probe_RunOnTheTaskSourceWithNoVerdict_IsRunNoVerdictAndBlocksAtEveryTier',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo('test-adequacy-probe-pre-no-verdict-');
      repos.push(repoRoot);

      const before = await workingTreeHash(repoRoot);
      for (const riskTier of [undefined, 'low', 'medium', 'high'] as const) {
        const sourcesSeen: string[] = [];
        const runTests: TestRunFn = async ({ repoRoot: rr }) => {
          sourcesSeen.push(readFileSync(path.join(rr, sourceFile), 'utf-8').includes('=> 1') ? 'reverted' : 'task');
          return { kind: 'no-verdict', cause: 'timeout', detail: 'the limit is 120000 ms', stdout: 'partial output' };
        };

        const result = await runProbe({
          gitExec: realGitExec,
          repoRoot,
          baseRef,
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
        expect(sourcesSeen, String(riskTier)).toEqual(['task']);
        expect(await workingTreeHash(repoRoot), String(riskTier)).toBe(before);
      }
    },
    30_000,
  );

  /**
   * The run on the task source is green, and the run after the revert ends with no verdict. Before this change a timeout,
   * a signal or an overflow of that run read as a kill, so a vacuous test passed. Each cause must give `run-no-verdict`, never `passed`.
   */
  it(
    'Probe_RunAfterTheRevertWithNoVerdict_IsNeverAKill',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo('test-adequacy-probe-post-no-verdict-');
      repos.push(repoRoot);

      const before = await workingTreeHash(repoRoot);
      for (const cause of ['timeout', 'signal', 'overflow', 'unknown-exit-code'] as const) {
        const runTests: TestRunFn = async ({ repoRoot: rr }) =>
          readFileSync(path.join(rr, sourceFile), 'utf-8').includes('=> 1')
            ? { kind: 'no-verdict', cause, detail: `injected ${cause}` }
            : ran(true);

        const result = await runProbe({
          gitExec: realGitExec,
          repoRoot,
          baseRef,
          changedFiles: [sourceFile, testFile],
          runTests,
          riskTier: 'high',
        });

        expect(result.verdict.kind, cause).toBe('indeterminate');
        expect(result.discriminant, cause).toBe('run-no-verdict');
        expect(result.redObserved, cause).toBe(false);
        expect(result.passed, cause).toBe(false);
        expect(result.restoredClean, cause).toBe(true);
        expect(result.report, cause).toContain(`after the revert reached no verdict (${cause})`);
        expect(await workingTreeHash(repoRoot), cause).toBe(before);
      }
    },
    30_000,
  );

  /** A failed restore wins over `run-no-verdict`, as it wins over `baseline-red`. */
  it(
    'Probe_RestoreFailsAfterARunWithNoVerdict_IsRestoreFailed',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo('test-adequacy-probe-restore-no-verdict-');
      repos.push(repoRoot);

      const restoreRefusingGitExec: GitExec = (root, args) =>
        args[0] === 'checkout' && args.at(-1) === '.'
          ? { stdout: 'injected restore failure', exitCode: 1 }
          : realGitExec(root, args);

      const result = await runProbe({
        gitExec: restoreRefusingGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, testFile],
        runTests: async () => ({ kind: 'no-verdict', cause: 'signal', detail: 'the signal is SIGKILL' }),
        riskTier: 'low',
      });

      expect(result.discriminant).toBe('restore-failed');
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
      const { repoRoot, baseRef, sourceFile, testFile } = await setupTaskRepo('test-adequacy-probe-first-stderr-');
      repos.push(repoRoot);

      const stdout = Array.from({ length: 7 }, (_, i) => `stdout line ${i}`).join('\n');
      const stderr = [
        '',
        'No test files found, exiting with code 1',
        ...Array.from({ length: 30 }, (_, i) => `stderr line ${i}`),
      ].join('\n');
      const result = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
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

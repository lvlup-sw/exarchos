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

import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  splitHunks,
  snapshotWorkingTree,
  revertSourceFiles,
  restoreWorkingTree,
  runProbe,
  type ProbeResult,
  type TestRunFn,
} from './test-adequacy.js';
import type { GitExec } from './pure/execute-merge.js';

// ─── real-git helpers (tasks 012/013) ────────────────────────────────────────

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Production-shaped GitExec over a real repo (mirrors merge-orchestrate's). */
const realGitExec: GitExec = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 30_000,
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

function initRepo(prefix: string): string {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
  git(repoRoot, ['init', '--initial-branch=main', '-q']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test']);
  git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  return repoRoot;
}

/**
 * Repo with a base commit (`return 1`) on `main`, then a task commit on a
 * feature branch changing source (`return 2`) + adding a test. The working
 * tree at HEAD is clean. Returns the repoRoot, base ref, and the source file.
 */
function setupTaskRepo(prefix: string): {
  repoRoot: string;
  baseRef: string;
  sourceFile: string;
  testFile: string;
} {
  const repoRoot = initRepo(prefix);
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 1;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'base', '-q']);
  const baseRef = git(repoRoot, ['rev-parse', 'HEAD']).trim();

  git(repoRoot, ['checkout', '-b', 'feature/x', '-q']);
  writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 2;\n');
  writeFileSync(path.join(repoRoot, 'src', 'calc.test.js'), "// pins value()===2\n");
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'task: bump to 2 + test', '-q']);

  return { repoRoot, baseRef, sourceFile: 'src/calc.js', testFile: 'src/calc.test.js' };
}

/** Hash of the full working tree (HEAD index + worktree) for equality checks. */
function workingTreeHash(repoRoot: string): string {
  // `git stash create` returns a commit sha capturing the working tree; using
  // its tree sha gives a stable content fingerprint without mutating refs.
  const stashSha = git(repoRoot, ['stash', 'create']).trim();
  if (!stashSha) {
    // Clean tree — fingerprint HEAD's tree.
    return git(repoRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  }
  return git(repoRoot, ['rev-parse', `${stashSha}^{tree}`]).trim();
}

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

// ─── task 012: snapshot / revert / restore (INV-14) ──────────────────────────

describe('snapshot/revert/restore (INV-14: refuse-to-discard recovery)', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it(
    'Snapshot_BeforeProbe_UsesRefuseToDiscardRef',
    () => {
      const { repoRoot } = setupTaskRepo('test-adequacy-snap-');
      repos.push(repoRoot);

      // Dirty the worktree so the snapshot has something non-trivial to hold:
      // `git stash create` (object-only) must capture it WITHOUT mutating any
      // ref (no `stash push`) — that is the refuse-to-discard property.
      writeFileSync(path.join(repoRoot, 'src', 'calc.js'), 'export const value = () => 99;\n');

      const stashRefsBefore = git(repoRoot, ['stash', 'list']);
      const snap = snapshotWorkingTree(realGitExec, repoRoot);

      expect('stashSha' in snap).toBe(true);
      if ('stashSha' in snap) {
        // A real commit object capturing the dirty tree.
        expect(snap.stashSha).toMatch(/^[0-9a-f]{40}$/);
      }
      // No ref was mutated — the stash list is unchanged (object-only create).
      expect(git(repoRoot, ['stash', 'list'])).toBe(stashRefsBefore);
    },
    30_000,
  );

  it(
    'Restore_AfterProbe_TreeHashMatchesSnapshot',
    () => {
      const { repoRoot, baseRef, sourceFile } = setupTaskRepo('test-adequacy-restore-');
      repos.push(repoRoot);

      const before = workingTreeHash(repoRoot);
      const snap = snapshotWorkingTree(realGitExec, repoRoot);
      expect('stashSha' in snap).toBe(true);

      // Revert source back to base (probe's mutation step), then restore.
      const reverted = revertSourceFiles(realGitExec, repoRoot, baseRef, [sourceFile]);
      expect(reverted.ok).toBe(true);
      // After revert the tree differs from the snapshot.
      expect(workingTreeHash(repoRoot)).not.toBe(before);

      if ('stashSha' in snap) {
        const restore = restoreWorkingTree(realGitExec, repoRoot, snap.stashSha);
        expect(restore.restored).toBe(true);
      }
      // Restored tree is byte-identical to the pre-probe snapshot.
      expect(workingTreeHash(repoRoot)).toBe(before);
    },
    30_000,
  );

  it(
    'Restore_OnProbeError_StillRestores',
    () => {
      const { repoRoot, baseRef, sourceFile } = setupTaskRepo('test-adequacy-restore-err-');
      repos.push(repoRoot);

      const before = workingTreeHash(repoRoot);
      const snap = snapshotWorkingTree(realGitExec, repoRoot);
      expect('stashSha' in snap).toBe(true);
      if (!('stashSha' in snap)) throw new Error('snapshot failed');

      // Simulate the probe body throwing AFTER the source was reverted; the
      // caller's finally must still run restore. We assert that directly: even
      // when a thrown error interrupts, restore brings the tree back.
      let restored = false;
      try {
        revertSourceFiles(realGitExec, repoRoot, baseRef, [sourceFile]);
        throw new Error('injected test-run failure');
      } catch {
        const restore = restoreWorkingTree(realGitExec, repoRoot, snap.stashSha);
        restored = restore.restored;
      }
      expect(restored).toBe(true);
      expect(workingTreeHash(repoRoot)).toBe(before);
    },
    30_000,
  );

  it(
    'Revert_Conflict_ReturnsRevertConflictDiscriminant',
    () => {
      const { repoRoot } = setupTaskRepo('test-adequacy-conflict-');
      repos.push(repoRoot);

      // Ask to revert a path that does not exist at the base ref → the targeted
      // `git checkout <base> -- <path>` fails. The helper must surface a
      // structured 'revert-conflict' discriminant, never throw or silently no-op.
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
    () => {
      const { repoRoot, baseRef } = setupTaskRepo('test-adequacy-added-source-');
      repos.push(repoRoot);
      const addedSource = 'src/new-helper.js';
      const addedContent = 'export const helper = true;\n';
      writeFileSync(path.join(repoRoot, addedSource), addedContent);
      git(repoRoot, ['add', addedSource]);
      git(repoRoot, ['commit', '-m', 'task: add source helper', '-q']);

      const snap = snapshotWorkingTree(realGitExec, repoRoot);
      expect('stashSha' in snap).toBe(true);
      if (!('stashSha' in snap)) throw new Error('snapshot failed');

      const reverted = revertSourceFiles(realGitExec, repoRoot, baseRef, [
        'src/calc.js',
        addedSource,
      ]);
      expect(reverted.ok).toBe(true);
      expect(() => git(repoRoot, ['show', `:${addedSource}`])).toThrow();

      const restored = restoreWorkingTree(realGitExec, repoRoot, snap.stashSha);
      expect(restored.restored).toBe(true);
      expect(git(repoRoot, ['show', `:${addedSource}`])).toBe(addedContent);
    },
    30_000,
  );
});

// ─── task 013: probe orchestration + carrier ─────────────────────────────────

describe('runProbe (compose split → snapshot → revert → run → restore)', () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const r of repos.splice(0)) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it(
    'Probe_NoNewTests_ReturnsNoNewTestsDiscriminant',
    async () => {
      const { repoRoot, baseRef } = setupTaskRepo('test-adequacy-probe-notest-');
      repos.push(repoRoot);

      // Diff has ONLY a source file — no test file. The probe must short-circuit
      // with the no-new-tests discriminant and NOT run any test command.
      let testRan = false;
      const testRun: TestRunFn = async () => {
        testRan = true;
        return { passed: true };
      };

      const result: ProbeResult = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: ['src/calc.js'],
        runTests: testRun,
      });

      // FIX-1b: a task that adds NO new/changed tests has nothing to probe —
      // this is a SKIPPED/advisory pass (passed:true), NOT a blocking failure.
      // The discriminant still names the mode; the report is self-explanatory.
      expect(result.discriminant).toBe('no-new-tests');
      expect(result.passed).toBe(true);
      expect(result.report).toContain('nothing to probe');
      expect(result.report).toContain('no tests');
      expect(result.probedTests).toEqual([]);
      expect(testRan).toBe(false);
    },
    30_000,
  );

  it(
    'Probe_NewTestFailsOnRevert_RedObservedTrue_PassedTrue',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = setupTaskRepo(
        'test-adequacy-probe-red-',
      );
      repos.push(repoRoot);

      const before = workingTreeHash(repoRoot);

      // The test runner reports FAIL when the source has been reverted (the new
      // test pins the new behavior). We detect "reverted" by reading the
      // current source content via git.
      const runTests: TestRunFn = async ({ repoRoot: rr }) => {
        const src = git(rr, ['show', ':' + sourceFile]).trim();
        // After revert, the worktree source equals base (`=> 1`).
        const reverted = src.includes('=> 1');
        return { passed: !reverted };
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
      // Working tree restored to pre-probe state.
      expect(workingTreeHash(repoRoot)).toBe(before);
    },
    30_000,
  );

  it(
    'Probe_NewTestPassesOnRevert_PassedFalse',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = setupTaskRepo(
        'test-adequacy-probe-green-',
      );
      repos.push(repoRoot);

      const before = workingTreeHash(repoRoot);

      // A vacuous test stays GREEN even with source reverted → no red observed.
      const runTests: TestRunFn = async () => ({ passed: true });

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
      expect(workingTreeHash(repoRoot)).toBe(before);
    },
    30_000,
  );

  it(
    'Probe_Result_CarriesProbedTestsAndRestoredClean',
    async () => {
      const { repoRoot, baseRef, sourceFile, testFile } = setupTaskRepo(
        'test-adequacy-probe-carrier-',
      );
      repos.push(repoRoot);

      const runTests: TestRunFn = async () => ({ passed: false });

      const result = await runProbe({
        gitExec: realGitExec,
        repoRoot,
        baseRef,
        changedFiles: [sourceFile, testFile],
        runTests,
      });

      // Carrier shape: probedTests is the classified test files, restoredClean
      // reflects the unconditional restore.
      expect(result.probedTests).toEqual([testFile]);
      expect(result.restoredClean).toBe(true);
      expect(typeof result.passed).toBe('boolean');
      expect(typeof result.redObserved).toBe('boolean');
    },
    30_000,
  );
});

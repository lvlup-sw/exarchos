// The kill probe must not report a vacuous pass. These tests pin three cases.
//
// 1. A failed diff read is a failure, not an empty list of changed files.
// 2. A named task branch must be the branch of the checkout, so the diff never measures another head.
//    From the main worktree, a `HEAD` diff is empty for a branch that adds tests.
// 3. A medium-risk or high-risk task without probe-able tests fails.

import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runProbe, type TestRunFn } from '../../../../src/verbs/gates/test-adequacy.js';
import { readTaskDiff } from '../../../../src/verbs/gates/test-adequacy-handler.js';
import { buildDisposableCopy, type SourceRevert } from '../../../../src/verbs/verification/disposable-copy.js';
import { createConstrainedGitReads, processObservationalGitPath } from '../../../../src/utils/git-tree.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

/**
 * A runner that builds the head image or the reverted image of the checked-out head and answers from it.
 * `green` reads the image root and gives true for a green run. The image goes after the answer.
 */
async function imageRunner(repoRoot: string, revert: SourceRevert, green: (root: string) => boolean): Promise<TestRunFn> {
  const gitPath = processObservationalGitPath();
  if (gitPath === undefined) throw new Error('No Git on PATH');
  const checkout = await realpath(repoRoot);
  const gitDir = path.join(checkout, '.git');
  const source = { checkout, gitDir, repository: gitDir, head: (await git(checkout, ['rev-parse', 'HEAD'])).trim(),
    reads: await createConstrainedGitReads(gitPath) };
  return async (input) => {
    const image = await buildDisposableCopy(source, input.source === 'reverted' ? revert : undefined);
    try {
      return { kind: 'ran', result: green(image.root) ? 'green' : 'red' };
    } finally {
      await image.dispose();
    }
  };
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
 * Commits a base on `main` and a task branch that adds a new source module and its test.
 * Then it checks out `main` again, as in the main worktree of the orchestrator.
 */
async function setupCommittedTaskBranch(prefix: string): Promise<{
  repoRoot: string;
  baseRef: string;
  branch: string;
}> {
  const repoRoot = await initRepo(prefix);
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'existing.js'), 'export const kept = () => 0;\n');
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'base', '-q']);
  const baseRef = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

  await git(repoRoot, ['checkout', '-b', 'feature/added', '-q']);
  writeFileSync(path.join(repoRoot, 'src', 'added.js'), 'export const added = () => 42;\n');
  writeFileSync(path.join(repoRoot, 'src', 'added.test.js'), '// pins added()===42\n');
  await git(repoRoot, ['add', '.']);
  await git(repoRoot, ['commit', '-m', 'task: add module + test', '-q']);

  await git(repoRoot, ['checkout', 'main', '-q']);

  return { repoRoot, baseRef, branch: 'feature/added' };
}

describe('TestAdequacy_CommittedBranchDiscovery (WFQ-005)', () => {
  /** A named branch that the checkout does not hold refuses, so the diff never measures another head. On its checkout, the branch diff shows the added files. */
  it('refuses a named branch that the checkout does not hold, and discovers the added files on its checkout', async () => {
    const { repoRoot, baseRef, branch } = await setupCommittedTaskBranch('wfq005-disc-');

    const elsewhere = await readTaskDiff(repoRoot, { kind: 'base', baseRef, branch });
    expect(elsewhere.ok).toBe(false);
    if (elsewhere.ok) return;
    expect(elsewhere.detail).toContain('is not the branch of the checkout');

    await git(repoRoot, ['checkout', branch, '-q']);
    const viaBranch = await readTaskDiff(repoRoot, { kind: 'base', baseRef, branch });
    expect(viaBranch.ok).toBe(true);
    if (!viaBranch.ok) return;
    expect(viaBranch.files).toEqual(
      expect.arrayContaining(['src/added.js', 'src/added.test.js']),
    );
  });

  /** With `HEAD` on `main`, the diff is empty, although the branch adds a test file. */
  it('returns an empty diff — not the branch diff — when HEAD is used instead of the branch', async () => {
    const { repoRoot, baseRef } = await setupCommittedTaskBranch('wfq005-head-');

    const viaHead = await readTaskDiff(repoRoot, { kind: 'base', baseRef });
    expect(viaHead.ok).toBe(true);
    if (!viaHead.ok) return;
    expect(viaHead.files).toEqual([]);
  });

  /**
   * The branch deletes a test file of the base, so the diff marks it deleted and the probe never runs it.
   * The new test file is almost the same as the deleted one, so git with rename detection reports a rename.
   * The diff turns rename detection off and is NUL-separated, so git does not quote a path with non-ASCII characters.
   */
  it('marks a deleted test file as deleted, keeps a non-ASCII path unquoted, and probes only the tests at the head', async () => {
    const repoRoot = await initRepo('wfq005-deleted-');
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'kept.js'), 'export const kept = () => 1;\n');
    const sharedLines = Array.from({ length: 12 }, (_, i) => `// shared line ${i}\n`).join('');
    writeFileSync(path.join(repoRoot, 'src', 'old.test.js'), `${sharedLines}// pins kept()===1\n`);
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-m', 'base', '-q']);
    const baseRef = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();
    await git(repoRoot, ['checkout', '-b', 'feature/replace', '-q']);
    writeFileSync(path.join(repoRoot, 'src', 'kept.js'), 'export const kept = () => 2;\n');
    await git(repoRoot, ['rm', '-q', 'src/old.test.js']);
    writeFileSync(path.join(repoRoot, 'src', 'räkna.test.js'), `${sharedLines}// pins kept()===2\n`);
    await git(repoRoot, ['add', '.']);
    await git(repoRoot, ['commit', '-m', 'task: replace the test', '-q']);

    const changed = await readTaskDiff(repoRoot, { kind: 'base', baseRef, branch: 'feature/replace' });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.files).toHaveLength(3);
    for (const file of ['src/kept.js', 'src/old.test.js', 'src/räkna.test.js']) {
      expect(changed.files).toContain(file);
    }
    expect(changed.deletedFiles).toEqual(['src/old.test.js']);

    const result = await runProbe({
      changedFiles: changed.files,
      deletedFiles: changed.deletedFiles,
      riskTier: 'high',
      runTests: await imageRunner(repoRoot, { base: changed.base, sources: ['src/kept.js'] },
        (root) => readFileSync(path.join(root, 'src', 'kept.js'), 'utf-8').includes('=> 2')),
    });
    expect(result.probedTests).toEqual(['src/räkna.test.js']);
    expect(result.passed).toBe(true);
    expect(existsSync(path.join(repoRoot, 'src', 'old.test.js'))).toBe(false);
  });

  it('reports a git failure as a failure rather than an empty file list', async () => {
    const { repoRoot } = await setupCommittedTaskBranch('wfq005-gitfail-');

    const result = await readTaskDiff(repoRoot, { kind: 'base', baseRef: 'does-not-exist' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('was not resolved');
  });
});

describe('TestAdequacy_NoFalseAdvisorySuccess (WFQ-005)', () => {
  const neverRun: TestRunFn = () => {
    throw new Error('test command must not run when there is nothing to probe');
  };

  it('fails closed when the task diff could not be computed', async () => {
    const result = await runProbe({
      changedFiles: [],
      diffFailed: true,
      riskTier: 'low',
      runTests: neverRun,
    });

    expect(result.passed).toBe(false);
    expect(result.discriminant).toBe('diff-failed');
    expect(result.report).toContain('could not compute the task diff');
  });

  it('fails a medium-risk task that ships no probe-able tests', async () => {
    const result = await runProbe({
      changedFiles: ['src/only-source.js'],
      riskTier: 'medium',
      runTests: neverRun,
    });

    expect(result.passed).toBe(false);
    expect(result.discriminant).toBe('no-new-tests');
    expect(result.report).toContain('requires a kill probe');
  });

  it('fails a high-risk task that ships no probe-able tests', async () => {
    const result = await runProbe({
      changedFiles: ['src/only-source.js'],
      riskTier: 'high',
      runTests: neverRun,
    });

    expect(result.passed).toBe(false);
    expect(result.discriminant).toBe('no-new-tests');
  });

  it('still advisory-skips a low-risk task with no tests', async () => {
    const result = await runProbe({
      changedFiles: ['src/only-source.js'],
      riskTier: 'low',
      runTests: neverRun,
    });

    expect(result.passed).toBe(true);
    expect(result.discriminant).toBe('no-new-tests');
    expect(result.report).toContain('nothing to probe');
  });

  it('advisory-skips when no risk tier is supplied (unchanged default)', async () => {
    const result = await runProbe({
      changedFiles: ['src/only-source.js'],
      runTests: neverRun,
    });

    expect(result.passed).toBe(true);
    expect(result.discriminant).toBe('no-new-tests');
  });
});

describe('TestAdequacy_TaskAddedSource_RealKillProbe (WFQ-005)', () => {
  /** The test run fails exactly when the reverted image lacks the source module, as a real kill probe must observe. */
  it('reverts task-added source and observes a real red, not revert-conflict', async () => {
    const { repoRoot, baseRef, branch } = await setupCommittedTaskBranch('wfq005-kill-');
    await git(repoRoot, ['checkout', branch, '-q']);

    const changed = await readTaskDiff(repoRoot, { kind: 'base', baseRef, branch });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    const runTests = await imageRunner(repoRoot, { base: changed.base, sources: ['src/added.js'] },
      (root) => existsSync(path.join(root, 'src', 'added.js')));

    const result = await runProbe({
      changedFiles: changed.files,
      riskTier: 'high',
      runTests,
    });

    expect(result.discriminant).toBeUndefined();
    expect(result.probedTests).toContain('src/added.test.js');
    expect(result.redObserved).toBe(true);
    expect(result.restoredClean).toBe(true);
    expect(result.passed).toBe(true);
  });
});

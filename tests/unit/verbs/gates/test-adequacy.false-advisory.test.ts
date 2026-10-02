// The kill probe must not report a vacuous pass. These tests pin three cases.
//
// 1. A failed `git diff` is a failure, not an empty list of changed files.
// 2. The diff uses the named task branch, not the checked-out `HEAD`.
//    From the main worktree, a `HEAD` diff is empty for a branch that adds tests.
// 3. A medium-risk or high-risk task without probe-able tests fails.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runProbe, type TestRunFn } from '../../../../src/verbs/gates/test-adequacy.js';
import { changedFilesFor } from '../../../../src/verbs/gates/test-adequacy-handler.js';
import type { GitExec } from '../../../../src/verbs/pure/execute-merge.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';

function git(repoRoot: string, args: readonly string[]): Promise<string> {
  return execFileAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
}

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
  it('discovers task-added files from a named branch when HEAD is a different branch', async () => {
    const { repoRoot, baseRef, branch } = await setupCommittedTaskBranch('wfq005-disc-');

    const viaBranch = changedFilesFor(realGitExec, repoRoot, baseRef, branch);
    expect(viaBranch.ok).toBe(true);
    if (!viaBranch.ok) return;
    expect(viaBranch.files).toEqual(
      expect.arrayContaining(['src/added.js', 'src/added.test.js']),
    );
  });

  /** With `HEAD` on `main`, the diff is empty, although the branch adds a test file. */
  it('returns an empty diff — not the branch diff — when HEAD is used instead of the branch', async () => {
    const { repoRoot, baseRef } = await setupCommittedTaskBranch('wfq005-head-');

    const viaHead = changedFilesFor(realGitExec, repoRoot, baseRef);
    expect(viaHead.ok).toBe(true);
    if (!viaHead.ok) return;
    expect(viaHead.files).toEqual([]);
  });

  it('reports a git failure as a failure rather than an empty file list', async () => {
    const { repoRoot, baseRef } = await setupCommittedTaskBranch('wfq005-gitfail-');

    const result = changedFilesFor(realGitExec, repoRoot, baseRef, 'refs/heads/does-not-exist');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('git diff');
  });
});

describe('TestAdequacy_NoFalseAdvisorySuccess (WFQ-005)', () => {
  const neverRun: TestRunFn = () => {
    throw new Error('test command must not run when there is nothing to probe');
  };

  it('fails closed when the task diff could not be computed', async () => {
    const result = await runProbe({
      gitExec: realGitExec,
      repoRoot: '/nonexistent',
      baseRef: 'main',
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
      gitExec: realGitExec,
      repoRoot: '/unused',
      baseRef: 'main',
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
      gitExec: realGitExec,
      repoRoot: '/unused',
      baseRef: 'main',
      changedFiles: ['src/only-source.js'],
      riskTier: 'high',
      runTests: neverRun,
    });

    expect(result.passed).toBe(false);
    expect(result.discriminant).toBe('no-new-tests');
  });

  it('still advisory-skips a low-risk task with no tests', async () => {
    const result = await runProbe({
      gitExec: realGitExec,
      repoRoot: '/unused',
      baseRef: 'main',
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
      gitExec: realGitExec,
      repoRoot: '/unused',
      baseRef: 'main',
      changedFiles: ['src/only-source.js'],
      runTests: neverRun,
    });

    expect(result.passed).toBe(true);
    expect(result.discriminant).toBe('no-new-tests');
  });
});

describe('TestAdequacy_TaskAddedSource_RealKillProbe (WFQ-005)', () => {
  /** The fake test run fails exactly when the source module is absent, as a real kill probe must observe. */
  it('reverts task-added source and observes a real red, not revert-conflict', async () => {
    const { repoRoot, baseRef, branch } = await setupCommittedTaskBranch('wfq005-kill-');
    await git(repoRoot, ['checkout', branch, '-q']);

    const changed = changedFilesFor(realGitExec, repoRoot, baseRef, branch);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    const runTests: TestRunFn = () =>
      Promise.resolve(existsSync(path.join(repoRoot, 'src', 'added.js')));

    const result = await runProbe({
      gitExec: realGitExec,
      repoRoot,
      baseRef,
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

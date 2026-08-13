// ─── WFQ-005 / P02-04: no false advisory success ─────────────────────────────
//
// The kill probe is the sole load-bearing per-task verification gate. Three
// ways it used to report a vacuous PASS:
//
//   1. `git diff` failed  → changed files came back `[]` → `no-new-tests` PASS.
//   2. The diff was taken against the checked-out `HEAD` rather than the named
//      task branch, so an orchestrator calling from the main worktree saw an
//      empty diff for a branch that plainly added tests → `no-new-tests` PASS.
//   3. A medium/high-risk task that shipped no probe-able tests was skipped
//      advisory-PASS, which is exactly the tier where the probe is required.
//
// These tests pin all three closed.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runProbe, type TestRunFn } from './test-adequacy.js';
import { changedFilesFor } from './test-adequacy-handler.js';
import type { GitExec } from '../pure/execute-merge.js';

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

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
 * Base commit on `main`, then a committed task branch that adds an entirely
 * NEW source module plus its NEW test, and leaves `main` checked out. This is
 * the shape the gate previously mis-handled: task-added source paths, on a
 * committed branch, observed from a repo whose HEAD is not that branch.
 */
function setupCommittedTaskBranch(prefix: string): {
  repoRoot: string;
  baseRef: string;
  branch: string;
} {
  const repoRoot = initRepo(prefix);
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'src', 'existing.js'), 'export const kept = () => 0;\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'base', '-q']);
  const baseRef = git(repoRoot, ['rev-parse', 'HEAD']).trim();

  git(repoRoot, ['checkout', '-b', 'feature/added', '-q']);
  writeFileSync(path.join(repoRoot, 'src', 'added.js'), 'export const added = () => 42;\n');
  writeFileSync(path.join(repoRoot, 'src', 'added.test.js'), '// pins added()===42\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-m', 'task: add module + test', '-q']);

  // Leave the repo on main — the orchestrator's main-worktree situation.
  git(repoRoot, ['checkout', 'main', '-q']);

  return { repoRoot, baseRef, branch: 'feature/added' };
}

describe('TestAdequacy_CommittedBranchDiscovery (WFQ-005)', () => {
  it('discovers task-added files from a named branch when HEAD is a different branch', () => {
    const { repoRoot, baseRef, branch } = setupCommittedTaskBranch('wfq005-disc-');

    const viaBranch = changedFilesFor(realGitExec, repoRoot, baseRef, branch);
    expect(viaBranch.ok).toBe(true);
    if (!viaBranch.ok) return;
    expect(viaBranch.files).toEqual(
      expect.arrayContaining(['src/added.js', 'src/added.test.js']),
    );
  });

  it('returns an empty diff — not the branch diff — when HEAD is used instead of the branch', () => {
    // Characterizes WHY the bug passed vacuously: HEAD is main, so the diff is
    // empty even though the branch plainly added a test file.
    const { repoRoot, baseRef } = setupCommittedTaskBranch('wfq005-head-');

    const viaHead = changedFilesFor(realGitExec, repoRoot, baseRef);
    expect(viaHead.ok).toBe(true);
    if (!viaHead.ok) return;
    expect(viaHead.files).toEqual([]);
  });

  it('reports a git failure as a failure rather than an empty file list', () => {
    const { repoRoot, baseRef } = setupCommittedTaskBranch('wfq005-gitfail-');

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
  it('reverts task-added source and observes a real red, not revert-conflict', async () => {
    const { repoRoot, baseRef, branch } = setupCommittedTaskBranch('wfq005-kill-');
    git(repoRoot, ['checkout', branch, '-q']);

    const changed = changedFilesFor(realGitExec, repoRoot, baseRef, branch);
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;

    // The test "fails" exactly when the source module it pins is absent —
    // the behaviour a genuine kill probe must observe.
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

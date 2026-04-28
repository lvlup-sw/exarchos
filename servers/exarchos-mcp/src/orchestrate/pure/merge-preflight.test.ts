/**
 * Tests for merge-preflight pure helpers.
 *
 * T04 scope: detectDrift clean-tree path only.
 * T05 extended coverage to dirty-tree, stale-index, and detached-HEAD cases.
 * T06 adds mergePreflight composer happy-path coverage.
 */

import { describe, it, expect } from 'vitest';
import { detectDrift, mergePreflight, type GitExec } from './merge-preflight.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a mock GitExec that returns canned `{ stdout, exitCode }` results
 * for matching arg sequences. Unmatched calls throw so tests fail loudly
 * if the implementation reaches for git commands the test didn't stub.
 */
function makeGitExec(
  responses: ReadonlyArray<{
    args: readonly string[];
    stdout: string;
    exitCode?: number;
  }>,
): GitExec {
  return (_repoRoot, args) => {
    const match = responses.find(
      (r) =>
        r.args.length === args.length && r.args.every((a, i) => a === args[i]),
    );
    if (!match) {
      throw new Error(
        `Unexpected gitExec call: git ${args.join(' ')}`,
      );
    }
    return { stdout: match.stdout, exitCode: match.exitCode ?? 0 };
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('detectDrift — clean tree (T04)', () => {
  it('detectDrift_CleanTree_ReturnsCleanTrue', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.clean).toBe(true);
  });

  it('detectDrift_NoUncommittedFiles_EmptyList', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.uncommittedFiles).toEqual([]);
  });
});

describe('detectDrift — drift extensions (T05)', () => {
  it('detectDrift_UncommittedFiles_ListsThemAndCleanFalse', () => {
    const gitExec = makeGitExec([
      {
        args: ['status', '--porcelain'],
        stdout: ' M src/foo.ts\n?? src/bar.ts\n',
        exitCode: 0,
      },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.uncommittedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(result.clean).toBe(false);
  });

  it('detectDrift_StaleIndex_IndexStaleTrue', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 1 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'main\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.indexStale).toBe(true);
    expect(result.clean).toBe(false);
  });

  it('detectDrift_DetachedHead_DetachedHeadTrue', () => {
    const gitExec = makeGitExec([
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'HEAD\n',
        exitCode: 0,
      },
    ]);

    const result = detectDrift(gitExec, '/repo');

    expect(result.detachedHead).toBe(true);
    expect(result.clean).toBe(false);
  });
});

// ─── mergePreflight (T06) ───────────────────────────────────────────────────

describe('mergePreflight — happy path (T06)', () => {
  /**
   * Build a happy-path gitExec mock: ancestry passes, current branch is
   * `feat/x`, working tree is clean. Repo path is `/tmp/repo` so
   * assertMainWorktree (filesystem-only) treats it as a main worktree
   * (no `.claude/worktrees/` segment).
   */
  function makeHappyGitExec(): GitExec {
    return makeGitExec([
      // validateBranchAncestry: merge-base --is-ancestor source target
      {
        args: ['merge-base', '--is-ancestor', 'feat/x', 'main'],
        stdout: '',
        exitCode: 0,
      },
      // getCurrentBranch + detectDrift both call this
      {
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        stdout: 'feat/x\n',
        exitCode: 0,
      },
      // detectDrift: clean working tree
      { args: ['status', '--porcelain'], stdout: '', exitCode: 0 },
      { args: ['diff', '--cached', '--quiet'], stdout: '', exitCode: 0 },
    ]);
  }

  it('mergePreflight_AllGuardsPassAndCleanTree_ReturnsPassedTrue', async () => {
    const gitExec = makeHappyGitExec();

    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: '/tmp/repo',
    });

    expect(result.passed).toBe(true);
  });

  it('mergePreflight_PopulatesAllFourSubResults_StructurePreserved', async () => {
    const gitExec = makeHappyGitExec();

    const result = await mergePreflight({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      gitExec,
      cwd: '/tmp/repo',
    });

    // Ancestry: passed=true, no missing list (validateBranchAncestry
    // returns `{ passed: true, checks: ['ancestry'] }` on success).
    expect(result.ancestry).toBeDefined();
    expect(result.ancestry.passed).toBe(true);

    // Current-branch protection: feat/x is not protected.
    expect(result.currentBranchProtection).toBeDefined();
    expect(result.currentBranchProtection.blocked).toBe(false);

    // Worktree: /tmp/repo has no .claude/worktrees/ segment → main.
    expect(result.worktree).toBeDefined();
    expect(result.worktree.isMain).toBe(true);
    expect(result.worktree.actual).toBe('/tmp/repo');

    // Drift: clean working tree, no uncommitted files, index in sync, on a named branch.
    expect(result.drift).toBeDefined();
    expect(result.drift.clean).toBe(true);
    expect(result.drift.uncommittedFiles).toEqual([]);
    expect(result.drift.indexStale).toBe(false);
    expect(result.drift.detachedHead).toBe(false);
  });
});

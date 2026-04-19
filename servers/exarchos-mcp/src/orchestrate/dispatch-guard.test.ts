// ─── Dispatch Guard Tests ────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import {
  validateBranchAncestry,
  assertMainWorktree,
  assertCurrentBranchNotProtected,
  getCurrentBranch,
} from './dispatch-guard.js';
import type { AncestryResult, WorktreeAssertionResult } from './dispatch-guard.js';

// ─── validateBranchAncestry ────────────────────────────────────────────────

describe('validateBranchAncestry', () => {
  it('validateBranchAncestry_AncestorPresent_ReturnsPassed', async () => {
    // Arrange: gitExec returns successfully (exit 0 means ancestor present)
    const gitExec = vi.fn().mockReturnValue('');

    // Act
    const result = await validateBranchAncestry(
      'feature/my-branch',
      ['main'],
      gitExec,
    );

    // Assert
    expect(result.passed).toBe(true);
    expect(result.checks).toContain('ancestry');
    expect(result.blocked).toBeUndefined();
    expect(gitExec).toHaveBeenCalledWith([
      'merge-base', '--is-ancestor', 'main', 'feature/my-branch',
    ]);
  });

  it('validateBranchAncestry_AncestorMissing_ReturnsBlocked', async () => {
    // Arrange: gitExec throws (non-zero exit means not an ancestor)
    const gitExec = vi.fn().mockImplementation((args: readonly string[]) => {
      const err = new Error('exit code 1') as Error & { status: number };
      err.status = 1;
      throw err;
    });

    // Act
    const result = await validateBranchAncestry(
      'feature/my-branch',
      ['main'],
      gitExec,
    );

    // Assert
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('ancestry');
    expect(result.missing).toContain('main');
  });

  it('validateBranchAncestry_GitCommandFails_ReturnsGitError', async () => {
    // Arrange: gitExec throws a general error (not ancestry-related)
    const gitExec = vi.fn().mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    // Act
    const result = await validateBranchAncestry(
      'feature/my-branch',
      ['main'],
      gitExec,
    );

    // Assert — DR-10: must not throw, returns structured error
    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('git-error');
    expect(result.error).toContain('not a git repository');
  });

  it('validateBranchAncestry_EmptyUpstream_ReturnsPassed', async () => {
    // Arrange: no upstream branches to check
    const gitExec = vi.fn();

    // Act
    const result = await validateBranchAncestry(
      'feature/my-branch',
      [],
      gitExec,
    );

    // Assert
    expect(result.passed).toBe(true);
    expect(result.checks).toContain('ancestry');
    expect(gitExec).not.toHaveBeenCalled();
  });
});

// ─── assertMainWorktree ──────────────────────────────────────────────────────

describe('assertMainWorktree', () => {
  it('assertMainWorktree_MainWorktree_ReturnsIsMainTrue', () => {
    // Arrange: a normal repo path (no .claude/worktrees/)
    const path = '/home/user/repo';

    // Act
    const result = assertMainWorktree(path);

    // Assert
    expect(result.isMain).toBe(true);
    expect(result.actual).toBe(path);
    expect(result.expected).toBeDefined();
  });

  it('assertMainWorktree_SubagentWorktree_ReturnsIsMainFalse', () => {
    // Arrange: path containing .claude/worktrees/ (subagent worktree)
    const path = '/home/user/repo/.claude/worktrees/agent-abc123';

    // Act
    const result = assertMainWorktree(path);

    // Assert
    expect(result.isMain).toBe(false);
    expect(result.actual).toBe(path);
    expect(result.expected).toBeDefined();
  });

  it('assertMainWorktree_CustomPath_UsesProvidedPath', () => {
    // Arrange: explicit cwd argument
    const customPath = '/custom/project/path';

    // Act
    const result = assertMainWorktree(customPath);

    // Assert
    expect(result.isMain).toBe(true);
    expect(result.actual).toBe(customPath);
  });
});

// ─── getCurrentBranch ────────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
  it('getCurrentBranch_OnFeatureBranch_ReturnsBranchName', () => {
    const gitExec = vi.fn().mockReturnValue('feature/my-branch\n');
    expect(getCurrentBranch(gitExec)).toBe('feature/my-branch');
    expect(gitExec).toHaveBeenCalledWith(['rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('getCurrentBranch_GitCommandFails_ReturnsNull', () => {
    const gitExec = vi.fn().mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(getCurrentBranch(gitExec)).toBeNull();
  });

  it('getCurrentBranch_DetachedHead_ReturnsNull', () => {
    // `git rev-parse --abbrev-ref HEAD` returns the literal string 'HEAD'
    // when HEAD is detached. Collapse to null so downstream guards treat
    // it as "no current branch" rather than a branch literally named
    // "HEAD" — otherwise protected-branch checks and fallback logic get
    // a meaningless string instead of the absence signal they expect.
    const gitExec = vi.fn().mockReturnValue('HEAD\n');
    expect(getCurrentBranch(gitExec)).toBeNull();
  });

  it('getCurrentBranch_EmptyOutput_ReturnsNull', () => {
    const gitExec = vi.fn().mockReturnValue('\n');
    expect(getCurrentBranch(gitExec)).toBeNull();
  });
});

// ─── assertCurrentBranchNotProtected ─────────────────────────────────────────

describe('assertCurrentBranchNotProtected', () => {
  it('assertCurrentBranchNotProtected_OnMain_ReturnsBlocked', () => {
    const result = assertCurrentBranchNotProtected('main');
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('current-branch-protected');
    expect(result.currentBranch).toBe('main');
  });

  it('assertCurrentBranchNotProtected_OnMaster_ReturnsBlocked', () => {
    const result = assertCurrentBranchNotProtected('master');
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('current-branch-protected');
  });

  it('assertCurrentBranchNotProtected_OnFeatureBranch_ReturnsNotBlocked', () => {
    const result = assertCurrentBranchNotProtected('feature/dispatch-guards');
    expect(result.blocked).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('assertCurrentBranchNotProtected_OnNullBranch_ReturnsNotBlocked', () => {
    // Null means we couldn't determine current branch — absence of signal
    // shouldn't be upgraded to a block. Other guards (ancestry) still run.
    const result = assertCurrentBranchNotProtected(null);
    expect(result.blocked).toBe(false);
  });
});

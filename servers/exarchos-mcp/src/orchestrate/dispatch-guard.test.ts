// ─── Dispatch Guard Tests ────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import {
  validateBranchAncestry,
  assertMainWorktree,
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

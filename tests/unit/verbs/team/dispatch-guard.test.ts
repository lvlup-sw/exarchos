import { describe, it, expect, vi } from 'vitest';
import {
  validateBranchAncestry,
  assertMainWorktree,
  assertCurrentBranchNotProtected,
  getCurrentBranch,
  probeStashAndEmit,
} from '../../../../src/verbs/team/dispatch-guard.js';
import type { AncestryResult, WorktreeAssertionResult } from '../../../../src/verbs/team/dispatch-guard.js';
import type { EventStore } from '../../../../src/events/store.js';

interface AppendCall {
  streamId: string;
  event: { type: string; data?: Record<string, unknown> };
}

function makeMockEventStore(): { store: EventStore; calls: AppendCall[] } {
  const calls: AppendCall[] = [];
  const appendSpy = vi.fn(async (streamId: string, event: AppendCall['event']) => {
    calls.push({ streamId, event });
    return {
      streamId,
      sequence: calls.length,
      type: event.type,
      timestamp: new Date().toISOString(),
      data: event.data ?? {},
    };
  });
  const store = { append: appendSpy } as unknown as EventStore;
  return { store, calls };
}

describe('validateBranchAncestry', () => {
  /** A git call that returns means exit code 0, so `main` is an ancestor. */
  it('validateBranchAncestry_AncestorPresent_ReturnsPassed', async () => {
    const gitExec = vi.fn().mockReturnValue('');

    const result = await validateBranchAncestry(
      'feature/my-branch',
      ['main'],
      gitExec,
    );

    expect(result.passed).toBe(true);
    expect(result.checks).toContain('ancestry');
    expect(result.blocked).toBeUndefined();
    expect(gitExec).toHaveBeenCalledWith([
      'merge-base', '--is-ancestor', 'main', 'feature/my-branch',
    ]);
  });

  /** A git error with `status` 1 means `main` is not an ancestor. */
  it('validateBranchAncestry_AncestorMissing_ReturnsBlocked', async () => {
    const gitExec = vi.fn().mockImplementation((args: readonly string[]) => {
      const err = new Error('exit code 1') as Error & { status: number };
      err.status = 1;
      throw err;
    });

    const result = await validateBranchAncestry(
      'feature/my-branch',
      ['main'],
      gitExec,
    );

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('ancestry');
    expect(result.missing).toContain('main');
  });

  /** A git error without `status` 1 is a git failure. The function returns `git-error` and does not throw. */
  it('validateBranchAncestry_GitCommandFails_ReturnsGitError', async () => {
    const gitExec = vi.fn().mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    const result = await validateBranchAncestry(
      'feature/my-branch',
      ['main'],
      gitExec,
    );

    expect(result.passed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('git-error');
    expect(result.error).toContain('not a git repository');
  });

  it('validateBranchAncestry_EmptyUpstream_ReturnsPassed', async () => {
    const gitExec = vi.fn();

    const result = await validateBranchAncestry(
      'feature/my-branch',
      [],
      gitExec,
    );

    expect(result.passed).toBe(true);
    expect(result.checks).toContain('ancestry');
    expect(gitExec).not.toHaveBeenCalled();
  });
});

describe('assertMainWorktree', () => {
  it('assertMainWorktree_MainWorktree_ReturnsIsMainTrue', () => {
    const path = '/home/user/repo';

    const result = assertMainWorktree(path);

    expect(result.isMain).toBe(true);
    expect(result.actual).toBe(path);
    expect(result.expected).toBeDefined();
  });

  it('assertMainWorktree_SubagentWorktree_ReturnsIsMainFalse', () => {
    const path = '/home/user/repo/.claude/worktrees/agent-abc123';

    const result = assertMainWorktree(path);

    expect(result.isMain).toBe(false);
    expect(result.actual).toBe(path);
    expect(result.expected).toBeDefined();
  });

  it('assertMainWorktree_CustomPath_UsesProvidedPath', () => {
    const customPath = '/custom/project/path';

    const result = assertMainWorktree(customPath);

    expect(result.isMain).toBe(true);
    expect(result.actual).toBe(customPath);
  });
});

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

  /**
   * A detached HEAD prints the literal `HEAD`. The function returns `null`, so no
   * guard reads it as a branch with the name `HEAD`.
   */
  it('getCurrentBranch_DetachedHead_ReturnsNull', () => {
    const gitExec = vi.fn().mockReturnValue('HEAD\n');
    expect(getCurrentBranch(gitExec)).toBeNull();
  });

  it('getCurrentBranch_EmptyOutput_ReturnsNull', () => {
    const gitExec = vi.fn().mockReturnValue('\n');
    expect(getCurrentBranch(gitExec)).toBeNull();
  });
});

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

  /** An unknown branch gives no signal, so it does not block. */
  it('assertCurrentBranchNotProtected_OnNullBranch_ReturnsNotBlocked', () => {
    const result = assertCurrentBranchNotProtected(null);
    expect(result.blocked).toBe(false);
  });

  /** A block result carries a remediation hint, not only a reason code. */
  it('assertCurrentBranchNotProtected_OnMain_IncludesRemediationHint', () => {
    const result = assertCurrentBranchNotProtected('main');
    expect(result.blocked).toBe(true);
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/checkout|feature/i);
  });
});

/**
 * All worktrees of a repository share one stash. A stash entry can bring the work
 * of a sibling agent into the worktree under dispatch.
 */
describe('probeStashAndEmit', () => {
  it('DispatchGuard_StashObservedInWorktree_EmitsStashDetected', async () => {
    const gitExec = vi.fn().mockImplementation((args: readonly string[]) => {
      if (args[0] === 'stash' && args[1] === 'list') {
        return 'stash@{0}: WIP on feature/work: 1234567 saved\n';
      }
      return '';
    });
    const { store, calls } = makeMockEventStore();

    await probeStashAndEmit({
      store,
      streamId: 'feat-test',
      worktreePath: '/home/user/repo/.claude/worktrees/agent-abc',
      gitExec,
    });

    const stashCalls = calls.filter((c) => c.event.type === 'stash.detected');
    expect(stashCalls).toHaveLength(1);
    const data = stashCalls[0].event.data as {
      worktreePath: string;
      stashRef: string;
    };
    expect(data.worktreePath).toBe(
      '/home/user/repo/.claude/worktrees/agent-abc',
    );
    expect(data.stashRef).toBe('stash@{0}');
  });

  it('DispatchGuard_NoStashInWorktree_DoesNotEmit', async () => {
    const gitExec = vi.fn().mockReturnValue('');
    const { store, calls } = makeMockEventStore();

    await probeStashAndEmit({
      store,
      streamId: 'feat-test',
      worktreePath: '/home/user/repo',
      gitExec,
    });

    expect(calls.filter((c) => c.event.type === 'stash.detected')).toHaveLength(0);
  });
});

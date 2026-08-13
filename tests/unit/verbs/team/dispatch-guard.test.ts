// ─── Dispatch Guard Tests ────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import {
  validateBranchAncestry,
  assertMainWorktree,
  assertCurrentBranchNotProtected,
  getCurrentBranch,
  runPreflightGuards,
  probeStashAndEmit,
} from '../../../../src/verbs/team/dispatch-guard.js';
import type { AncestryResult, WorktreeAssertionResult } from '../../../../src/verbs/team/dispatch-guard.js';
import type { EventStore } from '../../../../src/events/store.js';

// ─── Event-store mock helper ────────────────────────────────────────────────

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

  it('assertCurrentBranchNotProtected_OnMain_IncludesRemediationHint', () => {
    // #1190 UX nit: blocker payloads must include actionable remediation,
    // not just a reason code. Operators should not need to grep CLAUDE.md
    // to recover from a blocked dispatch.
    const result = assertCurrentBranchNotProtected('main');
    expect(result.blocked).toBe(true);
    expect(result.hint).toBeDefined();
    expect(result.hint).toMatch(/checkout|feature/i);
  });
});

// ─── runPreflightGuards (#1261) ─────────────────────────────────────────────
//
// Emits `dispatch.preflight` once with the per-guard outcome after running
// ancestry + worktree + protectedBranch + mainWorktree. operationId is
// inherited from the active DispatchContext (B1 / #1291) via
// AsyncLocalStorage; tests here exercise the emission shape only.

describe('runPreflightGuards', () => {
  it('DispatchGuard_AncestryFail_EmitsPreflightWithPassedFalse', async () => {
    // Arrange: gitExec returns success for HEAD branch resolution and
    // throws status=1 for the ancestry probe (upstream is not an ancestor).
    const gitExec = vi.fn().mockImplementation((args: readonly string[]) => {
      if (args[0] === 'rev-parse') return 'feature/work\n';
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        const err = new Error('exit 1') as Error & { status: number };
        err.status = 1;
        throw err;
      }
      return '';
    });
    const { store, calls } = makeMockEventStore();

    // Act
    const result = await runPreflightGuards({
      store,
      streamId: 'feat-test',
      integrationBranch: 'feature/work',
      requiredUpstream: ['main'],
      gitExec,
      cwd: '/home/user/repo',
    });

    // Assert — emission shape + aggregate fail
    const preflightCalls = calls.filter((c) => c.event.type === 'dispatch.preflight');
    expect(preflightCalls).toHaveLength(1);
    const data = preflightCalls[0].event.data as {
      guards: {
        ancestry: { passed: boolean };
        worktree: { passed: boolean };
        protectedBranch: { passed: boolean };
        mainWorktree: { passed: boolean };
      };
      passed: boolean;
      durationMs: number;
    };
    expect(data.guards.ancestry.passed).toBe(false);
    expect(data.passed).toBe(false);
    expect(typeof data.durationMs).toBe('number');
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.passed).toBe(false);
  });

  it('DispatchGuard_AllGuardsPass_EmitsPreflightWithPassedTrue', async () => {
    // Arrange: gitExec consistently returns success.
    const gitExec = vi.fn().mockImplementation((args: readonly string[]) => {
      if (args[0] === 'rev-parse') return 'feature/work\n';
      return '';
    });
    const { store, calls } = makeMockEventStore();

    // Act
    const result = await runPreflightGuards({
      store,
      streamId: 'feat-test',
      integrationBranch: 'feature/work',
      requiredUpstream: ['main'],
      gitExec,
      cwd: '/home/user/repo',
    });

    // Assert
    const preflightCalls = calls.filter((c) => c.event.type === 'dispatch.preflight');
    expect(preflightCalls).toHaveLength(1);
    const data = preflightCalls[0].event.data as {
      guards: {
        ancestry: { passed: boolean };
        worktree: { passed: boolean };
        protectedBranch: { passed: boolean };
        mainWorktree: { passed: boolean };
      };
      passed: boolean;
      durationMs: number;
    };
    expect(data.guards.ancestry.passed).toBe(true);
    expect(data.guards.worktree.passed).toBe(true);
    expect(data.guards.protectedBranch.passed).toBe(true);
    expect(data.guards.mainWorktree.passed).toBe(true);
    expect(data.passed).toBe(true);
    expect(result.passed).toBe(true);
  });
});

// ─── probeStashAndEmit (#1261) ──────────────────────────────────────────────
//
// Probes `git stash list` from the worktree under dispatch. If any entry
// exists, emits a single `stash.detected` advisory event. Cross-worktree
// stash storage is shared (`feedback_subagent_stash_hazard`), so an
// existing entry indicates risk that a sibling agent's WIP will be popped
// into the current worktree.

describe('probeStashAndEmit', () => {
  it('DispatchGuard_StashObservedInWorktree_EmitsStashDetected', async () => {
    // Arrange: `git stash list --no-color` returns a non-empty listing.
    const gitExec = vi.fn().mockImplementation((args: readonly string[]) => {
      if (args[0] === 'stash' && args[1] === 'list') {
        return 'stash@{0}: WIP on feature/work: 1234567 saved\n';
      }
      return '';
    });
    const { store, calls } = makeMockEventStore();

    // Act
    await probeStashAndEmit({
      store,
      streamId: 'feat-test',
      worktreePath: '/home/user/repo/.claude/worktrees/agent-abc',
      gitExec,
    });

    // Assert
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
    // Arrange: empty stash list — no event should fire.
    const gitExec = vi.fn().mockReturnValue('');
    const { store, calls } = makeMockEventStore();

    // Act
    await probeStashAndEmit({
      store,
      streamId: 'feat-test',
      worktreePath: '/home/user/repo',
      gitExec,
    });

    // Assert
    expect(calls.filter((c) => c.event.type === 'stash.detected')).toHaveLength(0);
  });
});

import { afterEach, describe, it, expect, vi } from 'vitest';
import { accessSync, constants, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  validateBranchAncestry,
  assertMainWorktree,
  assertCurrentBranchNotProtected,
  getCurrentBranch,
  observeDispatchCheckout,
  probeStashAndEmit,
  readObservedBranch,
  validateObservedAncestry,
} from '../../../../src/verbs/team/dispatch-guard.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
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

/** The absolute real path of the fixture Git on the test process PATH. */
function fixtureGit(): string {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    try { accessSync(candidate, constants.X_OK); return realpathSync(candidate); } catch { continue; }
  }
  throw new Error('The fixture needs Git on PATH');
}

const GIT = fixtureGit();

/** The fixture Git environment: no global or system configuration and a fixed identity. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

/** Fixture Git in `cwd` through the absolute executable. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync(GIT, ['-C', cwd, ...args], { env: GIT_ENV, timeout: 30_000 })).trim();
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rmrfAsync(root);
});

/** A repository on `main` with one commit and a `feature/work` branch with one more commit, checked out. */
async function repository(): Promise<{ readonly root: string; readonly repo: string }> {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'dispatch-guard-')));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(join(repo, 'a.txt'), 'a\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'base');
  await git(repo, 'checkout', '-q', '-b', 'feature/work');
  await writeFile(join(repo, 'b.txt'), 'b\n');
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'work');
  return { root, repo };
}

/** The constrained forms read a real repository through the absolute fixture Git. */
describe('constrained dispatch reads', () => {
  /** The branch read gives the short name, or null for a detached HEAD. A path outside a checkout and a refused config are unreadable. */
  it('ReadObservedBranch_BranchDetachedAbsentAndRefused_GiveClosedOutcomes', async () => {
    const { root, repo } = await repository();
    expect(await readObservedBranch(await observeDispatchCheckout(join(repo), GIT))).toEqual({ kind: 'branch', branch: 'feature/work' });
    await git(repo, 'checkout', '-q', '--detach');
    expect(await readObservedBranch(await observeDispatchCheckout(repo, GIT))).toEqual({ kind: 'branch', branch: null });
    const outside = join(root, 'outside');
    await mkdir(outside);
    expect((await readObservedBranch(await observeDispatchCheckout(outside, GIT))).kind).toBe('unreadable');
    await git(repo, 'config', 'includeIf.gitdir:/.path', '/untrusted/config');
    expect((await readObservedBranch(await observeDispatchCheckout(repo, GIT))).kind).toBe('unreadable');
  });

  /** A decided ancestor passes, a decided non-ancestor is missing, and an unknown name, a tag name and an unusable Git path give the git-error block. */
  it('ValidateObservedAncestry_AncestorMissingAndUnreadable_GiveClosedOutcomes', async () => {
    const { root, repo } = await repository();
    await git(repo, 'tag', 'only-a-tag', 'main');
    const observation = await observeDispatchCheckout(repo, GIT);

    expect(await validateObservedAncestry(observation, 'feature/work', ['main'])).toEqual({ passed: true, checks: ['ancestry'] });
    expect(await validateObservedAncestry(observation, 'main', ['feature/work'])).toEqual({ passed: false, blocked: true, reason: 'ancestry', missing: ['feature/work'] });
    expect(await validateObservedAncestry(observation, 'feature/work', [])).toEqual({ passed: true, checks: ['ancestry'] });
    expect(await validateObservedAncestry(observation, 'feature/work', ['no-such-branch'])).toMatchObject({ passed: false, blocked: true, reason: 'git-error' });
    expect(await validateObservedAncestry(observation, 'only-a-tag', ['main'])).toMatchObject({ passed: false, blocked: true, reason: 'git-error' });
    const unusable = await observeDispatchCheckout(repo, join(root, 'no-git'));
    expect(await validateObservedAncestry(unusable, 'feature/work', ['main'])).toMatchObject({ passed: false, blocked: true, reason: 'git-error' });
  });

});

/**
 * All worktrees of a repository share one stash. So a pop of an existing entry can
 * bring the work of a sibling agent into the worktree under dispatch.
 */
describe('probeStashAndEmit', () => {
  /** A stash entry appends one `stash.detected` with the newest ref and the given path, with the same bytes as before. */
  it('DispatchGuard_StashObservedInWorktree_EmitsStashDetected', async () => {
    const { repo } = await repository();
    await writeFile(join(repo, 'a.txt'), 'changed\n');
    await git(repo, 'stash', 'push', '-q', '-m', 'saved');
    const { store, calls } = makeMockEventStore();

    await probeStashAndEmit({ store, streamId: 'feat-test', worktreePath: '/home/user/repo/.claude/worktrees/agent-abc', observation: await observeDispatchCheckout(repo, GIT) });

    expect(calls).toEqual([{
      streamId: 'feat-test',
      event: { type: 'stash.detected', data: { worktreePath: '/home/user/repo/.claude/worktrees/agent-abc', stashRef: 'stash@{0}' } },
    }]);
  });

  it('DispatchGuard_NoStashInWorktree_DoesNotEmit', async () => {
    const { repo } = await repository();
    const { store, calls } = makeMockEventStore();

    await probeStashAndEmit({ store, streamId: 'feat-test', worktreePath: repo, observation: await observeDispatchCheckout(repo, GIT) });

    expect(calls).toHaveLength(0);
  });

  /** An unreadable stash read appends no event and does not throw, so it does not fail dispatch. */
  it('DispatchGuard_UnreadableStashRead_DoesNotEmit', async () => {
    const { root, repo } = await repository();
    await writeFile(join(repo, 'a.txt'), 'changed\n');
    await git(repo, 'stash', 'push', '-q', '-m', 'saved');
    const { store, calls } = makeMockEventStore();

    await probeStashAndEmit({ store, streamId: 'feat-test', worktreePath: repo, observation: await observeDispatchCheckout(repo, join(root, 'no-git')) });
    await probeStashAndEmit({ store, streamId: 'feat-test', worktreePath: repo, observation: await observeDispatchCheckout(join(root, 'missing'), GIT) });

    expect(calls).toHaveLength(0);
  });
});


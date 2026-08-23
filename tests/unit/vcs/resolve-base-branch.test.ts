import { describe, it, expect, vi } from 'vitest';
import {
  resolveBaseBranch,
  type GitRefReader,
} from '../../../src/vcs/resolve-base-branch.js';
import { GitLabProvider } from '../../../src/vcs/gitlab.js';
import type { VcsProvider } from '../../../src/vcs/provider.js';

/** A provider whose only interesting method is `getRepository`. */
function makeProvider(getRepository: VcsProvider['getRepository']): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    addReply: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    searchIssuesByMarker: vi.fn(),
    getRepository,
  };
}

const noGit: GitRefReader = () => null;
const gitReturning = (stdout: string): GitRefReader => () => stdout;

describe('resolveBaseBranch', () => {
  it('PrefersProviderDefaultBranch', async () => {
    const provider = makeProvider(
      vi.fn().mockResolvedValue({ nameWithOwner: 'acme/widget', defaultBranch: 'trunk' }),
    );
    const runGit = vi.fn(gitReturning('refs/remotes/origin/develop\n'));

    const result = await resolveBaseBranch('/repo', provider, runGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'trunk' });
    // The host answered, so git is never consulted.
    expect(runGit).not.toHaveBeenCalled();
  });

  it('FallsBackToSymbolicRef', async () => {
    const runGit = vi.fn(gitReturning('refs/remotes/origin/develop\n'));

    const result = await resolveBaseBranch('/repo', undefined, runGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'develop' });
    expect(runGit).toHaveBeenCalledWith('/repo', ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  });

  it('Unresolved_IsTyped_NotMain', async () => {
    const result = await resolveBaseBranch('/repo', undefined, noGit);

    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).not.toContain('"branch"');
    expect(result).not.toMatchObject({ branch: 'main' });
    if (result.kind === 'unresolved') {
      expect(result.reason).toContain('/repo');
    }
  });

  it('UnsupportedProviderOperation_IsNotACrash', async () => {
    // GitLab and Azure DevOps both throw UnsupportedOperationError here.
    const provider = new GitLabProvider({});
    await expect(provider.getRepository()).rejects.toThrow('getRepository is not yet supported');

    const result = await resolveBaseBranch('/repo', provider, gitReturning('refs/remotes/origin/develop\n'));

    expect(result).toEqual({ kind: 'resolved', branch: 'develop' });
  });

  it('RefNameFailingTheSanitizer_IsNotTrusted', async () => {
    const hostile = 'main;rm -rf /';
    const provider = makeProvider(
      vi.fn().mockResolvedValue({ nameWithOwner: 'acme/widget', defaultBranch: hostile }),
    );

    // Neither source is trusted on its own, so neither can be laundered into a
    // branch. Both floors have to reject it: the resolved name is interpolated
    // into a git invocation, and on Windows that can route through a shell.
    const fromProvider = await resolveBaseBranch('/repo', provider, noGit);
    const fromGit = await resolveBaseBranch(
      '/repo',
      undefined,
      gitReturning(`refs/remotes/origin/${hostile}\n`),
    );

    expect(fromProvider.kind).toBe('unresolved');
    expect(fromGit.kind).toBe('unresolved');
    expect(JSON.stringify([fromProvider, fromGit])).not.toContain('rm -rf');
  });

  it('HostedNonAsciiBranchName_IsNotDiscarded', async () => {
    // The host's typed record of its own default branch is real by
    // construction. An ASCII allowlist would reject this name, reporting
    // `unresolved` for a repository whose default branch plainly exists.
    const provider = makeProvider(
      vi.fn().mockResolvedValue({ nameWithOwner: 'acme/widget', defaultBranch: 'feature/日本語' }),
    );

    const result = await resolveBaseBranch('/repo', provider, noGit);

    expect(result).toEqual({ kind: 'resolved', branch: 'feature/日本語' });
  });

  it('RefOutsideTheOriginPrefix_IsNotLaundered', async () => {
    // `refs/heads/main` carries only allowlisted characters, so an unanchored
    // prefix strip hands the whole ref path back as if it were a branch name.
    const result = await resolveBaseBranch('/repo', undefined, gitReturning('refs/heads/main\n'));

    expect(result.kind).toBe('unresolved');
    expect(JSON.stringify(result)).not.toContain('refs/heads/main');
  });

  it('EmptyProviderDefaultBranch_FallsThrough', async () => {
    const provider = makeProvider(
      vi.fn().mockResolvedValue({ nameWithOwner: 'acme/widget', defaultBranch: '' }),
    );

    const result = await resolveBaseBranch('/repo', provider, gitReturning('refs/remotes/origin/develop\n'));

    expect(result).toEqual({ kind: 'resolved', branch: 'develop' });
  });
});

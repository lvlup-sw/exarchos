/**
 * Spec for unsanitized pull request ids on the GitHub provider.
 *
 * A caller can put any string in a pull request id or a thread id.
 * `GitHubProvider` must refuse an id that is not a positive decimal integer before `gh` runs.
 * It must pass each positional id after `--`, with flags before that marker.
 * An API path holds only the decimal id as one segment.
 * The `create_pr` title, body, base, and head are flag values, so they are not part of this spec.
 *
 * @oracle-sources: the GitHub REST routes for issue comments, review comments and reviews, written by hand from the GitHub API documentation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubProvider } from '../../../src/vcs/github.js';

vi.mock('../../../src/vcs/shell.js', () => ({
  exec: vi.fn(),
}));

import { exec } from '../../../src/vcs/shell.js';

const mockExec = vi.mocked(exec);

/**
 * Strings a caller can put in `prId` or `threadId`. Each one is a single
 * argument, which is how `execFile` passes the value. `--admin` is a merge
 * flag. `--repo=…` is a repository flag. A pull request URL selects another
 * repository. A slash or question mark changes the `gh api` path.
 */
const MALICIOUS_IDS = [
  '--admin',
  '--repo=acme/other',
  '-R=acme/other',
  'https://github.com/acme/other/pull/1',
  'http://github.com/acme/other/pull/1',
  'acme/other#1',
  '1/../../user',
  '1?foo=1',
  '../user',
  '0',
  '-1',
  '42abc',
  '42 --admin',
] as const;

const SAFE_PR = '42';
const SAFE_THREAD = '7';

/** Flags stay before `--`, and the id is the only positional after it. */
function expectPositionalId(args: readonly string[], id: string): void {
  const end = args.indexOf('--');
  expect(end, args.join(' ')).toBeGreaterThanOrEqual(0);
  expect(args[end + 1]).toBe(id);
  expect(args.slice(end + 2)).toEqual([]);
  expect(args.slice(0, end)).not.toContain(id);
}

function apiPaths(): string[] {
  return mockExec.mock.calls
    .map((call) => call[1])
    .filter((args): args is string[] => Array.isArray(args))
    .flatMap((args) => args.filter((arg) => arg.includes('repos/')));
}

describe('GitHub pull request id injection', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GitHubProvider({});
    mockExec.mockResolvedValue('{}');
  });

  describe('GitHubProvider argument vector', () => {
    it('mergePr passes a numeric id after -- and keeps the strategy flag before it', async () => {
      mockExec
        .mockResolvedValueOnce('merged')
        .mockResolvedValueOnce(JSON.stringify({ mergeCommit: { oid: 'abc' } }));

      const result = await provider.mergePr(SAFE_PR, 'squash');

      expect(result).toEqual({ merged: true, sha: 'abc' });
      const mergeArgs = mockExec.mock.calls[0]?.[1];
      const viewArgs = mockExec.mock.calls[1]?.[1];
      expect(mergeArgs).toBeDefined();
      expect(viewArgs).toBeDefined();
      if (mergeArgs === undefined || viewArgs === undefined) return;
      expectPositionalId(mergeArgs, SAFE_PR);
      expect(mergeArgs.slice(0, mergeArgs.indexOf('--'))).toEqual(['pr', 'merge', '--squash']);
      expectPositionalId(viewArgs, SAFE_PR);
      expect(viewArgs.slice(0, viewArgs.indexOf('--'))).toContain('--json');
    });

    it.each(MALICIOUS_IDS)(
      'mergePr does not invoke gh for prId %j',
      async (prId) => {
        const outcome = await provider.mergePr(prId, 'squash').then(
          (result) => result,
          () => 'threw' as const,
        );
        expect(mockExec).not.toHaveBeenCalled();
        if (outcome !== 'threw') {
          expect(outcome.merged).toBe(false);
        }
      },
    );

    it('checkCi passes a numeric id after --', async () => {
      mockExec.mockResolvedValueOnce(JSON.stringify([]));
      await provider.checkCi(SAFE_PR);
      const args = mockExec.mock.calls[0]?.[1];
      expect(args).toBeDefined();
      if (args === undefined) return;
      expectPositionalId(args, SAFE_PR);
      expect(args.slice(0, args.indexOf('--'))).toEqual([
        'pr',
        'checks',
        '--json',
        'name,state,link',
      ]);
    });

    it.each(MALICIOUS_IDS)('checkCi does not invoke gh for prId %j', async (prId) => {
      await expect(provider.checkCi(prId)).rejects.toThrow();
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('getReviewStatus passes a numeric id after --', async () => {
      mockExec.mockResolvedValueOnce(
        JSON.stringify({ reviews: [], reviewDecision: '' }),
      );
      await provider.getReviewStatus(SAFE_PR);
      const args = mockExec.mock.calls[0]?.[1];
      expect(args).toBeDefined();
      if (args === undefined) return;
      expectPositionalId(args, SAFE_PR);
    });

    it.each(MALICIOUS_IDS)(
      'getReviewStatus does not invoke gh for prId %j',
      async (prId) => {
        await expect(provider.getReviewStatus(prId)).rejects.toThrow();
        expect(mockExec).not.toHaveBeenCalled();
      },
    );

    it('getPrDiff passes a numeric id after --', async () => {
      mockExec.mockResolvedValueOnce('diff');
      await provider.getPrDiff(SAFE_PR);
      const args = mockExec.mock.calls[0]?.[1];
      expect(args).toBeDefined();
      if (args === undefined) return;
      expectPositionalId(args, SAFE_PR);
      expect(args.slice(0, args.indexOf('--'))).toEqual(['pr', 'diff']);
    });

    it.each(MALICIOUS_IDS)('getPrDiff does not invoke gh for prId %j', async (prId) => {
      await expect(provider.getPrDiff(prId)).rejects.toThrow();
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('addComment passes a numeric id after -- and the body stays a flag value', async () => {
      mockExec.mockResolvedValueOnce('');
      await provider.addComment(SAFE_PR, '--admin');
      const args = mockExec.mock.calls[0]?.[1];
      expect(args).toBeDefined();
      if (args === undefined) return;
      expectPositionalId(args, SAFE_PR);
      const end = args.indexOf('--');
      expect(args.slice(0, end)).toEqual(['pr', 'comment', '--body', '--admin']);
    });

    it.each(MALICIOUS_IDS)('addComment does not invoke gh for prId %j', async (prId) => {
      await expect(provider.addComment(prId, 'hello')).rejects.toThrow();
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('addReply builds the reply path from numeric segments only', async () => {
      mockExec.mockResolvedValueOnce(JSON.stringify({ id: 9 }));
      const result = await provider.addReply(SAFE_PR, SAFE_THREAD, 'hello');
      expect(result).toEqual({ id: 9 });
      expect(apiPaths()).toEqual([
        'repos/{owner}/{repo}/pulls/42/comments/7/replies',
      ]);
    });

    it.each(MALICIOUS_IDS)(
      'addReply does not invoke gh for prId %j',
      async (prId) => {
        await expect(provider.addReply(prId, SAFE_THREAD, 'hello')).rejects.toThrow();
        expect(mockExec).not.toHaveBeenCalled();
      },
    );

    it.each(MALICIOUS_IDS)(
      'addReply does not invoke gh for threadId %j',
      async (threadId) => {
        await expect(provider.addReply(SAFE_PR, threadId, 'hello')).rejects.toThrow();
        expect(mockExec).not.toHaveBeenCalled();
      },
    );

    it('getPrComments requests only numeric issue, review, and diff-comment paths', async () => {
      mockExec.mockResolvedValue('[]');
      await provider.getPrComments(SAFE_PR);
      expect(apiPaths().sort()).toEqual([
        'repos/{owner}/{repo}/issues/42/comments',
        'repos/{owner}/{repo}/pulls/42/comments',
        'repos/{owner}/{repo}/pulls/42/reviews',
      ]);
    });

    it.each(MALICIOUS_IDS)(
      'getPrComments does not invoke gh for prId %j',
      async (prId) => {
        await expect(provider.getPrComments(prId)).rejects.toThrow();
        expect(mockExec).not.toHaveBeenCalled();
      },
    );
  });
});

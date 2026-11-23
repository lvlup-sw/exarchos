/**
 * Spec for unsanitized pull request ids on the GitHub provider.
 *
 * `merge_pr`, `check_ci`, `get_pr_comments`, and `add_pr_comment` declare `prId`
 * as any non-empty string. `GitHubProvider` then places that string in the `gh`
 * argument vector with no end-of-options marker, and interpolates it into `gh api`
 * paths. These tests fail until a numeric id is required and every positional id
 * is passed after `--`, with flags before that marker. API paths may contain only
 * the decimal id as one segment.
 *
 * `getPrDiff` has no orchestrate action. The provider method is covered here
 * because it shares the positional-id call. `create_pr` title, body, base, and
 * head are flag values, so a leading dash is the value of the preceding flag
 * and is not part of this spec.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../../../src/events/store.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { GitHubProvider } from '../../../src/vcs/github.js';
import { vcsActions } from '../../../src/registry/actions/orchestrate/vcs.js';
import { handleMergePr } from '../../../src/verbs/vcs/merge-pr.js';
import { handleCheckCi } from '../../../src/verbs/vcs/check-ci.js';
import { handleGetPrComments } from '../../../src/verbs/vcs/get-pr-comments.js';
import { handleAddPrComment } from '../../../src/verbs/vcs/add-pr-comment.js';

vi.mock('../../../src/vcs/shell.js', () => ({
  exec: vi.fn(),
}));

vi.mock('../../../src/vcs/factory.js', () => ({
  createVcsProvider: vi.fn(),
}));

import { exec } from '../../../src/vcs/shell.js';
import { createVcsProvider } from '../../../src/vcs/factory.js';

const mockExec = vi.mocked(exec);
const mockCreateVcsProvider = vi.mocked(createVcsProvider);

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

function ctx(): DispatchContext {
  return {
    stateDir: '/tmp/pr-id-injection',
    eventStore: {
      append: vi.fn().mockResolvedValue({ sequence: 1 }),
    } as unknown as EventStore,
    enableTelemetry: false,
  };
}

function actionSchema(name: string): { safeParse: (value: unknown) => { success: boolean } } {
  const action = vcsActions.find((entry) => entry.name === name);
  if (action === undefined) {
    throw new Error(`missing action ${name}`);
  }
  return action.schema;
}

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
    mockCreateVcsProvider.mockResolvedValue(provider);
  });

  describe('action schemas', () => {
    it.each(['merge_pr', 'check_ci', 'get_pr_comments', 'add_pr_comment'] as const)(
      '%s rejects a non-numeric prId before a handler runs',
      (name) => {
        const schema = actionSchema(name);
        expect(schema.safeParse({ prId: SAFE_PR, strategy: 'squash', body: 'note' }).success).toBe(true);
        for (const prId of MALICIOUS_IDS) {
          const parsed = schema.safeParse({ prId, strategy: 'squash', body: 'note' });
          expect(parsed.success, prId).toBe(false);
        }
      },
    );

    it('add_pr_comment rejects a non-numeric threadId', () => {
      const schema = actionSchema('add_pr_comment');
      expect(
        schema.safeParse({ prId: SAFE_PR, body: 'note', threadId: SAFE_THREAD }).success,
      ).toBe(true);
      for (const threadId of MALICIOUS_IDS) {
        const parsed = schema.safeParse({ prId: SAFE_PR, body: 'note', threadId });
        expect(parsed.success, threadId).toBe(false);
      }
    });
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

  describe('orchestrate handlers', () => {
    it.each(MALICIOUS_IDS)(
      'merge_pr refuses %j before gh runs and records no pr.merged event',
      async (prId) => {
        const dispatchCtx = ctx();
        const result = await handleMergePr({ prId, strategy: 'squash' }, dispatchCtx);
        expect(mockExec).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(dispatchCtx.eventStore.append).not.toHaveBeenCalled();
      },
    );

    it.each(MALICIOUS_IDS)('check_ci refuses %j before gh runs', async (prId) => {
      const result = await handleCheckCi({ prId }, ctx());
      expect(mockExec).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    it.each(MALICIOUS_IDS)('get_pr_comments refuses %j before gh runs', async (prId) => {
      const result = await handleGetPrComments({ prId }, ctx());
      expect(mockExec).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    it.each(MALICIOUS_IDS)(
      'add_pr_comment refuses prId %j before gh runs and writes no event',
      async (prId) => {
        const dispatchCtx = ctx();
        const result = await handleAddPrComment({ prId, body: 'hello' }, dispatchCtx);
        expect(mockExec).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(dispatchCtx.eventStore.append).not.toHaveBeenCalled();
      },
    );

    it.each(MALICIOUS_IDS)(
      'add_pr_comment refuses threadId %j before gh runs and writes no event',
      async (threadId) => {
        const dispatchCtx = ctx();
        const result = await handleAddPrComment(
          { prId: SAFE_PR, body: 'hello', threadId },
          dispatchCtx,
        );
        expect(mockExec).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(dispatchCtx.eventStore.append).not.toHaveBeenCalled();
      },
    );
  });
});

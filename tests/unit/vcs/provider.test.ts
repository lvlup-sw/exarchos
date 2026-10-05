import { describe, it, expect } from 'vitest';
import { GitLabProvider } from '../../../src/vcs/gitlab.js';
import { AzureDevOpsProvider } from '../../../src/vcs/azure-devops.js';
import {
  isResolvedKnown,
  windowPrComments,
  DEFAULT_PR_COMMENTS_LIMIT,
  computeOverallCiStatus,
  UnsupportedOperationError,
} from '../../../src/vcs/provider.js';
import type { PrComment, VcsProvider, CiCheck } from '../../../src/vcs/provider.js';

describe('VcsProvider', () => {
  /**
   * The annotation `VcsProvider` is a type-level check that the object literal has each required method.
   * `tests/tsconfig.json` excludes `tests/unit`, so no compiler runs that check. Only the `name` assertion runs.
   */
  it('VcsProvider_Interface_DefinesRequiredMethods', () => {
    const provider: VcsProvider = {
      name: 'github',
      createPr: async () => ({ url: '', number: 0 }),
      checkCi: async () => ({ status: 'pending', checks: [] }),
      mergePr: async () => ({ merged: false }),
      addComment: async () => {},
      addReply: async () => ({ id: 0 }),
      getReviewStatus: async () => ({ state: 'pending', reviewers: [] }),
      listPrs: async () => [],
      getPrComments: async () => [],
      getPrDiff: async () => '',
      createIssue: async () => ({ number: 0, url: '' }),
      searchIssuesByMarker: async () => [],
      getRepository: async () => ({ nameWithOwner: '', defaultBranch: '' }),
    };
    expect(provider.name).toBe('github');
  });

  it('GitLabProvider_Name_IsGitlab', () => {
    const provider = new GitLabProvider({});
    expect(provider.name).toBe('gitlab');
  });

  it('AzureDevOpsProvider_Name_IsAzureDevOps', () => {
    const provider = new AzureDevOpsProvider({});
    expect(provider.name).toBe('azure-devops');
  });

  /** GitLab is a partial provider. Each method that it does not support, `addReply` included, must reject with "not yet supported". */
  it('GitLabProvider_ImplementsVcsProvider', async () => {
    const provider = new GitLabProvider({});
    expect(typeof provider.createPr).toBe('function');
    expect(typeof provider.checkCi).toBe('function');
    expect(typeof provider.mergePr).toBe('function');
    expect(typeof provider.addComment).toBe('function');
    expect(typeof provider.addReply).toBe('function');
    expect(typeof provider.getReviewStatus).toBe('function');
    expect(typeof provider.listPrs).toBe('function');
    expect(typeof provider.getPrComments).toBe('function');
    expect(typeof provider.getPrDiff).toBe('function');
    expect(typeof provider.createIssue).toBe('function');
    expect(typeof provider.searchIssuesByMarker).toBe('function');
    expect(typeof provider.getRepository).toBe('function');
    await expect(provider.listPrs()).rejects.toThrow(/not yet supported/i);
    await expect(provider.getPrDiff('1')).rejects.toThrow(/not yet supported/i);
    await expect(provider.createIssue({ title: 't', body: 'b' })).rejects.toThrow(/not yet supported/i);
    await expect(provider.searchIssuesByMarker('op-1')).rejects.toThrow(/not yet supported/i);
    await expect(provider.getRepository()).rejects.toThrow(/not yet supported/i);
    await expect(provider.addReply('1', '2', 'reply')).rejects.toThrow(/not yet supported/i);
  });

  /** Azure DevOps is a partial provider. Each method that it does not support, `addReply` included, must reject with "not yet supported". */
  it('AzureDevOpsProvider_ImplementsVcsProvider', async () => {
    const provider = new AzureDevOpsProvider({});
    expect(typeof provider.createPr).toBe('function');
    expect(typeof provider.checkCi).toBe('function');
    expect(typeof provider.mergePr).toBe('function');
    expect(typeof provider.addComment).toBe('function');
    expect(typeof provider.addReply).toBe('function');
    expect(typeof provider.getReviewStatus).toBe('function');
    expect(typeof provider.listPrs).toBe('function');
    expect(typeof provider.getPrComments).toBe('function');
    expect(typeof provider.getPrDiff).toBe('function');
    expect(typeof provider.createIssue).toBe('function');
    expect(typeof provider.searchIssuesByMarker).toBe('function');
    expect(typeof provider.getRepository).toBe('function');
    await expect(provider.listPrs()).rejects.toThrow(/not yet supported/i);
    await expect(provider.getPrDiff('1')).rejects.toThrow(/not yet supported/i);
    await expect(provider.createIssue({ title: 't', body: 'b' })).rejects.toThrow(/not yet supported/i);
    await expect(provider.searchIssuesByMarker('op-1')).rejects.toThrow(/not yet supported/i);
    await expect(provider.getRepository()).rejects.toThrow(/not yet supported/i);
    await expect(provider.addReply('1', '2', 'reply')).rejects.toThrow(/not yet supported/i);
  });

  /** Each field of the `PrComment` contract is assignable and readable. Only a `review-summary` comment carries `state`. */
  it('PrComment_Shape_CarriesSourceAuthorThreadResolved', () => {
    const comment: PrComment = {
      id: 42,
      author: 'octocat',
      body: 'please address this',
      createdAt: '2026-06-22T00:00:00Z',
      source: 'review-inline',
      path: 'src/foo.ts',
      line: 17,
      parentId: 7,
      resolved: true,
    };
    expect(comment.id).toBe(42);
    expect(comment.author).toBe('octocat');
    expect(comment.body).toBe('please address this');
    expect(comment.createdAt).toBe('2026-06-22T00:00:00Z');
    expect(comment.source).toBe('review-inline');
    expect(comment.path).toBe('src/foo.ts');
    expect(comment.line).toBe(17);
    expect(comment.parentId).toBe(7);
    expect(comment.resolved).toBe(true);

    const summary: PrComment = {
      id: 1,
      author: 'reviewer',
      body: '',
      createdAt: '2026-06-22T00:00:00Z',
      source: 'review-summary',
      state: 'CHANGES_REQUESTED',
    };
    expect(summary.source).toBe('review-summary');
    expect(summary.state).toBe('CHANGES_REQUESTED');
  });

  /** An absent `resolved` means unknown. `isResolvedKnown` must tell it apart from an explicit `false`. */
  it('PrComment_Resolved_AbsentIsUnknownNotFalse', () => {
    const explicit: PrComment = {
      id: 1,
      author: 'a',
      body: 'b',
      createdAt: '2026-06-22T00:00:00Z',
      source: 'issue-comment',
      resolved: false,
    };
    const unknown: PrComment = {
      id: 2,
      author: 'a',
      body: 'b',
      createdAt: '2026-06-22T00:00:00Z',
      source: 'issue-comment',
    };

    expect(explicit.resolved).toBe(false);
    expect(unknown.resolved).toBeUndefined();
    expect(unknown.resolved).not.toBe(false);

    expect(isResolvedKnown(explicit)).toBe(true);
    expect(isResolvedKnown(unknown)).toBe(false);
  });
});

describe('windowPrComments', () => {
  function makeComments(n: number): PrComment[] {
    const base = Date.parse('2026-04-15T10:00:00.000Z');
    return Array.from({ length: n }, (_, i) => ({
      id: 1000 + i,
      author: `a${i}`,
      body: `body ${i}`,
      createdAt: new Date(base + i * 60_000).toISOString(),
      source: 'issue-comment' as const,
    }));
  }

  it('windowPrComments_NoOpts_DefaultsToNewestLimit', () => {
    const result = windowPrComments(makeComments(50));

    expect(result.comments).toHaveLength(DEFAULT_PR_COMMENTS_LIMIT);
    expect(result.page).toEqual({
      total: 50,
      offset: 0,
      limit: DEFAULT_PR_COMMENTS_LIMIT,
      hasMore: true,
    });
    expect(result.comments[0]?.id).toBe(1049);
  });

  /** A limit of 0 becomes the default, and a negative offset becomes 0. */
  it('windowPrComments_InvalidLimitOrOffset_Coerces', () => {
    const result = windowPrComments(makeComments(30), { limit: 0, offset: -5 });

    expect(result.page.limit).toBe(DEFAULT_PR_COMMENTS_LIMIT);
    expect(result.page.offset).toBe(0);
  });

  /** A limit in (0, 1) floors to 0, and a zero-sized page reports `hasMore: true` forever. The helper must use the default limit. */
  it('windowPrComments_FractionalLimit_DoesNotFloorToZeroPage', () => {
    const result = windowPrComments(makeComments(30), { limit: 0.5 });

    expect(result.page.limit).toBe(DEFAULT_PR_COMMENTS_LIMIT);
    expect(result.comments.length).toBeGreaterThan(0);
  });

  it('windowPrComments_OffsetBeyondTotal_EmptyNoMore', () => {
    const result = windowPrComments(makeComments(10), { limit: 5, offset: 100 });

    expect(result.comments).toEqual([]);
    expect(result.page).toEqual({ total: 10, offset: 100, limit: 5, hasMore: false });
    expect(result.notice).toBeUndefined();
  });

  it('windowPrComments_EmptyFields_ReturnsFullComments', () => {
    const result = windowPrComments(makeComments(3), { fields: [] });

    expect(result.comments[0]).toHaveProperty('body');
    expect(result.comments[0]).toHaveProperty('source');
  });

  /** An `issue-comment` has no `path`, so the projection does not add that key. */
  it('windowPrComments_ProjectsOnlyPresentKeys', () => {
    const result = windowPrComments(makeComments(1), { fields: ['id', 'path'] });

    expect(Object.keys(result.comments[0] ?? {})).toEqual(['id']);
  });
});

/**
 * The GitHub, GitLab and Azure DevOps providers share `computeOverallCiStatus`.
 * These tests pin the fold directly. The `checkCi` tests of each provider cover it through the pipeline decode.
 */
describe('computeOverallCiStatus (shared CI-status fold, DR-10)', () => {
  /**
   * An empty list gives `pass`.
   * GitLab with no pipeline and Azure DevOps with no runs do not reach the fold, because `checkCi` returns `pending` first.
   */
  it('ComputeOverallCiStatus_EmptyChecks_Passes', () => {
    expect(computeOverallCiStatus([])).toBe('pass');
  });

  it('ComputeOverallCiStatus_AnyFail_FailsFast', () => {
    const checks: readonly CiCheck[] = [
      { name: 'unit', status: 'pass' },
      { name: 'lint', status: 'fail' },
      { name: 'build', status: 'pending' },
    ];
    expect(computeOverallCiStatus(checks)).toBe('fail');
  });

  it('ComputeOverallCiStatus_PendingWithoutFail_IsPending', () => {
    const checks: readonly CiCheck[] = [
      { name: 'unit', status: 'pass' },
      { name: 'build', status: 'pending' },
      { name: 'optional', status: 'skipped' },
    ];
    expect(computeOverallCiStatus(checks)).toBe('pending');
  });

  it('ComputeOverallCiStatus_AllPassOrSkipped_Passes', () => {
    const checks: readonly CiCheck[] = [
      { name: 'unit', status: 'pass' },
      { name: 'optional', status: 'skipped' },
    ];
    expect(computeOverallCiStatus(checks)).toBe('pass');
  });

  /** The `pending` check comes first in the list, and `fail` still wins. */
  it('ComputeOverallCiStatus_FailPrecedesPending', () => {
    expect(
      computeOverallCiStatus([
        { name: 'build', status: 'pending' },
        { name: 'lint', status: 'fail' },
      ]),
    ).toBe('fail');
  });
});

/**
 * GitLab and Azure DevOps are partial providers: some methods throw `UnsupportedOperationError` by design.
 * The shared CI-status helper only folds a check list, so it must not catch or change those errors.
 */
describe('partial-provider by-design throws (DR-10 extraction preservation)', () => {
  it('ComputeOverallCiStatus_GitLabPartialProvider_StillThrows', async () => {
    const provider = new GitLabProvider({});
    await expect(provider.addReply('1', '2', 'body')).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(provider.listPrs()).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(provider.getPrDiff('1')).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(
      provider.createIssue({ title: 't', body: 'b' }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(provider.searchIssuesByMarker('op')).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(provider.getRepository()).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });

  it('ComputeOverallCiStatus_AzureDevOpsPartialProvider_StillThrows', async () => {
    const provider = new AzureDevOpsProvider({});
    await expect(provider.addReply('1', '2', 'body')).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(provider.listPrs()).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(provider.getPrDiff('1')).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(
      provider.createIssue({ title: 't', body: 'b' }),
    ).rejects.toBeInstanceOf(UnsupportedOperationError);
    await expect(provider.searchIssuesByMarker('op')).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
    await expect(provider.getRepository()).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });
});

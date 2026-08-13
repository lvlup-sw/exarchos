import { describe, it, expect } from 'vitest';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import {
  isResolvedKnown,
  windowPrComments,
  DEFAULT_PR_COMMENTS_LIMIT,
  computeOverallCiStatus,
  UnsupportedOperationError,
} from './provider.js';
import type { PrComment, VcsProvider, CiCheck } from './provider.js';

describe('VcsProvider', () => {
  it('VcsProvider_Interface_DefinesRequiredMethods', () => {
    // Type-level test: verify interface is implementable
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

  it('GitLabProvider_ImplementsVcsProvider', async () => {
    const provider = new GitLabProvider({});
    // Verify all VcsProvider methods exist on the implementation
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
    // Methods not yet implemented should throw
    await expect(provider.listPrs()).rejects.toThrow(/not yet supported/i);
    await expect(provider.getPrDiff('1')).rejects.toThrow(/not yet supported/i);
    await expect(provider.createIssue({ title: 't', body: 'b' })).rejects.toThrow(/not yet supported/i);
    await expect(provider.searchIssuesByMarker('op-1')).rejects.toThrow(/not yet supported/i);
    await expect(provider.getRepository()).rejects.toThrow(/not yet supported/i);
    // addReply is a thread-aware sibling of addComment; GitLab support is a
    // DR-7 follow-up (#1612), so it must throw a clear capability signal.
    await expect(provider.addReply('1', '2', 'reply')).rejects.toThrow(/not yet supported/i);
  });

  it('AzureDevOpsProvider_ImplementsVcsProvider', async () => {
    const provider = new AzureDevOpsProvider({});
    // Verify all VcsProvider methods exist on the implementation
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
    // Methods not yet implemented should throw
    await expect(provider.listPrs()).rejects.toThrow(/not yet supported/i);
    await expect(provider.getPrDiff('1')).rejects.toThrow(/not yet supported/i);
    await expect(provider.createIssue({ title: 't', body: 'b' })).rejects.toThrow(/not yet supported/i);
    await expect(provider.searchIssuesByMarker('op-1')).rejects.toThrow(/not yet supported/i);
    await expect(provider.getRepository()).rejects.toThrow(/not yet supported/i);
    // addReply is a thread-aware sibling of addComment; Azure DevOps support is
    // a DR-7 follow-up (#1613), so it must throw a clear capability signal.
    await expect(provider.addReply('1', '2', 'reply')).rejects.toThrow(/not yet supported/i);
  });

  it('PrComment_Shape_CarriesSourceAuthorThreadResolved', () => {
    // Exercise every field of the widened, platform-neutral contract and
    // assert each round-trips / is accessible.
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

    // `state` rides only on review-summary sources.
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

  it('PrComment_Resolved_AbsentIsUnknownNotFalse', () => {
    // Tri-state pin: absent `resolved` must stay distinguishable from an
    // explicit `false`, so a consumer can never silently coerce absent → false.
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

    // The two are distinguishable at the value level.
    expect(explicit.resolved).toBe(false);
    expect(unknown.resolved).toBeUndefined();
    expect(unknown.resolved).not.toBe(false);

    // The exposed helper treats absent as "unknown", not as resolved/false.
    expect(isResolvedKnown(explicit)).toBe(true);
    expect(isResolvedKnown(unknown)).toBe(false);
  });
});

// ─── DR-3: windowPrComments (shared window/projection helper) ─────────────────

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
    // Newest-first ordering.
    expect(result.comments[0]?.id).toBe(1049);
  });

  it('windowPrComments_InvalidLimitOrOffset_Coerces', () => {
    // Non-positive / non-finite limit → default; negative offset → 0.
    const result = windowPrComments(makeComments(30), { limit: 0, offset: -5 });

    expect(result.page.limit).toBe(DEFAULT_PR_COMMENTS_LIMIT);
    expect(result.page.offset).toBe(0);
  });

  it('windowPrComments_FractionalLimit_DoesNotFloorToZeroPage', () => {
    // A limit in (0, 1) floors to 0; a zero-sized page would report
    // hasMore:true forever. Must fall back to the default, not emit a 0 page.
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
    // An empty projection list is treated as "no projection".
    const result = windowPrComments(makeComments(3), { fields: [] });

    expect(result.comments[0]).toHaveProperty('body');
    expect(result.comments[0]).toHaveProperty('source');
  });

  it('windowPrComments_ProjectsOnlyPresentKeys', () => {
    // `path` is absent on issue-comments, so it is not fabricated in the
    // projection — only present-and-defined keys survive.
    const result = windowPrComments(makeComments(1), { fields: ['id', 'path'] });

    expect(Object.keys(result.comments[0] ?? {})).toEqual(['id']);
  });
});

// ─── DR-10: shared computeOverallCiStatus helper ────────────────────────────
//
// The three VCS providers (GitHub / GitLab / Azure DevOps) previously carried
// byte-identical private `computeOverallCiStatus` copies; DR-10 collapses them
// into this one exported helper. These tests pin the aggregation contract
// directly (the per-provider `checkCi` tests in the sibling suites continue to
// exercise it through each provider's real pipeline-decode path).
describe('computeOverallCiStatus (shared CI-status fold, DR-10)', () => {
  it('ComputeOverallCiStatus_EmptyChecks_Passes', () => {
    // No checks is a pass — the empty conjunction. Matches every provider's
    // "no pipeline / no jobs" path collapsing to a non-blocking verdict.
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

  it('ComputeOverallCiStatus_FailPrecedesPending', () => {
    // fail wins over pending regardless of ordering — the fail scan runs first.
    expect(
      computeOverallCiStatus([
        { name: 'build', status: 'pending' },
        { name: 'lint', status: 'fail' },
      ]),
    ).toBe('fail');
  });
});

// ─── DR-10: partial-provider by-design throws survive the extraction ─────────
//
// GitLab and Azure DevOps are PARTIAL VcsProviders — several methods throw
// `UnsupportedOperationError` by design (DR-7 follow-ups #1612 / #1613). The
// shared CI-status helper only folds a check list a `checkCi` already built,
// so extracting it must leave those by-design throws untouched. These tests
// assert the throws are intact per provider so a helper that swallowed or
// normalized them (a behavior change) would go red.
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

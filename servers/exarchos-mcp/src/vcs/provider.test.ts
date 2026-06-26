import { describe, it, expect } from 'vitest';
import { GitLabProvider } from './gitlab.js';
import { AzureDevOpsProvider } from './azure-devops.js';
import { isResolvedKnown } from './provider.js';
import type { PrComment, VcsProvider } from './provider.js';

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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzureDevOpsProvider } from '../../../src/vcs/azure-devops.js';
import { isResolvedKnown } from '../../../src/vcs/provider.js';

// `az repos pr show` resolves the route params (repositoryId + project) the
// `az devops invoke pullRequestThreads` call needs. Shared across getPrComments
// tests; the second mocked exec is the thread-list invoke.
const PR_SHOW_RESPONSE = JSON.stringify({
  repository: {
    id: 'repo-guid',
    project: { id: 'proj-guid', name: 'MyProject' },
  },
});

// Mock the shell execution helper
vi.mock('../../../src/vcs/shell.js', () => ({
  exec: vi.fn(),
}));

import { exec } from '../../../src/vcs/shell.js';
const mockExec = vi.mocked(exec);

describe('AzureDevOpsProvider', () => {
  let provider: AzureDevOpsProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new AzureDevOpsProvider({});
  });

  it('AzureDevOpsProvider_Name_IsAzureDevOps', () => {
    expect(provider.name).toBe('azure-devops');
  });

  // ── createPr ────────────────────────────────────────────────────────────

  it('AzureDevOpsProvider_CreatePr_CallsAzWithCorrectArgs', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        repository: { webUrl: 'https://dev.azure.com/org/project/_git/repo' },
        pullRequestId: 100,
      })
    );

    const result = await provider.createPr({
      title: 'feat: azure test',
      body: 'Test PR',
      baseBranch: 'main',
      headBranch: 'feat/test',
    });

    expect(mockExec).toHaveBeenCalledWith('az', [
      'repos',
      'pr',
      'create',
      '--title',
      'feat: azure test',
      '--description',
      'Test PR',
      '--source-branch',
      'feat/test',
      '--target-branch',
      'main',
      '--output',
      'json',
    ]);
    expect(result.url).toBe(
      'https://dev.azure.com/org/project/_git/repo/pullrequest/100'
    );
    expect(result.number).toBe(100);
  });

  it('AzureDevOpsProvider_CreatePr_IncludesDraftFlag', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        repository: { webUrl: 'https://dev.azure.com/org/project/_git/repo' },
        pullRequestId: 101,
      })
    );

    await provider.createPr({
      title: 'draft pr',
      body: 'WIP',
      baseBranch: 'main',
      headBranch: 'feat/wip',
      draft: true,
    });

    expect(mockExec).toHaveBeenCalledWith(
      'az',
      expect.arrayContaining(['--draft', 'true'])
    );
  });

  it('AzureDevOpsProvider_CreatePr_IncludesLabels', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        repository: { webUrl: 'https://dev.azure.com/org/project/_git/repo' },
        pullRequestId: 102,
      })
    );

    await provider.createPr({
      title: 'labeled pr',
      body: 'with labels',
      baseBranch: 'main',
      headBranch: 'feat/labels',
      labels: ['bug', 'priority'],
    });

    expect(mockExec).toHaveBeenCalledWith(
      'az',
      expect.arrayContaining(['--labels', 'bug priority'])
    );
  });

  it('AzureDevOps_CreatePr_UsesOutputJsonNotWriteJsonFlag', async () => {
    // #1622: `az repos pr create` gets JSON via the GLOBAL `--output json`
    // flag — that is valid. The broken pattern (a bare `--json` write flag on
    // a create/write command) must NOT appear. Lock the create argv.
    mockExec.mockResolvedValue(
      JSON.stringify({
        repository: { webUrl: 'https://dev.azure.com/org/project/_git/repo' },
        pullRequestId: 200,
      })
    );

    await provider.createPr({
      title: 'verify output json',
      body: 'body',
      baseBranch: 'main',
      headBranch: 'feat/x',
    });

    const [cmd, argv] = mockExec.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('az');
    const outputIdx = argv.indexOf('--output');
    expect(outputIdx).toBeGreaterThanOrEqual(0);
    expect(argv[outputIdx + 1]).toBe('json');
    // No bare `--json` write flag anywhere in the create invocation.
    expect(argv).not.toContain('--json');
  });

  it('AzureDevOpsProvider_CreatePr_PropagatesExecError', async () => {
    mockExec.mockRejectedValue(new Error('az not found'));

    await expect(
      provider.createPr({
        title: 'will fail',
        body: 'error',
        baseBranch: 'main',
        headBranch: 'feat/error',
      })
    ).rejects.toThrow('az not found');
  });

  // ── checkCi ─────────────────────────────────────────────────────────────

  it('AzureDevOpsProvider_CheckCi_ParsesPipelineRuns', async () => {
    // First call: get PR details for source branch
    mockExec
      .mockResolvedValueOnce(
        JSON.stringify({ sourceRefName: 'refs/heads/feat/test' })
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            name: 'Build',
            result: 'succeeded',
            status: 'completed',
            _links: { web: { href: 'https://dev.azure.com/ci/1' } },
          },
          {
            name: 'Test',
            result: 'failed',
            status: 'completed',
            _links: { web: { href: 'https://dev.azure.com/ci/2' } },
          },
        ])
      );

    const result = await provider.checkCi('100');

    expect(mockExec).toHaveBeenNthCalledWith(1, 'az', [
      'repos',
      'pr',
      'show',
      '--id',
      '100',
      '--output',
      'json',
    ]);
    expect(mockExec).toHaveBeenNthCalledWith(2, 'az', [
      'pipelines',
      'runs',
      'list',
      '--branch',
      'feat/test',
      '--output',
      'json',
    ]);
    expect(result.status).toBe('fail');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]).toEqual({
      name: 'Build',
      status: 'pass',
      url: 'https://dev.azure.com/ci/1',
    });
    expect(result.checks[1]).toEqual({
      name: 'Test',
      status: 'fail',
      url: 'https://dev.azure.com/ci/2',
    });
  });

  it('AzureDevOpsProvider_CheckCi_AllPassing', async () => {
    mockExec
      .mockResolvedValueOnce(
        JSON.stringify({ sourceRefName: 'refs/heads/feat/test' })
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            name: 'Build',
            result: 'succeeded',
            status: 'completed',
            _links: { web: { href: 'https://dev.azure.com/ci/1' } },
          },
        ])
      );

    const result = await provider.checkCi('100');
    expect(result.status).toBe('pass');
  });

  it('AzureDevOpsProvider_CheckCi_PendingRuns', async () => {
    mockExec
      .mockResolvedValueOnce(
        JSON.stringify({ sourceRefName: 'refs/heads/feat/test' })
      )
      .mockResolvedValueOnce(
        JSON.stringify([
          {
            name: 'Build',
            result: null,
            status: 'inProgress',
            _links: { web: { href: 'https://dev.azure.com/ci/1' } },
          },
        ])
      );

    const result = await provider.checkCi('100');
    expect(result.status).toBe('pending');
    expect(result.checks[0].status).toBe('pending');
  });

  it('AzureDevOpsProvider_CheckCi_NoRuns', async () => {
    mockExec
      .mockResolvedValueOnce(
        JSON.stringify({ sourceRefName: 'refs/heads/feat/test' })
      )
      .mockResolvedValueOnce(JSON.stringify([]));

    const result = await provider.checkCi('100');
    expect(result.status).toBe('pending');
    expect(result.checks).toHaveLength(0);
  });

  it('AzureDevOpsProvider_CheckCi_PropagatesExecError', async () => {
    mockExec.mockRejectedValue(new Error('az pipelines error'));

    await expect(provider.checkCi('100')).rejects.toThrow('az pipelines error');
  });

  // ── mergePr ─────────────────────────────────────────────────────────────

  it('AzureDevOpsProvider_MergePr_SquashStrategy', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        status: 'completed',
        lastMergeCommit: { commitId: 'abc123' },
      })
    );

    const result = await provider.mergePr('100', 'squash');

    expect(mockExec).toHaveBeenCalledWith('az', [
      'repos',
      'pr',
      'update',
      '--id',
      '100',
      '--auto-complete',
      'true',
      '--squash',
      'true',
      '--merge-strategy',
      'squash',
      '--output',
      'json',
    ]);
    expect(result.merged).toBe(true);
    expect(result.sha).toBe('abc123');
  });

  it('AzureDevOpsProvider_MergePr_RebaseStrategy', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        status: 'completed',
        lastMergeCommit: { commitId: 'def456' },
      })
    );

    const result = await provider.mergePr('100', 'rebase');

    expect(mockExec).toHaveBeenCalledWith('az', [
      'repos',
      'pr',
      'update',
      '--id',
      '100',
      '--auto-complete',
      'true',
      '--squash',
      'false',
      '--merge-strategy',
      'rebase',
      '--output',
      'json',
    ]);
    expect(result.merged).toBe(true);
  });

  it('AzureDevOpsProvider_MergePr_MergeStrategy', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        status: 'completed',
        lastMergeCommit: { commitId: 'ghi789' },
      })
    );

    const result = await provider.mergePr('100', 'merge');

    expect(mockExec).toHaveBeenCalledWith('az', [
      'repos',
      'pr',
      'update',
      '--id',
      '100',
      '--auto-complete',
      'true',
      '--squash',
      'false',
      '--merge-strategy',
      'noFastForward',
      '--output',
      'json',
    ]);
    expect(result.merged).toBe(true);
  });

  it('AzureDevOpsProvider_MergePr_HandlesFailure', async () => {
    mockExec.mockRejectedValue(new Error('merge policy violation'));

    const result = await provider.mergePr('100', 'squash');
    expect(result.merged).toBe(false);
    expect(result.error).toBe('merge policy violation');
  });

  it('AzureDevOpsProvider_MergePr_NoMergeCommit', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        status: 'completed',
      })
    );

    const result = await provider.mergePr('100', 'squash');
    expect(result.merged).toBe(true);
    expect(result.sha).toBeUndefined();
  });

  // ── addComment ──────────────────────────────────────────────────────────

  it('AzureDevOpsProvider_AddComment_CallsAzReposPrCommentCreate', async () => {
    mockExec.mockResolvedValue(JSON.stringify({ id: 1 }));

    await provider.addComment('100', 'LGTM');

    expect(mockExec).toHaveBeenCalledWith('az', [
      'repos',
      'pr',
      'comment',
      'create',
      '--id',
      '100',
      '--text',
      'LGTM',
      '--output',
      'json',
    ]);
  });

  // ── getReviewStatus ─────────────────────────────────────────────────────

  it('AzureDevOpsProvider_GetReviewStatus_ParsesApproved', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { uniqueName: 'reviewer1@org.com', vote: 10, displayName: 'Reviewer One' },
      ])
    );

    const result = await provider.getReviewStatus('100');

    expect(mockExec).toHaveBeenCalledWith('az', [
      'repos',
      'pr',
      'reviewer',
      'list',
      '--id',
      '100',
      '--output',
      'json',
    ]);
    expect(result.state).toBe('approved');
    expect(result.reviewers).toHaveLength(1);
    expect(result.reviewers[0].login).toBe('reviewer1@org.com');
    expect(result.reviewers[0].state).toBe('approved');
  });

  it('AzureDevOpsProvider_GetReviewStatus_ParsesRejected', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { uniqueName: 'reviewer1@org.com', vote: -10, displayName: 'Reviewer One' },
      ])
    );

    const result = await provider.getReviewStatus('100');
    expect(result.state).toBe('changes_requested');
    expect(result.reviewers[0].state).toBe('changes_requested');
  });

  it('AzureDevOpsProvider_GetReviewStatus_ParsesWaitingForAuthor', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { uniqueName: 'reviewer1@org.com', vote: -5, displayName: 'Reviewer One' },
      ])
    );

    const result = await provider.getReviewStatus('100');
    expect(result.state).toBe('changes_requested');
    expect(result.reviewers[0].state).toBe('changes_requested');
  });

  it('AzureDevOpsProvider_GetReviewStatus_ParsesPending', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { uniqueName: 'reviewer1@org.com', vote: 0, displayName: 'Reviewer One' },
        { uniqueName: 'reviewer2@org.com', vote: 0, displayName: 'Reviewer Two' },
      ])
    );

    const result = await provider.getReviewStatus('100');
    expect(result.state).toBe('pending');
    expect(result.reviewers).toHaveLength(2);
    expect(result.reviewers[0].state).toBe('pending');
  });

  it('AzureDevOpsProvider_GetReviewStatus_MixedVotes', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { uniqueName: 'reviewer1@org.com', vote: 10, displayName: 'Reviewer One' },
        { uniqueName: 'reviewer2@org.com', vote: 0, displayName: 'Reviewer Two' },
      ])
    );

    const result = await provider.getReviewStatus('100');
    expect(result.state).toBe('pending');
    expect(result.reviewers[0].state).toBe('approved');
    expect(result.reviewers[1].state).toBe('pending');
  });

  it('AzureDevOpsProvider_GetReviewStatus_NoReviewers', async () => {
    mockExec.mockResolvedValue(JSON.stringify([]));

    const result = await provider.getReviewStatus('100');
    expect(result.state).toBe('pending');
    expect(result.reviewers).toHaveLength(0);
  });

  it('AzureDevOpsProvider_GetReviewStatus_ApprovedWithSuggestions', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { uniqueName: 'reviewer1@org.com', vote: 5, displayName: 'Reviewer One' },
      ])
    );

    const result = await provider.getReviewStatus('100');
    // vote=5 is "approved with suggestions" — maps to approved
    expect(result.state).toBe('approved');
    expect(result.reviewers[0].state).toBe('approved');
  });

  // ── getPrComments (#1613 — two-source PrComment harvesting) ───────────────
  // ADO has no `az repos pr` thread-list subcommand. getPrComments resolves the
  // repositoryId + project via `az repos pr show`, then lists threads via
  // `az devops invoke --area git --resource pullRequestThreads`, normalizing to
  // PrComment. ADO has only two sources: review-inline (threadContext present)
  // and issue-comment (no threadContext) — no review-summary.

  it('AzureDevOps_GetPrComments_AggregatesThreads', async () => {
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: [
            {
              id: 1,
              status: 'active',
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'PR-level discussion',
                  commentType: 'text',
                  author: { uniqueName: 'alice@org.com', displayName: 'Alice' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
              ],
            },
            {
              id: 2,
              status: 'fixed',
              threadContext: {
                filePath: '/src/foo.ts',
                rightFileStart: { line: 42 },
              },
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'inline nit',
                  commentType: 'text',
                  author: { uniqueName: 'bob@org.com', displayName: 'Bob' },
                  publishedDate: '2026-06-02T00:00:00Z',
                },
              ],
            },
          ],
        })
      );

    const result = await provider.getPrComments('100');

    // 1) resolve route params, 2) invoke pullRequestThreads with them.
    expect(mockExec).toHaveBeenNthCalledWith(1, 'az', [
      'repos',
      'pr',
      'show',
      '--id',
      '100',
      '--output',
      'json',
    ]);
    expect(mockExec).toHaveBeenNthCalledWith(2, 'az', [
      'devops',
      'invoke',
      '--area',
      'git',
      '--resource',
      'pullRequestThreads',
      '--route-parameters',
      'project=MyProject',
      'repositoryId=repo-guid',
      'pullRequestId=100',
      '--api-version',
      '7.1',
      '--output',
      'json',
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      source: 'issue-comment',
      body: 'PR-level discussion',
      author: 'alice@org.com',
      createdAt: '2026-06-01T00:00:00Z',
    });
    expect(result[1]).toMatchObject({
      source: 'review-inline',
      body: 'inline nit',
      author: 'bob@org.com',
    });
  });

  it('AzureDevOps_GetPrComments_ClassifiesThreadContextAsReviewInlineWithPathLine', async () => {
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: [
            {
              id: 7,
              status: 'active',
              threadContext: {
                filePath: '/src/bar.ts',
                rightFileStart: { line: 13 },
              },
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'fix this',
                  commentType: 'text',
                  author: { uniqueName: 'c@org.com' },
                  publishedDate: '2026-06-03T00:00:00Z',
                },
              ],
            },
          ],
        })
      );

    const result = await provider.getPrComments('100');
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('review-inline');
    expect(result[0].path).toBe('/src/bar.ts');
    expect(result[0].line).toBe(13);
  });

  it('AzureDevOps_GetPrComments_ComposesPrUniqueIdsAcrossThreads', async () => {
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: [
            {
              id: 3,
              status: 'active',
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'a',
                  commentType: 'text',
                  author: { uniqueName: 'x@org.com' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
              ],
            },
            {
              id: 4,
              status: 'active',
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'b',
                  commentType: 'text',
                  author: { uniqueName: 'y@org.com' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
              ],
            },
          ],
        })
      );

    const result = await provider.getPrComments('100');
    expect(result).toHaveLength(2);
    // Raw comment.id=1 collides across threads; composed ids must not.
    expect(result[0].id).toBe(3 * 100000 + 1);
    expect(result[1].id).toBe(4 * 100000 + 1);
    expect(result[0].id).not.toBe(result[1].id);
  });

  it('AzureDevOps_GetPrComments_ExcludesSystemThreads', async () => {
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: [
            {
              id: 5,
              status: 'closed',
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'Bob voted -5',
                  commentType: 'system',
                  author: { uniqueName: 'system' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
              ],
            },
            {
              id: 6,
              status: 'active',
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'real feedback',
                  commentType: 'text',
                  author: { uniqueName: 'r@org.com' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
              ],
            },
          ],
        })
      );

    const result = await provider.getPrComments('100');
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe('real feedback');
  });

  it('AzureDevOps_GetPrComments_MapsDecidedStatusesToResolvedTrue', async () => {
    const decided = ['fixed', 'closed', 'wontFix', 'byDesign'];
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: decided.map((status, i) => ({
            id: 10 + i,
            status,
            threadContext: null,
            comments: [
              {
                id: 1,
                parentCommentId: 0,
                content: status,
                commentType: 'text',
                author: { uniqueName: 'a@org.com' },
                publishedDate: '2026-06-01T00:00:00Z',
              },
            ],
          })),
        })
      );

    const result = await provider.getPrComments('100');
    expect(result).toHaveLength(4);
    for (const c of result) {
      expect(c.resolved).toBe(true);
    }
  });

  it('AzureDevOps_GetPrComments_MapsOpenStatusesToResolvedFalse', async () => {
    const open = ['active', 'pending'];
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: open.map((status, i) => ({
            id: 20 + i,
            status,
            threadContext: null,
            comments: [
              {
                id: 1,
                parentCommentId: 0,
                content: status,
                commentType: 'text',
                author: { uniqueName: 'a@org.com' },
                publishedDate: '2026-06-01T00:00:00Z',
              },
            ],
          })),
        })
      );

    const result = await provider.getPrComments('100');
    expect(result).toHaveLength(2);
    for (const c of result) {
      expect(c.resolved).toBe(false);
    }
  });

  it('AzureDevOps_GetPrComments_ThreadsRepliesByParentId', async () => {
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: [
            {
              id: 8,
              status: 'active',
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'top-level',
                  commentType: 'text',
                  author: { uniqueName: 'a@org.com' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
                {
                  id: 2,
                  parentCommentId: 1,
                  content: 'reply',
                  commentType: 'text',
                  author: { uniqueName: 'b@org.com' },
                  publishedDate: '2026-06-01T01:00:00Z',
                },
              ],
            },
          ],
        })
      );

    const result = await provider.getPrComments('100');
    expect(result).toHaveLength(2);
    const [top, reply] = result;
    // Top-level comment has no parent.
    expect(top.parentId).toBeUndefined();
    // Reply's parentId is the composed id of the top-level comment.
    expect(reply.parentId).toBe(8 * 100000 + 1);
    expect(reply.parentId).toBe(top.id);
  });

  it('AzureDevOps_GetPrComments_EmitsOnlyContractKeys', async () => {
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: [
            {
              id: 9,
              status: 'fixed',
              threadContext: {
                filePath: '/src/baz.ts',
                rightFileStart: { line: 5 },
              },
              comments: [
                {
                  id: 2,
                  parentCommentId: 1,
                  content: 'leak check',
                  commentType: 'text',
                  author: { uniqueName: 'a@org.com', displayName: 'A' },
                  publishedDate: '2026-06-04T00:00:00Z',
                },
              ],
            },
          ],
        })
      );

    const result = await provider.getPrComments('100');
    expect(result).toHaveLength(1);

    const allowed = [
      'id',
      'author',
      'body',
      'createdAt',
      'source',
      'path',
      'line',
      'parentId',
      'resolved',
      'state',
    ];
    for (const key of Object.keys(result[0])) {
      expect(allowed).toContain(key);
    }
    // No Azure-native field names may leak through.
    for (const leaked of [
      'content',
      'commentType',
      'publishedDate',
      'threadContext',
      'parentCommentId',
      'uniqueName',
      'displayName',
    ]) {
      expect(result[0]).not.toHaveProperty(leaked);
    }
  });

  it('AzureDevOps_GetPrComments_LeavesResolvedAbsentOnUnknownStatus', async () => {
    mockExec
      .mockResolvedValueOnce(PR_SHOW_RESPONSE)
      .mockResolvedValueOnce(
        JSON.stringify({
          value: [
            // Explicit 'unknown', missing status, and an unrecognized value all
            // degrade to absent (tri-state unknown — never coerced to false).
            {
              id: 30,
              status: 'unknown',
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'u',
                  commentType: 'text',
                  author: { uniqueName: 'a@org.com' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
              ],
            },
            {
              id: 31,
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'm',
                  commentType: 'text',
                  author: { uniqueName: 'a@org.com' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
              ],
            },
            {
              id: 32,
              status: 'somethingNew',
              threadContext: null,
              comments: [
                {
                  id: 1,
                  parentCommentId: 0,
                  content: 'n',
                  commentType: 'text',
                  author: { uniqueName: 'a@org.com' },
                  publishedDate: '2026-06-01T00:00:00Z',
                },
              ],
            },
          ],
        })
      );

    const result = await provider.getPrComments('100');
    expect(result).toHaveLength(3);
    for (const c of result) {
      expect(c.resolved).toBeUndefined();
      expect(isResolvedKnown(c)).toBe(false);
    }
  });
});

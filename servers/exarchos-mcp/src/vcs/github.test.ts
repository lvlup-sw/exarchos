import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubProvider } from './github.js';

// Mock the shell execution helper
vi.mock('./shell.js', () => ({
  exec: vi.fn(),
}));

import { exec } from './shell.js';
const mockExec = vi.mocked(exec);

describe('GitHubProvider', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new GitHubProvider({});
  });

  it('GitHubProvider_Name_IsGithub', () => {
    expect(provider.name).toBe('github');
  });

  it('GitHubProvider_CreatePr_CallsGhWithCorrectArgs', async () => {
    // gh pr create prints the created PR URL to stdout — there is no --json flag.
    mockExec.mockResolvedValue('https://github.com/test/repo/pull/42');

    const result = await provider.createPr({
      title: 'feat: test',
      body: 'Test PR',
      baseBranch: 'main',
      headBranch: 'feat/test',
    });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'pr',
        'create',
        '--title',
        'feat: test',
        '--body',
        'Test PR',
        '--base',
        'main',
        '--head',
        'feat/test',
      ])
    );
    expect(result.url).toBe('https://github.com/test/repo/pull/42');
    expect(result.number).toBe(42);
  });

  it('GitHubProvider_CreatePr_IncludesDraftFlag', async () => {
    mockExec.mockResolvedValue('https://github.com/test/repo/pull/43');

    await provider.createPr({
      title: 'draft pr',
      body: 'WIP',
      baseBranch: 'main',
      headBranch: 'feat/wip',
      draft: true,
    });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--draft'])
    );
  });

  it('GitHubProvider_CreatePr_IncludesLabels', async () => {
    mockExec.mockResolvedValue('https://github.com/test/repo/pull/44');

    await provider.createPr({
      title: 'labeled pr',
      body: 'with labels',
      baseBranch: 'main',
      headBranch: 'feat/labels',
      labels: ['bug', 'priority'],
    });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--label', 'bug,priority'])
    );
  });

  // ─── #1622: gh pr create has no --json flag ──────────────────────────────────

  // gh pr create exits non-zero on flag-parse if --json is passed (it's valid
  // only on gh pr view/list), so the PR is never created. The argv must omit it.
  it('GitHub_CreatePr_OmitsJsonFlag', async () => {
    mockExec.mockResolvedValue('https://github.com/o/r/pull/7');

    await provider.createPr({
      title: 't',
      body: 'b',
      baseBranch: 'main',
      headBranch: 'feat/x',
    });

    const createCall = mockExec.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes('create'),
    );
    expect(createCall?.[1]).not.toContain('--json');
  });

  // On success gh prints the created PR URL; number is its trailing path segment.
  it('GitHub_CreatePr_ParsesNumberFromUrl', async () => {
    mockExec.mockResolvedValue('https://github.com/o/r/pull/42');

    const result = await provider.createPr({
      title: 't',
      body: 'b',
      baseBranch: 'main',
      headBranch: 'feat/x',
    });

    expect(result).toEqual({ url: 'https://github.com/o/r/pull/42', number: 42 });
  });

  // If stdout carries no parseable trailing number, fall back to gh pr view
  // (structured) rather than throwing.
  it('GitHub_CreatePr_FallsBackToPrViewOnUnparseableUrl', async () => {
    mockExec
      .mockResolvedValueOnce(
        'Creating pull request for feat/x into main\nhttps://github.com/o/r/pull/abc',
      )
      .mockResolvedValueOnce(
        JSON.stringify({ number: 99, url: 'https://github.com/o/r/pull/99' }),
      );

    const result = await provider.createPr({
      title: 't',
      body: 'b',
      baseBranch: 'main',
      headBranch: 'feat/x',
    });

    const viewCall = mockExec.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1].includes('view'),
    );
    expect(viewCall?.[1]).toEqual(
      expect.arrayContaining(['pr', 'view', '--json', 'number,url']),
    );
    expect(result).toEqual({ number: 99, url: 'https://github.com/o/r/pull/99' });
  });

  it('GitHubProvider_CheckCi_ParsesGhOutput', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { name: 'tests', conclusion: 'success', detailsUrl: 'https://ci/1' },
        { name: 'lint', conclusion: 'failure', detailsUrl: 'https://ci/2' },
      ])
    );

    const result = await provider.checkCi('42');
    expect(result.status).toBe('fail');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]).toEqual({
      name: 'tests',
      status: 'pass',
      url: 'https://ci/1',
    });
    expect(result.checks[1]).toEqual({
      name: 'lint',
      status: 'fail',
      url: 'https://ci/2',
    });
  });

  it('GitHubProvider_CheckCi_AllPassing', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { name: 'tests', conclusion: 'success', detailsUrl: 'https://ci/1' },
        { name: 'lint', conclusion: 'success', detailsUrl: 'https://ci/2' },
      ])
    );

    const result = await provider.checkCi('42');
    expect(result.status).toBe('pass');
  });

  it('GitHubProvider_CheckCi_PendingChecks', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { name: 'tests', conclusion: null, detailsUrl: 'https://ci/1' },
        { name: 'lint', conclusion: 'success', detailsUrl: 'https://ci/2' },
      ])
    );

    const result = await provider.checkCi('42');
    expect(result.status).toBe('pending');
    expect(result.checks[0].status).toBe('pending');
  });

  it('GitHubProvider_CheckCi_SkippedChecks', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        { name: 'optional', conclusion: 'skipped', detailsUrl: 'https://ci/1' },
      ])
    );

    const result = await provider.checkCi('42');
    expect(result.checks[0].status).toBe('skipped');
    // Skipped-only should be pass
    expect(result.status).toBe('pass');
  });

  it('GitHubProvider_MergePr_DefaultsToSquash', async () => {
    // First call: gh pr merge (human-readable output)
    // Second call: gh pr view --json mergeCommit
    mockExec
      .mockResolvedValueOnce('Merged pull request #42')
      .mockResolvedValueOnce(JSON.stringify({ mergeCommit: { oid: 'abc123' } }));

    await provider.mergePr('42', 'squash');
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'merge', '42', '--squash'])
    );
  });

  it('GitHubProvider_MergePr_UsesRebaseStrategy', async () => {
    mockExec
      .mockResolvedValueOnce('Merged pull request #42')
      .mockResolvedValueOnce(JSON.stringify({ mergeCommit: { oid: 'def456' } }));

    await provider.mergePr('42', 'rebase');
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'merge', '42', '--rebase'])
    );
  });

  it('GitHubProvider_MergePr_UsesMergeStrategy', async () => {
    mockExec
      .mockResolvedValueOnce('Merged pull request #42')
      .mockResolvedValueOnce(JSON.stringify({ mergeCommit: { oid: 'ghi789' } }));

    await provider.mergePr('42', 'merge');
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'merge', '42', '--merge'])
    );
  });

  it('GitHubProvider_MergePr_ReturnsMergedResult', async () => {
    mockExec
      .mockResolvedValueOnce('Merged pull request #42')
      .mockResolvedValueOnce(JSON.stringify({ mergeCommit: { oid: 'abc123' } }));

    const result = await provider.mergePr('42', 'squash');
    expect(result.merged).toBe(true);
    expect(result.sha).toBe('abc123');
  });

  it('GitHubProvider_MergePr_ReturnsMergedWithoutSha_WhenViewFails', async () => {
    mockExec
      .mockResolvedValueOnce('Merged pull request #42')
      .mockRejectedValueOnce(new Error('view failed'));

    const result = await provider.mergePr('42', 'squash');
    expect(result.merged).toBe(true);
    expect(result.sha).toBeUndefined();
  });

  it('GitHubProvider_MergePr_FetchesShaViaGhPrView', async () => {
    mockExec
      .mockResolvedValueOnce('Merged pull request #42')
      .mockResolvedValueOnce(JSON.stringify({ mergeCommit: { oid: 'sha-from-view' } }));

    const result = await provider.mergePr('42', 'squash');
    expect(result.sha).toBe('sha-from-view');

    // Second call should be gh pr view --json mergeCommit
    expect(mockExec).toHaveBeenNthCalledWith(2, 'gh', [
      'pr', 'view', '42', '--json', 'mergeCommit',
    ]);
  });

  it('GitHubProvider_MergePr_HandlesFailure', async () => {
    mockExec.mockRejectedValue(new Error('merge conflict'));

    const result = await provider.mergePr('42', 'squash');
    expect(result.merged).toBe(false);
    expect(result.error).toBe('merge conflict');
  });

  it('GitHubProvider_AddComment_CallsGhPrComment', async () => {
    mockExec.mockResolvedValue('');

    await provider.addComment('42', 'LGTM');
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'comment', '42', '--body', 'LGTM'])
    );
  });

  it('GitHubProvider_AddReply_PostsToRepliesEndpointWithBody', async () => {
    // gh api POST to the review-comment replies endpoint, returning the new
    // reply's id. The thread reply must go through `gh api` (gh pr comment can
    // only post PR-level issue comments, never a thread reply).
    mockExec.mockResolvedValue(JSON.stringify({ id: 778899 }));

    const result = await provider.addReply('42', '201', 'On it — fixed in latest push.');

    expect(mockExec).toHaveBeenCalledWith('gh', [
      'api',
      '--method',
      'POST',
      'repos/{owner}/{repo}/pulls/42/comments/201/replies',
      '-f',
      'body=On it — fixed in latest push.',
    ]);
    expect(result.id).toBe(778899);
  });

  it('GitHubProvider_AddReply_ReturnsIdFromResponse', async () => {
    // The returned id is the new reply's databaseId — same id space as the
    // inline-comment ids getPrComments surfaces, so the handler can correlate.
    mockExec.mockResolvedValue(JSON.stringify({ id: 12345, body: 'x' }));

    const result = await provider.addReply('7', '99', 'reply body');
    expect(result).toEqual({ id: 12345 });
  });

  it('GitHubProvider_GetReviewStatus_ParsesApproved', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        reviews: [{ author: { login: 'reviewer1' }, state: 'APPROVED' }],
        reviewDecision: 'APPROVED',
      })
    );

    const result = await provider.getReviewStatus('42');
    expect(result.state).toBe('approved');
    expect(result.reviewers).toHaveLength(1);
    expect(result.reviewers[0].login).toBe('reviewer1');
    expect(result.reviewers[0].state).toBe('approved');
  });

  it('GitHubProvider_GetReviewStatus_ParsesChangesRequested', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        reviews: [
          { author: { login: 'reviewer1' }, state: 'CHANGES_REQUESTED' },
          { author: { login: 'reviewer2' }, state: 'APPROVED' },
        ],
        reviewDecision: 'CHANGES_REQUESTED',
      })
    );

    const result = await provider.getReviewStatus('42');
    expect(result.state).toBe('changes_requested');
    expect(result.reviewers).toHaveLength(2);
    expect(result.reviewers[0].state).toBe('changes_requested');
    expect(result.reviewers[1].state).toBe('approved');
  });

  it('GitHubProvider_GetReviewStatus_ParsesPending', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        reviews: [],
        reviewDecision: 'REVIEW_REQUIRED',
      })
    );

    const result = await provider.getReviewStatus('42');
    expect(result.state).toBe('pending');
    expect(result.reviewers).toHaveLength(0);
  });

  // ─── T6: listPrs with state filter ───────────────────────────────────────────

  it('GitHubProvider_ListPrs_ReturnsFilteredResults', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        {
          number: 10,
          url: 'https://github.com/test/repo/pull/10',
          title: 'feat: open pr',
          headRefName: 'feat/open',
          baseRefName: 'main',
          state: 'OPEN',
        },
      ])
    );

    const result = await provider.listPrs({ state: 'open' });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'pr',
        'list',
        '--state',
        'open',
        '--json',
        'number,url,title,headRefName,baseRefName,state',
      ])
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      number: 10,
      url: 'https://github.com/test/repo/pull/10',
      title: 'feat: open pr',
      headRefName: 'feat/open',
      baseRefName: 'main',
      state: 'OPEN',
    });
  });

  // ─── T7: listPrs additional filter coverage ──────────────────────────────────

  it('GitHubProvider_ListPrs_FiltersOpenByHead', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        {
          number: 11,
          url: 'https://github.com/test/repo/pull/11',
          title: 'feat: head filter',
          headRefName: 'feat/specific',
          baseRefName: 'main',
          state: 'OPEN',
        },
      ])
    );

    const result = await provider.listPrs({ state: 'open', head: 'feat/specific' });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'pr', 'list',
        '--state', 'open',
        '--head', 'feat/specific',
        '--json', 'number,url,title,headRefName,baseRefName,state',
      ])
    );
    expect(result).toHaveLength(1);
    expect(result[0].headRefName).toBe('feat/specific');
  });

  it('GitHubProvider_ListPrs_NoFilter_ReturnsAll', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        {
          number: 1,
          url: 'https://github.com/test/repo/pull/1',
          title: 'pr one',
          headRefName: 'feat/one',
          baseRefName: 'main',
          state: 'OPEN',
        },
        {
          number: 2,
          url: 'https://github.com/test/repo/pull/2',
          title: 'pr two',
          headRefName: 'feat/two',
          baseRefName: 'develop',
          state: 'MERGED',
        },
      ])
    );

    const result = await provider.listPrs();

    // No filter: should NOT include --state, --head, or --base flags
    expect(mockExec).toHaveBeenCalledWith('gh', [
      'pr', 'list',
      '--json', 'number,url,title,headRefName,baseRefName,state',
    ]);
    expect(result).toHaveLength(2);
  });

  it('GitHubProvider_ListPrs_FilterByBase', async () => {
    mockExec.mockResolvedValue(JSON.stringify([]));

    await provider.listPrs({ base: 'develop' });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--base', 'develop'])
    );
  });

  it('GitHubProvider_ListPrs_StateAll', async () => {
    mockExec.mockResolvedValue(JSON.stringify([]));

    await provider.listPrs({ state: 'all' });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--state', 'all'])
    );
  });

  // ─── T8: getPrComments + getRepository ────────────────────────────────────────

  // Routes a mocked `exec` call to canned JSON keyed by the gh endpoint the
  // args reference. `getPrComments` now hits five surfaces (3 REST aggregates
  // + repo view + graphql enrichment), so every getPrComments test stubs via
  // this matcher rather than a single mockResolvedValue.
  function stubGhComments(opts: {
    issues?: unknown;
    inline?: unknown;
    reviews?: unknown;
    repoView?: unknown;
    graphql?: unknown | (() => never);
  }): void {
    mockExec.mockImplementation((_cmd: string, args?: readonly string[]) => {
      const argv = args ?? [];
      const joined = argv.join(' ');
      const isGraphql = argv.includes('graphql');
      const isRepoView = argv.includes('repo') && argv.includes('view');
      if (isGraphql) {
        if (typeof opts.graphql === 'function') return (opts.graphql as () => never)();
        return Promise.resolve(JSON.stringify(opts.graphql ?? { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }));
      }
      if (isRepoView) {
        return Promise.resolve(JSON.stringify(opts.repoView ?? { nameWithOwner: 'lvlup-sw/exarchos' }));
      }
      if (joined.includes('issues/') && joined.includes('/comments')) {
        return Promise.resolve(JSON.stringify(opts.issues ?? []));
      }
      if (joined.includes('pulls/') && joined.includes('/comments')) {
        return Promise.resolve(JSON.stringify(opts.inline ?? []));
      }
      if (joined.includes('pulls/') && joined.includes('/reviews')) {
        return Promise.resolve(JSON.stringify(opts.reviews ?? []));
      }
      return Promise.resolve('[]');
    });
  }

  it('GitHubProvider_GetPrComments_ReturnsParsedComments', async () => {
    stubGhComments({
      issues: [
        {
          id: 100,
          user: { login: 'reviewer1' },
          body: 'Looks good!',
          created_at: '2026-04-15T10:00:00Z',
        },
        {
          id: 101,
          user: { login: 'reviewer2' },
          body: 'Needs a fix here',
          created_at: '2026-04-15T11:00:00Z',
        },
      ],
    });

    const result = await provider.getPrComments('42');

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'api',
        'repos/{owner}/{repo}/issues/42/comments',
        '--paginate',
      ])
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 100,
      author: 'reviewer1',
      body: 'Looks good!',
      createdAt: '2026-04-15T10:00:00Z',
      source: 'issue-comment',
    });
    expect(result[1]).toEqual({
      id: 101,
      author: 'reviewer2',
      body: 'Needs a fix here',
      createdAt: '2026-04-15T11:00:00Z',
      source: 'issue-comment',
    });
  });

  // ─── DR-7 task 011: aggregate all three GitHub feedback surfaces ─────────────

  it('GetPrComments_AggregatesAllThreeSources', async () => {
    stubGhComments({
      issues: [
        {
          id: 100,
          user: { login: 'human1' },
          body: 'PR-level note',
          created_at: '2026-04-15T10:00:00Z',
        },
      ],
      inline: [
        {
          id: 200,
          user: { login: 'human2' },
          body: 'inline nit',
          created_at: '2026-04-15T10:05:00Z',
          path: 'src/main.ts',
          line: 42,
        },
      ],
      reviews: [
        {
          id: 300,
          user: { login: 'human3' },
          body: 'Please address the above',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-04-15T10:10:00Z',
        },
      ],
    });

    const result = await provider.getPrComments('42');

    const bySource = Object.fromEntries(result.map((c) => [c.source, c]));
    expect(result).toHaveLength(3);

    expect(bySource['issue-comment']).toEqual({
      id: 100,
      author: 'human1',
      body: 'PR-level note',
      createdAt: '2026-04-15T10:00:00Z',
      source: 'issue-comment',
    });
    expect(bySource['review-inline']).toEqual({
      id: 200,
      author: 'human2',
      body: 'inline nit',
      createdAt: '2026-04-15T10:05:00Z',
      source: 'review-inline',
      path: 'src/main.ts',
      line: 42,
    });
    expect(bySource['review-summary']).toEqual({
      id: 300,
      author: 'human3',
      body: 'Please address the above',
      createdAt: '2026-04-15T10:10:00Z',
      source: 'review-summary',
      state: 'CHANGES_REQUESTED',
    });

    // All three REST endpoints were queried with --paginate.
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['api', 'repos/{owner}/{repo}/pulls/42/comments', '--paginate']),
    );
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['api', 'repos/{owner}/{repo}/pulls/42/reviews', '--paginate']),
    );
  });

  it('GetPrComments_LinksRepliesViaParentId', async () => {
    stubGhComments({
      inline: [
        {
          id: 201,
          user: { login: 'human1' },
          body: 'top-level inline',
          created_at: '2026-04-15T10:00:00Z',
          path: 'src/a.ts',
          line: 10,
        },
        {
          id: 202,
          user: { login: 'human2' },
          body: 'a reply',
          created_at: '2026-04-15T10:01:00Z',
          path: 'src/a.ts',
          line: 10,
          in_reply_to_id: 201,
        },
      ],
    });

    const result = await provider.getPrComments('42');
    const top = result.find((c) => c.id === 201);
    const reply = result.find((c) => c.id === 202);

    expect(top?.parentId).toBeUndefined();
    expect(reply?.parentId).toBe(201);
  });

  // Bots (e.g. CodeRabbit) are real feedback authors and MUST NOT be filtered.
  it('GetPrComments_AnyAuthor_IncludesBots', async () => {
    stubGhComments({
      inline: [
        {
          id: 210,
          user: { login: 'coderabbitai[bot]' },
          body: 'Potential issue: …',
          created_at: '2026-04-15T10:00:00Z',
          path: 'src/x.ts',
          line: 3,
        },
      ],
    });

    const result = await provider.getPrComments('42');
    expect(result).toHaveLength(1);
    expect(result[0].author).toBe('coderabbitai[bot]');
  });

  // Pins the post-then-verify contract: a comment posted via `gh pr comment`
  // lands on the issues endpoint and must still surface in the aggregate.
  it('GetPrComments_AddCommentVerifyPath_StillFindsPostedComment', async () => {
    stubGhComments({
      issues: [
        {
          id: 999,
          user: { login: 'exarchos-bot' },
          body: 'exarchos: synthesis ready',
          created_at: '2026-04-15T12:00:00Z',
        },
      ],
    });

    const result = await provider.getPrComments('42');
    const posted = result.find((c) => c.body === 'exarchos: synthesis ready');
    expect(posted).toBeDefined();
    expect(posted?.source).toBe('issue-comment');
  });

  // State-only reviews (empty/whitespace body) are getReviewStatus's job —
  // they must NOT appear as review-summary comments.
  it('GetPrComments_BodylessReview_Excluded', async () => {
    stubGhComments({
      reviews: [
        {
          id: 400,
          user: { login: 'approver' },
          body: '',
          state: 'APPROVED',
          submitted_at: '2026-04-15T10:00:00Z',
        },
        {
          id: 401,
          user: { login: 'whitespace' },
          body: '   \n  ',
          state: 'COMMENTED',
          submitted_at: '2026-04-15T10:01:00Z',
        },
        {
          id: 402,
          user: { login: 'critic' },
          body: 'Real review feedback',
          state: 'CHANGES_REQUESTED',
          submitted_at: '2026-04-15T10:02:00Z',
        },
      ],
    });

    const result = await provider.getPrComments('42');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(402);
    expect(result[0].source).toBe('review-summary');
  });

  it('GetPrComments_ResolvedStatus_GraphqlEnrichmentFailSoft', async () => {
    // (a) GraphQL rejects → getPrComments still resolves, resolved absent.
    stubGhComments({
      inline: [
        {
          id: 500,
          user: { login: 'r1' },
          body: 'inline a',
          created_at: '2026-04-15T10:00:00Z',
          path: 'src/a.ts',
          line: 1,
        },
      ],
      graphql: () => {
        throw new Error('graphql exploded');
      },
    });

    const failSoft = await provider.getPrComments('42');
    expect(failSoft).toHaveLength(1);
    expect(failSoft[0].resolved).toBeUndefined();

    // (b) GraphQL succeeds: id 500 is in a resolved thread → resolved:true;
    // id 501 is in no thread → resolved stays absent (unknown, not false).
    stubGhComments({
      inline: [
        {
          id: 500,
          user: { login: 'r1' },
          body: 'inline a',
          created_at: '2026-04-15T10:00:00Z',
          path: 'src/a.ts',
          line: 1,
        },
        {
          id: 501,
          user: { login: 'r2' },
          body: 'inline b (no thread)',
          created_at: '2026-04-15T10:01:00Z',
          path: 'src/b.ts',
          line: 2,
        },
      ],
      graphql: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    isResolved: true,
                    comments: { nodes: [{ databaseId: 500 }] },
                  },
                ],
              },
            },
          },
        },
      },
    });

    const enriched = await provider.getPrComments('42');
    const c500 = enriched.find((c) => c.id === 500);
    const c501 = enriched.find((c) => c.id === 501);
    expect(c500?.resolved).toBe(true);
    expect(c501?.resolved).toBeUndefined();

    // The exact graphql invocation shape: `gh api graphql` with -F typed
    // owner/repo/pr and the -f query string.
    const graphqlCall = mockExec.mock.calls.find((call) =>
      (call[1] as string[] | undefined)?.includes('graphql'),
    );
    expect(graphqlCall?.[1]).toEqual(
      expect.arrayContaining([
        'api',
        'graphql',
        '-F',
        'owner=lvlup-sw',
        '-F',
        'repo=exarchos',
        '-F',
        'pr=42',
        '-f',
        expect.stringContaining('reviewThreads'),
      ]),
    );
  });

  it('GitHubProvider_GetRepository_ReturnsNameWithOwner', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        nameWithOwner: 'lvlup-sw/exarchos',
        defaultBranchRef: { name: 'main' },
      })
    );

    const result = await provider.getRepository();

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'repo', 'view', '--json', 'nameWithOwner,defaultBranchRef',
      ])
    );
    expect(result).toEqual({
      nameWithOwner: 'lvlup-sw/exarchos',
      defaultBranch: 'main',
    });
  });

  // ─── T9: getPrDiff + createIssue ──────────────────────────────────────────────

  it('GitHubProvider_GetPrDiff_ReturnsDiffString', async () => {
    const diffOutput = `diff --git a/src/main.ts b/src/main.ts
index abc123..def456 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
+import { foo } from './foo.js';
 const x = 1;
 const y = 2;
 const z = 3;`;

    mockExec.mockResolvedValue(diffOutput);

    const result = await provider.getPrDiff('42');

    expect(mockExec).toHaveBeenCalledWith('gh', ['pr', 'diff', '42']);
    expect(result).toBe(diffOutput);
  });

  it('GitHubProvider_CreateIssue_ReturnsIssueResult', async () => {
    mockExec.mockResolvedValue('https://github.com/test/repo/issues/99\n');

    const result = await provider.createIssue({
      title: 'Bug: something broke',
      body: 'Steps to reproduce...',
      labels: ['bug', 'priority'],
    });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'issue', 'create',
        '--title', 'Bug: something broke',
        '--body', 'Steps to reproduce...',
        '--label', 'bug,priority',
      ])
    );
    const callArgs = mockExec.mock.calls[0][1];
    expect(callArgs).not.toContain('--json');
    expect(result).toEqual({
      url: 'https://github.com/test/repo/issues/99',
      number: 99,
    });
  });

  it('GitHubProvider_CreateIssue_NoLabels', async () => {
    mockExec.mockResolvedValue('https://github.com/test/repo/issues/100\n');

    const result = await provider.createIssue({
      title: 'Feature request',
      body: 'Description',
    });

    // Should NOT include --label flag
    const callArgs = mockExec.mock.calls[0][1];
    expect(callArgs).not.toContain('--label');
    expect(result.number).toBe(100);
  });

  // CodeRabbit #3224631240: assignees flag must thread through to gh CLI.
  it('GitHubProvider_CreateIssue_WithAssignees_PassesAssigneeFlag', async () => {
    mockExec.mockResolvedValue('https://github.com/test/repo/issues/101\n');

    await provider.createIssue({
      title: 'Bug',
      body: 'Body',
      assignees: ['alice', 'bob'],
    });

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--assignee', 'alice,bob']),
    );
  });

  // Sentry #14058284/14058450: GitHub's server-side search index strips
  // HTML comments before tokenizing, so `gh issue list --search "<!-- ... -->"`
  // never matches an existing issue's marker. searchIssuesByMarker now
  // lists recent issues without `--search` and filters bodies client-side.
  it('GitHubProvider_SearchIssuesByMarker_ListsRecentIssuesAndFiltersClientSide', async () => {
    const operationId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const otherOp = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    mockExec.mockResolvedValue(JSON.stringify([
      {
        number: 42,
        url: 'https://github.com/test/repo/issues/42',
        body: `Issue body\n\n<!-- exarchos-op:${operationId} -->`,
      },
      {
        number: 43,
        url: 'https://github.com/test/repo/issues/43',
        body: `Unrelated issue\n\n<!-- exarchos-op:${otherOp} -->`,
      },
    ]));

    const result = await provider.searchIssuesByMarker(operationId);

    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'issue', 'list',
        '--state', 'all',
        '--json', 'number,url,body',
      ]),
    );
    // The --search flag MUST NOT appear: GitHub's search index doesn't
    // include HTML-comment content, so a search-based query returns
    // empty and breaks recovery.
    const callArgs = mockExec.mock.calls[0]?.[1] as string[];
    expect(callArgs).not.toContain('--search');

    // Client-side filter keeps the matching issue and drops the unrelated one.
    expect(result).toEqual([
      {
        number: 42,
        url: 'https://github.com/test/repo/issues/42',
        body: expect.stringContaining(operationId),
      },
    ]);
  });

  it('GitHubProvider_SearchIssuesByMarker_NoMatches_ReturnsEmptyArray', async () => {
    mockExec.mockResolvedValue('[]');

    const result = await provider.searchIssuesByMarker(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );

    expect(result).toEqual([]);
  });
});

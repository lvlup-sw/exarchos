import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubProvider } from './github.js';
import { estimateOutputTokens } from '../core/economy.js';
import { DEFAULT_PR_COMMENTS_LIMIT } from './provider.js';

// Recorded `gh pr checks --json name,state,link,bucket,workflow` blobs captured
// verbatim from `gh` v2.95.0 against real PRs, so the parse is pinned to the
// current gh contract (which dropped `conclusion`/`detailsUrl` for `state`/
// `link`) rather than a hand-mock that could drift. `checkCi` only requests
// name,state,link, but the fixtures keep bucket/workflow too so they stay a
// faithful copy of what gh emits.
const RECORDED_PASS_SKIP = readFileSync(
  new URL('./github.checkci-pass-skip.recorded.json', import.meta.url),
  'utf-8',
);
const RECORDED_FAIL_MIX = readFileSync(
  new URL('./github.checkci-fail-mix.recorded.json', import.meta.url),
  'utf-8',
);

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

  it('checkCi_CurrentGhStateField_ParsesRunStatus', async () => {
    // Recorded, all-green run (SUCCESS + SKIPPED). Pins that the current gh
    // schema — `state` (not the removed `conclusion`) and `link` (not the
    // removed `detailsUrl`) — parses into CiChecks with names, urls, and
    // statuses, and requests the current field names.
    mockExec.mockResolvedValue(RECORDED_PASS_SKIP);

    const result = await provider.checkCi('42');

    // The gh invocation must ask for the current field names, never the removed
    // `conclusion`/`detailsUrl`.
    expect(mockExec).toHaveBeenCalledWith('gh', [
      'pr',
      'checks',
      '42',
      '--json',
      'name,state,link',
    ]);

    expect(result.checks).toHaveLength(5);
    // `state` drove the classification and `link` populated the url.
    expect(result.checks[0]).toEqual({
      name: 'CI Gate',
      status: 'pass',
      url: 'https://github.com/lvlup-sw/exarchos/actions/runs/29168111043/job/86584820229',
    });
    // SKIPPED → skipped; a run of passes + skips is overall pass.
    expect(result.checks.find((c) => c.name === 'Windows Unit (Root)')?.status).toBe('skipped');
    expect(result.status).toBe('pass');
  });

  it('checkCi_RecordedGhOutput_ClassifiesPassAndFail', async () => {
    // Recorded mixed run (FAILURE + SKIPPED + SUCCESS) captured from a real PR.
    // Pins the pass/fail/skip classification off `state` and the overall-fail
    // rollup when any check is FAILURE.
    mockExec.mockResolvedValue(RECORDED_FAIL_MIX);

    const result = await provider.checkCi('42');

    expect(result.checks.find((c) => c.name === 'Windows Unit (MCP)')?.status).toBe('fail');
    expect(result.checks.find((c) => c.name === 'release')?.status).toBe('skipped');
    expect(result.checks.find((c) => c.name === 'project-status-update')?.status).toBe('pass');
    // Any failing check ⇒ overall fail.
    expect(result.status).toBe('fail');
  });

  it('checkCi_InProgressState_MapsToPending', async () => {
    // A non-terminal status state (recorded shape, gh's own enum value) buckets
    // to pending, which makes the overall status pending.
    mockExec.mockResolvedValue(
      JSON.stringify([
        {
          bucket: 'pending',
          link: 'https://github.com/lvlup-sw/exarchos/actions/runs/1/job/1',
          name: 'CI Gate',
          state: 'IN_PROGRESS',
          workflow: 'CI',
        },
        {
          bucket: 'pass',
          link: 'https://github.com/lvlup-sw/exarchos/actions/runs/1/job/2',
          name: 'lint',
          state: 'SUCCESS',
          workflow: 'CI',
        },
      ]),
    );

    const result = await provider.checkCi('42');
    expect(result.checks[0]!.status).toBe('pending');
    expect(result.status).toBe('pending');
  });

  it('checkCi_SkippedOnlyRun_IsOverallPass', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify([
        {
          bucket: 'skipping',
          link: 'https://github.com/lvlup-sw/exarchos/actions/runs/1/job/1',
          name: 'optional',
          state: 'SKIPPED',
          workflow: 'CI',
        },
      ]),
    );

    const result = await provider.checkCi('42');
    expect(result.checks[0]!.status).toBe('skipped');
    // Skipped-only should be pass.
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
    expect(result.reviewers[0]!.login).toBe('reviewer1');
    expect(result.reviewers[0]!.state).toBe('approved');
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
    expect(result.reviewers[0]!.state).toBe('changes_requested');
    expect(result.reviewers[1]!.state).toBe('approved');
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
    expect(result[0]!.headRefName).toBe('feat/specific');
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
    expect(result[0]!.author).toBe('coderabbitai[bot]');
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
    expect(result[0]!.id).toBe(402);
    expect(result[0]!.source).toBe('review-summary');
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
    expect(failSoft[0]!.resolved).toBeUndefined();

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
    const callArgs = mockExec.mock.calls[0]![1];
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
    const callArgs = mockExec.mock.calls[0]![1];
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

  // ─── DR-3: getPrCommentsPage — window + page + fields projection ─────────────
  //
  // Boundary discipline: pinned against the hermetic `stubGhComments` fixtures
  // (recorded gh shapes), never live `gh`. The audit measured this PR's real
  // 85-comment feed at 37,613 tokens unbounded; these tests pin the bounded
  // contract that replaces it.

  // Build N issue comments with distinct, monotonically-increasing timestamps
  // (higher index == newer) and a realistic ~220-char body, so the unbounded
  // feed blows the token budget while the default window stays well under it.
  function makeIssueComments(n: number): unknown[] {
    const base = Date.parse('2026-04-15T10:00:00.000Z');
    const body =
      'This change looks mostly fine, but consider the edge case where the ' +
      'input is empty and the downstream consumer expects at least one element; ' +
      'please add a guard and a regression test so we do not reintroduce the bug.';
    return Array.from({ length: n }, (_, i) => ({
      id: 1000 + i,
      user: { login: `reviewer-${i % 7}` },
      body,
      created_at: new Date(base + i * 60_000).toISOString(),
    }));
  }

  it('getPrComments_DefaultLimit_ReturnsPageWithHasMore', async () => {
    stubGhComments({ issues: makeIssueComments(85) });

    const page = await provider.getPrCommentsPage('42');

    // Default window is the newest ~20, with page metadata + hasMore steer.
    expect(page.comments).toHaveLength(DEFAULT_PR_COMMENTS_LIMIT);
    expect(page.page).toEqual({
      total: 85,
      offset: 0,
      limit: DEFAULT_PR_COMMENTS_LIMIT,
      hasMore: true,
    });
    expect(page.notice).toBeDefined();
    expect(page.notice).toContain('20 of 85');

    // Newest-first: the freshest comment (highest index) is first.
    expect(page.comments[0]?.id).toBe(1084);
    expect(page.comments[DEFAULT_PR_COMMENTS_LIMIT - 1]?.id).toBe(1065);

    // Budget: the bounded page is far under 4,000 tokens; the unbounded feed
    // (what the tool used to return) is well over it — this is the reduction
    // DR-3 buys (audit baseline: 37,613 tok on the real PR).
    const full = await provider.getPrComments('42');
    expect(estimateOutputTokens(full)).toBeGreaterThan(4000);
    expect(estimateOutputTokens(page)).toBeLessThanOrEqual(4000);
  });

  it('getPrComments_FieldsProjection_ReturnsOnlyRequestedKeys', async () => {
    stubGhComments({ issues: makeIssueComments(85) });

    const page = await provider.getPrCommentsPage('42', {
      limit: 5,
      fields: ['id', 'author'],
    });

    expect(page.comments).toHaveLength(5);
    for (const comment of page.comments) {
      expect(Object.keys(comment).sort()).toEqual(['author', 'id']);
      expect(comment).not.toHaveProperty('body');
      expect(comment).not.toHaveProperty('createdAt');
      expect(comment).not.toHaveProperty('source');
    }
  });

  it('getPrComments_ExplicitOffset_PagesDeterministically', async () => {
    stubGhComments({ issues: makeIssueComments(85) });

    const first = await provider.getPrCommentsPage('42', { limit: 10, offset: 0 });
    const second = await provider.getPrCommentsPage('42', { limit: 10, offset: 10 });

    expect(first.page).toEqual({ total: 85, offset: 0, limit: 10, hasMore: true });
    expect(second.page).toEqual({ total: 85, offset: 10, limit: 10, hasMore: true });

    // Newest-first, contiguous, non-overlapping pages.
    const firstIds = first.comments.map((c) => c.id);
    const secondIds = second.comments.map((c) => c.id);
    expect(firstIds).toEqual([1084, 1083, 1082, 1081, 1080, 1079, 1078, 1077, 1076, 1075]);
    expect(secondIds).toEqual([1074, 1073, 1072, 1071, 1070, 1069, 1068, 1067, 1066, 1065]);
    expect(firstIds.filter((id) => secondIds.includes(id as number))).toEqual([]);

    // Deterministic: re-reading the same window yields identical order.
    const firstAgain = await provider.getPrCommentsPage('42', { limit: 10, offset: 0 });
    expect(firstAgain.comments.map((c) => c.id)).toEqual(firstIds);
  });

  it('getPrCommentsPage_LastPage_NoHasMoreNoNotice', async () => {
    stubGhComments({ issues: makeIssueComments(25) });

    const page = await provider.getPrCommentsPage('42', { limit: 20, offset: 20 });

    expect(page.comments).toHaveLength(5);
    expect(page.page).toEqual({ total: 25, offset: 20, limit: 20, hasMore: false });
    expect(page.notice).toBeUndefined();
  });
});

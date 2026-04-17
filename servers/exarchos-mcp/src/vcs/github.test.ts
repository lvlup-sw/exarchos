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
    mockExec.mockResolvedValue(
      JSON.stringify({ url: 'https://github.com/test/repo/pull/42', number: 42 })
    );

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
        '--json',
        'url,number',
      ])
    );
    expect(result.url).toBe('https://github.com/test/repo/pull/42');
    expect(result.number).toBe(42);
  });

  it('GitHubProvider_CreatePr_IncludesDraftFlag', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({ url: 'https://github.com/test/repo/pull/43', number: 43 })
    );

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
    mockExec.mockResolvedValue(
      JSON.stringify({ url: 'https://github.com/test/repo/pull/44', number: 44 })
    );

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
});

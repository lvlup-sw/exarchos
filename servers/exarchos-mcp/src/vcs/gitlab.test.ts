import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitLabProvider } from './gitlab.js';
import { UnsupportedOperationError } from './provider.js';

// Mock the shell execution helper
vi.mock('./shell.js', () => ({
  exec: vi.fn(),
}));

import { exec } from './shell.js';
const mockExec = vi.mocked(exec);

describe('GitLabProvider', () => {
  let provider: GitLabProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    provider = new GitLabProvider({});
  });

  it('GitLabProvider_Name_IsGitlab', () => {
    expect(provider.name).toBe('gitlab');
  });

  // ── createPr ────────────────────────────────────────────────────────────

  // `glab mr create` has no `--json` flag, so createPr issues a bare create
  // then reads identity via `glab mr view <branch> --json iid,webUrl`. Tests
  // stub the two exec calls in order: create (output ignored), then view.
  const VIEW_JSON = (iid: number, webUrl: string): string =>
    JSON.stringify({ iid, webUrl });

  it('GitLabProvider_CreatePr_CallsGlabWithCorrectArgs', async () => {
    mockExec
      .mockResolvedValueOnce('') // create — output not parsed
      .mockResolvedValueOnce(
        VIEW_JSON(10, 'https://gitlab.com/test/repo/-/merge_requests/10')
      );

    const result = await provider.createPr({
      title: 'feat: gitlab test',
      body: 'Test MR',
      baseBranch: 'main',
      headBranch: 'feat/test',
    });

    expect(mockExec).toHaveBeenNthCalledWith(1, 'glab', [
      'mr',
      'create',
      '--title',
      'feat: gitlab test',
      '--description',
      'Test MR',
      '--source-branch',
      'feat/test',
      '--target-branch',
      'main',
    ]);
    expect(mockExec).toHaveBeenNthCalledWith(2, 'glab', [
      'mr',
      'view',
      'feat/test',
      '--json',
      'iid,webUrl',
    ]);
    expect(result.url).toBe('https://gitlab.com/test/repo/-/merge_requests/10');
    expect(result.number).toBe(10);
  });

  it('GitLab_CreatePr_OmitsJsonFlagOnCreate', async () => {
    mockExec
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        VIEW_JSON(10, 'https://gitlab.com/test/repo/-/merge_requests/10')
      );

    await provider.createPr({
      title: 'no json on create',
      body: 'body',
      baseBranch: 'main',
      headBranch: 'feat/test',
    });

    const createArgs = mockExec.mock.calls[0][1] ?? [];
    expect(createArgs).toContain('mr');
    expect(createArgs).toContain('create');
    expect(createArgs).not.toContain('--json');
    expect(createArgs).not.toContain('url,iid');
  });

  it('GitLab_CreatePr_ReadsIidAndUrlFromMrView', async () => {
    mockExec
      .mockResolvedValueOnce('Created MR !42')
      .mockResolvedValueOnce(
        VIEW_JSON(42, 'https://gitlab.com/test/repo/-/merge_requests/42')
      );

    const result = await provider.createPr({
      title: 'reads from view',
      body: 'body',
      baseBranch: 'main',
      headBranch: 'feat/view',
    });

    expect(mockExec).toHaveBeenNthCalledWith(2, 'glab', [
      'mr',
      'view',
      'feat/view',
      '--json',
      'iid,webUrl',
    ]);
    expect(result).toEqual({
      url: 'https://gitlab.com/test/repo/-/merge_requests/42',
      number: 42,
    });
  });

  it('GitLab_CreatePr_ThrowsWhenViewReadFails', async () => {
    mockExec
      .mockResolvedValueOnce('Created MR !99')
      .mockRejectedValueOnce(new Error('glab mr view failed'));

    await expect(
      provider.createPr({
        title: 'view fails',
        body: 'body',
        baseBranch: 'main',
        headBranch: 'feat/view-fail',
      })
    ).rejects.toThrow('glab mr view failed');
  });

  it('GitLabProvider_CreatePr_IncludesDraftFlag', async () => {
    mockExec
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        VIEW_JSON(11, 'https://gitlab.com/test/repo/-/merge_requests/11')
      );

    await provider.createPr({
      title: 'draft mr',
      body: 'WIP',
      baseBranch: 'main',
      headBranch: 'feat/wip',
      draft: true,
    });

    const createArgs = mockExec.mock.calls[0][1] ?? [];
    expect(createArgs).toContain('--draft');
  });

  it('GitLabProvider_CreatePr_IncludesLabels', async () => {
    mockExec
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce(
        VIEW_JSON(12, 'https://gitlab.com/test/repo/-/merge_requests/12')
      );

    await provider.createPr({
      title: 'labeled mr',
      body: 'with labels',
      baseBranch: 'main',
      headBranch: 'feat/labels',
      labels: ['bug', 'priority'],
    });

    const createArgs = mockExec.mock.calls[0][1] ?? [];
    expect(createArgs).toContain('--label');
    expect(createArgs).toContain('bug,priority');
  });

  it('GitLabProvider_CreatePr_PropagatesExecError', async () => {
    mockExec.mockRejectedValue(new Error('glab not found'));

    await expect(
      provider.createPr({
        title: 'will fail',
        body: 'error',
        baseBranch: 'main',
        headBranch: 'feat/error',
      })
    ).rejects.toThrow('glab not found');
  });

  // ── checkCi ─────────────────────────────────────────────────────────────

  it('GitLabProvider_CheckCi_ParsesPipelineJobs', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        pipeline: {
          jobs: [
            { name: 'test', status: 'success', webUrl: 'https://gitlab.com/ci/1' },
            { name: 'lint', status: 'failed', webUrl: 'https://gitlab.com/ci/2' },
          ],
        },
      })
    );

    const result = await provider.checkCi('10');

    expect(mockExec).toHaveBeenCalledWith('glab', [
      'mr',
      'view',
      '10',
      '--json',
      'pipeline',
    ]);
    expect(result.status).toBe('fail');
    expect(result.checks).toHaveLength(2);
    expect(result.checks[0]).toEqual({
      name: 'test',
      status: 'pass',
      url: 'https://gitlab.com/ci/1',
    });
    expect(result.checks[1]).toEqual({
      name: 'lint',
      status: 'fail',
      url: 'https://gitlab.com/ci/2',
    });
  });

  it('GitLabProvider_CheckCi_AllPassing', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        pipeline: {
          jobs: [
            { name: 'test', status: 'success', webUrl: 'https://gitlab.com/ci/1' },
            { name: 'build', status: 'success', webUrl: 'https://gitlab.com/ci/2' },
          ],
        },
      })
    );

    const result = await provider.checkCi('10');
    expect(result.status).toBe('pass');
  });

  it('GitLabProvider_CheckCi_PendingJobs', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        pipeline: {
          jobs: [
            { name: 'test', status: 'running', webUrl: 'https://gitlab.com/ci/1' },
            { name: 'lint', status: 'success', webUrl: 'https://gitlab.com/ci/2' },
          ],
        },
      })
    );

    const result = await provider.checkCi('10');
    expect(result.status).toBe('pending');
    expect(result.checks[0].status).toBe('pending');
  });

  it('GitLabProvider_CheckCi_SkippedJobs', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        pipeline: {
          jobs: [
            { name: 'optional', status: 'skipped', webUrl: 'https://gitlab.com/ci/1' },
          ],
        },
      })
    );

    const result = await provider.checkCi('10');
    expect(result.checks[0].status).toBe('skipped');
    expect(result.status).toBe('pass');
  });

  it('GitLabProvider_CheckCi_NoPipeline', async () => {
    mockExec.mockResolvedValue(JSON.stringify({ pipeline: null }));

    const result = await provider.checkCi('10');
    expect(result.status).toBe('pending');
    expect(result.checks).toHaveLength(0);
  });

  it('GitLabProvider_CheckCi_PropagatesExecError', async () => {
    mockExec.mockRejectedValue(new Error('glab ci error'));

    await expect(provider.checkCi('10')).rejects.toThrow('glab ci error');
  });

  // ── mergePr ─────────────────────────────────────────────────────────────

  it('GitLabProvider_MergePr_CallsGlabMergeWithSquash', async () => {
    mockExec
      .mockResolvedValueOnce('Merged MR !10')
      .mockResolvedValueOnce(JSON.stringify({ sha: 'abc123' }));

    const result = await provider.mergePr('10', 'squash');

    expect(mockExec).toHaveBeenNthCalledWith(1, 'glab', [
      'mr',
      'merge',
      '10',
      '--squash',
    ]);
    expect(result.merged).toBe(true);
  });

  it('GitLabProvider_MergePr_RebaseStrategy', async () => {
    mockExec
      .mockResolvedValueOnce('Merged MR !10')
      .mockResolvedValueOnce(JSON.stringify({ sha: 'def456' }));

    await provider.mergePr('10', 'rebase');

    expect(mockExec).toHaveBeenNthCalledWith(1, 'glab', [
      'mr',
      'merge',
      '10',
      '--rebase',
    ]);
  });

  it('GitLabProvider_MergePr_MergeStrategy', async () => {
    mockExec
      .mockResolvedValueOnce('Merged MR !10')
      .mockResolvedValueOnce(JSON.stringify({ sha: 'ghi789' }));

    await provider.mergePr('10', 'merge');

    // glab mr merge with no special flag (default is merge commit)
    expect(mockExec).toHaveBeenNthCalledWith(1, 'glab', [
      'mr',
      'merge',
      '10',
    ]);
  });

  it('GitLabProvider_MergePr_ReturnsSha', async () => {
    mockExec
      .mockResolvedValueOnce('Merged MR !10')
      .mockResolvedValueOnce(JSON.stringify({ sha: 'merge-sha-123' }));

    const result = await provider.mergePr('10', 'squash');
    expect(result.merged).toBe(true);
    expect(result.sha).toBe('merge-sha-123');
  });

  it('GitLabProvider_MergePr_ReturnsMergedWithoutSha_WhenViewFails', async () => {
    mockExec
      .mockResolvedValueOnce('Merged MR !10')
      .mockRejectedValueOnce(new Error('view failed'));

    const result = await provider.mergePr('10', 'squash');
    expect(result.merged).toBe(true);
    expect(result.sha).toBeUndefined();
  });

  it('GitLabProvider_MergePr_HandlesFailure', async () => {
    mockExec.mockRejectedValue(new Error('merge conflict'));

    const result = await provider.mergePr('10', 'squash');
    expect(result.merged).toBe(false);
    expect(result.error).toBe('merge conflict');
  });

  // ── addComment ──────────────────────────────────────────────────────────

  it('GitLabProvider_AddComment_CallsGlabMrComment', async () => {
    mockExec.mockResolvedValue('');

    await provider.addComment('10', 'LGTM');
    expect(mockExec).toHaveBeenCalledWith('glab', [
      'mr',
      'comment',
      '10',
      '--message',
      'LGTM',
    ]);
  });

  // ── getReviewStatus ─────────────────────────────────────────────────────

  it('GitLabProvider_GetReviewStatus_ParsesApproved', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        reviewers: [{ username: 'reviewer1' }],
        approvedBy: [{ username: 'reviewer1' }],
      })
    );

    const result = await provider.getReviewStatus('10');

    expect(mockExec).toHaveBeenCalledWith('glab', [
      'mr',
      'view',
      '10',
      '--json',
      'reviewers,approvedBy',
    ]);
    expect(result.state).toBe('approved');
    expect(result.reviewers).toHaveLength(1);
    expect(result.reviewers[0].login).toBe('reviewer1');
    expect(result.reviewers[0].state).toBe('approved');
  });

  it('GitLabProvider_GetReviewStatus_ParsesPending', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        reviewers: [{ username: 'reviewer1' }, { username: 'reviewer2' }],
        approvedBy: [],
      })
    );

    const result = await provider.getReviewStatus('10');
    expect(result.state).toBe('pending');
    expect(result.reviewers).toHaveLength(2);
    expect(result.reviewers[0].state).toBe('pending');
    expect(result.reviewers[1].state).toBe('pending');
  });

  it('GitLabProvider_GetReviewStatus_PartialApproval', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        reviewers: [{ username: 'reviewer1' }, { username: 'reviewer2' }],
        approvedBy: [{ username: 'reviewer1' }],
      })
    );

    const result = await provider.getReviewStatus('10');
    // Not all reviewers have approved, so still pending
    expect(result.state).toBe('pending');
    expect(result.reviewers[0].state).toBe('approved');
    expect(result.reviewers[1].state).toBe('pending');
  });

  it('GitLabProvider_GetReviewStatus_NoReviewers', async () => {
    mockExec.mockResolvedValue(
      JSON.stringify({
        reviewers: [],
        approvedBy: [],
      })
    );

    const result = await provider.getReviewStatus('10');
    expect(result.state).toBe('pending');
    expect(result.reviewers).toHaveLength(0);
  });

  // ── getPrComments (DR-7 #1592 task 013 — signature conformance) ───────────
  // The PrComment contract was widened (source/parentId/resolved/state) in task
  // 010. GitLab still does not implement harvesting (tracked as a DR-7 follow-up
  // issue), so getPrComments must conform to the widened `Promise<PrComment[]>`
  // signature — which it does by throwing (it returns no value) — and surface a
  // structured UnsupportedOperationError rather than a silent no-op.

  it('GitLab_GetPrComments_ThrowsUnsupported', async () => {
    await expect(provider.getPrComments('10')).rejects.toThrow(
      UnsupportedOperationError,
    );
    await expect(provider.getPrComments('10')).rejects.toThrow(
      'gitlab: getPrComments is not yet supported',
    );
  });
});

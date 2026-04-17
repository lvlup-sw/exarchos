import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzureDevOpsProvider } from './azure-devops.js';

// Mock the shell execution helper
vi.mock('./shell.js', () => ({
  exec: vi.fn(),
}));

import { exec } from './shell.js';
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
});

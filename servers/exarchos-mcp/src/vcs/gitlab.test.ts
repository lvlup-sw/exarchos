import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitLabProvider } from './gitlab.js';
import type { PrComment } from './provider.js';

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

    const createArgs = mockExec.mock.calls[0]![1] ?? [];
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

    const createArgs = mockExec.mock.calls[0]![1] ?? [];
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

    const createArgs = mockExec.mock.calls[0]![1] ?? [];
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
    expect(result.checks[0]!.status).toBe('pending');
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
    expect(result.checks[0]!.status).toBe('skipped');
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
    expect(result.reviewers[0]!.login).toBe('reviewer1');
    expect(result.reviewers[0]!.state).toBe('approved');
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
    expect(result.reviewers[0]!.state).toBe('pending');
    expect(result.reviewers[1]!.state).toBe('pending');
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
    expect(result.reviewers[0]!.state).toBe('approved');
    expect(result.reviewers[1]!.state).toBe('pending');
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

  // ── getPrComments ─────────────────────────────────────────────────────────
  // GitLab harvests ALL feedback from one paginated endpoint:
  // `projects/:fullpath/merge_requests/<iid>/discussions`. Each test stubs that
  // endpoint per page; a diff `position` ⇒ 'review-inline', everything else ⇒
  // 'issue-comment'. There is no 'review-summary' surface on GitLab.

  // Route mocked `exec` to a per-page canned discussions payload, keyed by the
  // `page=` query param the implementation appends.
  function stubDiscussions(pages: readonly unknown[][]): void {
    mockExec.mockImplementation((_cmd: string, args?: readonly string[]) => {
      const endpoint = (args ?? []).find((a) => a.includes('discussions')) ?? '';
      // Anchor on the separator so we don't match the `page` inside `per_page`.
      const m = endpoint.match(/[?&]page=(\d+)/);
      const page = m ? Number(m[1]) : 1;
      return Promise.resolve(JSON.stringify(pages[page - 1] ?? []));
    });
  }

  const CONTRACT_KEYS = new Set<keyof PrComment>([
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
  ]);

  it('GitLab_GetPrComments_AggregatesNotesAndThreads', async () => {
    stubDiscussions([
      [
        {
          id: 'd1',
          individual_note: true,
          notes: [
            {
              id: 1,
              body: 'PR-level note',
              author: { username: 'alice' },
              created_at: '2026-04-15T10:00:00Z',
              type: null,
              system: false,
              resolvable: false,
            },
          ],
        },
        {
          id: 'd2',
          individual_note: false,
          notes: [
            {
              id: 2,
              body: 'thread root',
              author: { username: 'bob' },
              created_at: '2026-04-15T10:05:00Z',
              type: 'DiscussionNote',
              system: false,
              resolvable: false,
            },
            {
              id: 3,
              body: 'thread reply',
              author: { username: 'carol' },
              created_at: '2026-04-15T10:06:00Z',
              type: 'DiscussionNote',
              system: false,
              resolvable: false,
            },
          ],
        },
      ],
    ]);

    const result = await provider.getPrComments('42');

    expect(mockExec).toHaveBeenCalledWith('glab', [
      'api',
      'projects/:fullpath/merge_requests/42/discussions?per_page=100&page=1',
    ]);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(result.every((c) => c.source === 'issue-comment')).toBe(true);
  });

  it('GitLab_GetPrComments_ClassifiesDiffNoteAsReviewInlineWithPathLine', async () => {
    stubDiscussions([
      [
        {
          id: 'd1',
          individual_note: true,
          notes: [
            {
              id: 10,
              body: 'inline nit',
              author: { username: 'alice' },
              created_at: '2026-04-15T10:00:00Z',
              type: 'DiffNote',
              system: false,
              resolvable: true,
              resolved: false,
              position: {
                old_path: 'src/main.ts',
                new_path: 'src/main.ts',
                position_type: 'text',
                old_line: null,
                new_line: 42,
              },
            },
          ],
        },
      ],
    ]);

    const result = await provider.getPrComments('42');

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 10,
      source: 'review-inline',
      path: 'src/main.ts',
      line: 42,
    });
  });

  it('GitLab_GetPrComments_MapsResolvableDiscussionTriState', async () => {
    stubDiscussions([
      [
        {
          id: 'd1',
          individual_note: true,
          notes: [
            {
              id: 1,
              body: 'resolved thread',
              author: { username: 'a' },
              created_at: '2026-04-15T10:00:00Z',
              type: 'DiffNote',
              system: false,
              resolvable: true,
              resolved: true,
              position: { new_path: 'a.ts', new_line: 1 },
            },
          ],
        },
        {
          id: 'd2',
          individual_note: true,
          notes: [
            {
              id: 2,
              body: 'open thread',
              author: { username: 'b' },
              created_at: '2026-04-15T10:01:00Z',
              type: 'DiffNote',
              system: false,
              resolvable: true,
              resolved: false,
              position: { new_path: 'b.ts', new_line: 2 },
            },
          ],
        },
      ],
    ]);

    const result = await provider.getPrComments('42');

    const byId = Object.fromEntries(result.map((c) => [c.id, c]));
    expect(byId[1]!.resolved).toBe(true);
    expect(byId[2]!.resolved).toBe(false);
  });

  it('GitLab_GetPrComments_LeavesResolvedAbsentOnNonResolvableNote', async () => {
    stubDiscussions([
      [
        {
          id: 'd1',
          individual_note: true,
          notes: [
            {
              id: 1,
              body: 'plain comment',
              author: { username: 'a' },
              created_at: '2026-04-15T10:00:00Z',
              type: null,
              system: false,
              resolvable: false,
              resolved: false, // present but resolvable:false ⇒ must stay absent
            },
          ],
        },
      ],
    ]);

    const result = await provider.getPrComments('42');

    expect(result).toHaveLength(1);
    expect('resolved' in result[0]!).toBe(false);
    expect(result[0]!.resolved).toBeUndefined();
  });

  it('GitLab_GetPrComments_ThreadsRepliesByParentId', async () => {
    stubDiscussions([
      [
        {
          id: 'd1',
          individual_note: false,
          notes: [
            {
              id: 100,
              body: 'root',
              author: { username: 'a' },
              created_at: '2026-04-15T10:00:00Z',
              type: 'DiscussionNote',
              system: false,
              resolvable: false,
            },
            {
              id: 101,
              body: 'reply one',
              author: { username: 'b' },
              created_at: '2026-04-15T10:01:00Z',
              type: 'DiscussionNote',
              system: false,
              resolvable: false,
            },
            {
              id: 102,
              body: 'reply two',
              author: { username: 'c' },
              created_at: '2026-04-15T10:02:00Z',
              type: 'DiscussionNote',
              system: false,
              resolvable: false,
            },
          ],
        },
      ],
    ]);

    const result = await provider.getPrComments('42');

    expect(result).toHaveLength(3);
    expect('parentId' in result[0]!).toBe(false);
    expect(result[1]!.parentId).toBe(100);
    expect(result[2]!.parentId).toBe(100);
  });

  it('GitLab_GetPrComments_PaginatesBeyondFirstPage', async () => {
    // Page 1 is full (== per_page 100) ⇒ the loop must fetch page 2.
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: `d${i}`,
      individual_note: true,
      notes: [
        {
          id: i + 1,
          body: `note ${i}`,
          author: { username: 'a' },
          created_at: '2026-04-15T10:00:00Z',
          type: null,
          system: false,
          resolvable: false,
        },
      ],
    }));
    const secondPage = [
      {
        id: 'last',
        individual_note: true,
        notes: [
          {
            id: 1000,
            body: 'overflow note',
            author: { username: 'z' },
            created_at: '2026-04-15T11:00:00Z',
            type: null,
            system: false,
            resolvable: false,
          },
        ],
      },
    ];
    stubDiscussions([fullPage, secondPage]);

    const result = await provider.getPrComments('42');

    expect(mockExec).toHaveBeenCalledWith('glab', [
      'api',
      'projects/:fullpath/merge_requests/42/discussions?per_page=100&page=1',
    ]);
    expect(mockExec).toHaveBeenCalledWith('glab', [
      'api',
      'projects/:fullpath/merge_requests/42/discussions?per_page=100&page=2',
    ]);
    expect(result).toHaveLength(101);
    expect(result.some((c) => c.id === 1000)).toBe(true);
  });

  it('GitLab_GetPrComments_EmitsOnlyContractKeys', async () => {
    stubDiscussions([
      [
        {
          id: 'd1',
          individual_note: false,
          notes: [
            {
              id: 1,
              body: 'root inline',
              author: { username: 'a' },
              created_at: '2026-04-15T10:00:00Z',
              type: 'DiffNote',
              system: false,
              resolvable: true,
              resolved: true,
              position: { new_path: 'x.ts', new_line: 5, old_path: 'x.ts' },
            },
            {
              id: 2,
              body: 'reply',
              author: { username: 'b' },
              created_at: '2026-04-15T10:01:00Z',
              type: 'DiffNote',
              system: false,
              resolvable: true,
              resolved: true,
              position: { new_path: 'x.ts', new_line: 5, old_path: 'x.ts' },
            },
          ],
        },
      ],
    ]);

    const result = await provider.getPrComments('42');

    for (const comment of result) {
      for (const key of Object.keys(comment)) {
        expect(CONTRACT_KEYS.has(key as keyof PrComment)).toBe(true);
      }
    }
    // Sanity: no raw GitLab field names leaked through.
    const leaked = result.flatMap((c) => Object.keys(c));
    expect(leaked).not.toContain('new_path');
    expect(leaked).not.toContain('resolvable');
    expect(leaked).not.toContain('system');
    expect(leaked).not.toContain('position');
  });

  it('GitLab_GetPrComments_LeavesResolvedAbsentOnMissingResolutionField', async () => {
    stubDiscussions([
      [
        {
          id: 'd1',
          individual_note: true,
          notes: [
            {
              id: 1,
              body: 'resolvable but no resolved field',
              author: { username: 'a' },
              created_at: '2026-04-15T10:00:00Z',
              type: 'DiffNote',
              system: false,
              resolvable: true,
              // `resolved` deliberately omitted (missing/garbled field)
              position: { new_path: 'a.ts', new_line: 1 },
            },
          ],
        },
      ],
    ]);

    const result = await provider.getPrComments('42');

    expect(result).toHaveLength(1);
    // Per-field defensive: missing resolution leaves `resolved` absent, but the
    // rest of the comment still maps.
    expect('resolved' in result[0]!).toBe(false);
    expect(result[0]).toMatchObject({
      id: 1,
      source: 'review-inline',
      path: 'a.ts',
      line: 1,
    });
  });

  it('GitLab_GetPrComments_SkipsSystemNotes', async () => {
    // System notes (label/description activity) are not feedback — GitHub's
    // comment endpoints never surface these, so two-source parity drops them.
    stubDiscussions([
      [
        {
          id: 'd1',
          individual_note: true,
          notes: [
            {
              id: 1,
              body: 'changed the description',
              author: { username: 'gitlab-bot' },
              created_at: '2026-04-15T10:00:00Z',
              type: null,
              system: true,
              resolvable: false,
            },
          ],
        },
        {
          id: 'd2',
          individual_note: true,
          notes: [
            {
              id: 2,
              body: 'real comment',
              author: { username: 'alice' },
              created_at: '2026-04-15T10:01:00Z',
              type: null,
              system: false,
              resolvable: false,
            },
          ],
        },
      ],
    ]);

    const result = await provider.getPrComments('42');

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(2);
  });
});

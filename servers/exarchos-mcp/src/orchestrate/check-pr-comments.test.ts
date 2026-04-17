// ─── Check PR Comments Action Tests ─────────────────────────────────────────
//
// Tests use a mock VcsProvider instead of mocking execFileSync.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, PrComment, RepoInfo } from '../vcs/provider.js';
import { handleCheckPrComments } from './check-pr-comments.js';

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

function createMockProvider(overrides: {
  prComments?: PrComment[];
  repoInfo?: RepoInfo;
  commentsError?: Error;
  repoError?: Error;
} = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: vi.fn(),
    getPrComments: overrides.commentsError
      ? vi.fn().mockRejectedValue(overrides.commentsError)
      : vi.fn<(prId: string) => Promise<PrComment[]>>().mockResolvedValue(overrides.prComments ?? []),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: overrides.repoError
      ? vi.fn().mockRejectedValue(overrides.repoError)
      : vi.fn<() => Promise<RepoInfo>>().mockResolvedValue(overrides.repoInfo ?? { nameWithOwner: 'owner/repo', defaultBranch: 'main' }),
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** No comments on PR */
const FIXTURE_NO_COMMENTS: PrComment[] = [];

/** All top-level comments have replies (simulated via in_reply_to pattern) */
const FIXTURE_ALL_RESOLVED: PrComment[] = [
  { id: 1, author: 'alice', body: 'Please fix this', createdAt: '2026-01-01T00:00:00Z', path: 'src/foo.ts', line: 10 },
  { id: 2, author: 'bob', body: 'Fixed!', createdAt: '2026-01-01T00:01:00Z', path: 'src/foo.ts', line: 10 },
  { id: 3, author: 'alice', body: 'Rename this', createdAt: '2026-01-01T00:02:00Z', path: 'src/bar.ts', line: 20 },
  { id: 4, author: 'bob', body: 'Done', createdAt: '2026-01-01T00:03:00Z', path: 'src/bar.ts', line: 20 },
];

/** Some top-level comments have no replies */
const FIXTURE_UNRESOLVED: PrComment[] = [
  { id: 1, author: 'alice', body: 'Please fix this', createdAt: '2026-01-01T00:00:00Z', path: 'src/foo.ts', line: 10 },
  { id: 2, author: 'bob', body: 'Fixed!', createdAt: '2026-01-01T00:01:00Z', path: 'src/foo.ts', line: 10 },
  { id: 3, author: 'alice', body: 'Rename this variable to something clearer', createdAt: '2026-01-01T00:02:00Z', path: 'src/bar.ts', line: 20 },
  // No reply to comment 3 — unresolved
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleCheckPrComments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Uses VcsProvider ─────────────────────────────────────────────────────

  it('handleCheckPrComments_UsesProviderGetPrComments', async () => {
    const provider = createMockProvider({ prComments: FIXTURE_NO_COMMENTS });
    const result = await handleCheckPrComments({ pr: 42, repo: 'owner/repo' }, provider);

    expect(result.success).toBe(true);
    expect(provider.getPrComments).toHaveBeenCalledWith('42');
  });

  it('handleCheckPrComments_UsesProviderGetRepository_WhenRepoNotSpecified', async () => {
    const provider = createMockProvider({
      prComments: FIXTURE_NO_COMMENTS,
      repoInfo: { nameWithOwner: 'auto/detected', defaultBranch: 'main' },
    });
    const result = await handleCheckPrComments({ pr: 42 }, provider);

    expect(result.success).toBe(true);
    expect(provider.getRepository).toHaveBeenCalled();
  });

  // ─── No Comments ────────────────────────────────────────────────────────

  it('handleCheckPrComments_NoComments_ReturnsPassed', async () => {
    const provider = createMockProvider({ prComments: FIXTURE_NO_COMMENTS });
    const result = await handleCheckPrComments({ pr: 42, repo: 'owner/repo' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; totalComments: number; unresolvedThreads: number };
    expect(data.passed).toBe(true);
    expect(data.totalComments).toBe(0);
    expect(data.unresolvedThreads).toBe(0);
  });

  // ─── Missing PR Number ────────────────────────────────────────────────

  it('handleCheckPrComments_MissingPrNumber_ReturnsError', async () => {
    const provider = createMockProvider();
    const result = await handleCheckPrComments({ pr: 0, repo: 'owner/repo' }, provider);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('pr');
  });

  // ─── VcsProvider Failure ───────────────────────────────────────────────

  it('handleCheckPrComments_ProviderFailure_ReturnsError', async () => {
    const provider = createMockProvider({
      commentsError: new Error('gh: command not found'),
    });
    const result = await handleCheckPrComments({ pr: 42, repo: 'owner/repo' }, provider);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GH_API_ERROR');
  });

  // ─── Repo Detection Failure ───────────────────────────────────────────

  it('handleCheckPrComments_RepoDetectionFailure_ReturnsError', async () => {
    const provider = createMockProvider({
      repoError: new Error('Not a git repository'),
    });
    const result = await handleCheckPrComments({ pr: 42 }, provider);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('REPO_DETECTION_ERROR');
  });

  // ─── Report Contains Analysis ─────────────────────────────────────────

  it('handleCheckPrComments_ReportContainsAnalysis', async () => {
    const provider = createMockProvider({ prComments: FIXTURE_UNRESOLVED });
    const result = await handleCheckPrComments({ pr: 99, repo: 'owner/repo' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('PR #99');
    expect(data.report).toContain('Top-level comments:');
    expect(data.report).toContain('Unaddressed:');
  });
});

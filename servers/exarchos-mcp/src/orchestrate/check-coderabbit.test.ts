// ─── Check CodeRabbit Action Tests ──────────────────────────────────────────
//
// Tests use a mock VcsProvider instead of mocking execFileSync.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, ReviewStatus, ReviewerStatus } from '../vcs/provider.js';
import { handleCheckCoderabbit } from './check-coderabbit.js';
import type { PrReviewResult } from './check-coderabbit.js';

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

function createMockProvider(
  reviewStatusByPr: Record<number, ReviewStatus> = {},
  errorPrs: Set<number> = new Set(),
): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn<(prId: string) => Promise<ReviewStatus>>().mockImplementation(
      async (prId: string) => {
        const pr = Number(prId);
        if (errorPrs.has(pr)) {
          throw new Error('API error');
        }
        return reviewStatusByPr[pr] ?? { state: 'pending', reviewers: [] };
      },
    ),
    listPrs: vi.fn(),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  };
}

function makeReviewStatus(
  reviewers: Array<{ login: string; state: ReviewerStatus['state'] }>,
): ReviewStatus {
  const mapped: ReviewerStatus[] = reviewers.map(r => ({
    login: r.login,
    state: r.state,
  }));
  const allApproved = mapped.length > 0 && mapped.every(r => r.state === 'approved');
  const hasChanges = mapped.some(r => r.state === 'changes_requested');
  return {
    state: allApproved ? 'approved' : hasChanges ? 'changes_requested' : 'pending',
    reviewers: mapped,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleCheckCoderabbit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── All PRs Approved ───────────────────────────────────────────────────

  it('handleCheckCoderabbit_AllApproved_ReturnsPassed', async () => {
    const provider = createMockProvider({
      1: makeReviewStatus([{ login: 'coderabbitai[bot]', state: 'approved' }]),
      2: makeReviewStatus([{ login: 'coderabbitai[bot]', state: 'approved' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1, 2] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].verdict).toBe('pass');
    expect(data.results[1].verdict).toBe('pass');
  });

  // ─── Uses VcsProvider ─────────────────────────────────────────────────

  it('handleCheckCoderabbit_UsesProviderGetReviewStatus', async () => {
    const provider = createMockProvider({
      1: makeReviewStatus([{ login: 'coderabbitai[bot]', state: 'approved' }]),
    });

    await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1] },
      provider,
    );

    expect(provider.getReviewStatus).toHaveBeenCalledWith('1');
  });

  // ─── CHANGES_REQUESTED -> Fail ──────────────────────────────────────────

  it('handleCheckCoderabbit_ChangesRequested_ReturnsFailed', async () => {
    const provider = createMockProvider({
      1: makeReviewStatus([{ login: 'coderabbitai[bot]', state: 'changes_requested' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(false);
    expect(data.results[0].verdict).toBe('fail');
  });

  // ─── No CodeRabbit Review -> Pass (NONE) ────────────────────────────────

  it('handleCheckCoderabbit_NoReview_ReturnsPassedWithNone', async () => {
    const provider = createMockProvider({
      1: makeReviewStatus([{ login: 'some-human', state: 'approved' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results[0].state).toBe('NONE');
    expect(data.results[0].verdict).toBe('pass');
  });

  // ─── API Error -> Fail ──────────────────────────────────────────────────

  it('handleCheckCoderabbit_ApiError_ReturnsFailed', async () => {
    const provider = createMockProvider({}, new Set([1]));

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(false);
    expect(data.results[0].state).toBe('API_ERROR');
    expect(data.results[0].verdict).toBe('fail');
  });

  // ─── Missing Owner -> Error ─────────────────────────────────────────────

  it('handleCheckCoderabbit_MissingOwner_ReturnsError', async () => {
    const provider = createMockProvider();
    const result = await handleCheckCoderabbit(
      { owner: '', repo: 'app', prNumbers: [1] },
      provider,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('owner');
  });

  // ─── Invalid PR Number -> Skip ──────────────────────────────────────────

  it('handleCheckCoderabbit_InvalidPrNumber_ReturnsSkip', async () => {
    const provider = createMockProvider({
      5: makeReviewStatus([{ login: 'coderabbitai[bot]', state: 'approved' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [-1, 5] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results[0].pr).toBe(-1);
    expect(data.results[0].verdict).toBe('skip');
    expect(data.results[1].pr).toBe(5);
    expect(data.results[1].verdict).toBe('pass');
  });

  // ─── Report Contains Markdown Table ────────────────────────────────────

  it('handleCheckCoderabbit_ReportContainsMarkdownTable', async () => {
    const provider = createMockProvider({
      42: makeReviewStatus([{ login: 'coderabbitai[bot]', state: 'approved' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [42] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('## CodeRabbit Review Status');
    expect(data.report).toContain('acme/app');
    expect(data.report).toContain('| PR | State | Verdict |');
    expect(data.report).toContain('| #42 |');
    expect(data.report).toContain('PASS');
  });

  // ─── Alternative CodeRabbit Login Names ────────────────────────────────

  it('handleCheckCoderabbit_AlternativeLoginNames_Recognized', async () => {
    const provider = createMockProvider({
      1: makeReviewStatus([{ login: 'coderabbit-ai[bot]', state: 'approved' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results[0].state).toBe('APPROVED');
  });

  // ─── Pending Review -> Fail ─────────────────────────────────────────────

  it('handleCheckCoderabbit_PendingReview_ReturnsFailed', async () => {
    const provider = createMockProvider({
      1: makeReviewStatus([{ login: 'coderabbitai[bot]', state: 'pending' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(false);
    expect(data.results[0].verdict).toBe('fail');
  });
});

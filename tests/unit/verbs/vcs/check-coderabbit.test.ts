// ─── Check CodeRabbit Action Tests ──────────────────────────────────────────
//
// Tests use a mock VcsProvider instead of mocking execFileSync.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VcsProvider, ReviewStatus, ReviewerStatus } from '../../../../src/vcs/provider.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  handleCheckCoderabbit,
  CODERABBIT_REVIEWER_ABSENT,
} from '../../../../src/verbs/vcs/check-coderabbit.js';
import type { PrReviewResult } from '../../../../src/verbs/vcs/check-coderabbit.js';

/** The check's only documented consumer — synthesize step 4. */
const CONSUMER_DOC = fileURLToPath(
  new URL(
    '../../../../content/synthesis/skills/synthesize/references/synthesis-steps.md',
    import.meta.url,
  ),
);

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

  // ─── No CodeRabbit Review -> Indeterminate (NONE) ───────────────────────

  it('CodeRabbit_AbsentVendor_IsIndeterminate_NotPass', async () => {
    // A human approval is not this reviewer's approval. The check exists to
    // establish that CodeRabbit looked at the PR; nothing here establishes it,
    // so the absence yields no verdict rather than the pass it used to mint —
    // which read as coverage on every repository the reviewer does not watch.
    const provider = createMockProvider({
      1: makeReviewStatus([{ login: 'some-human', state: 'approved' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1] },
      provider,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      skipped?: boolean;
      discriminant?: string;
      reason?: string;
      report: string;
      results: PrReviewResult[];
    };
    expect(data.results[0].state).toBe('NONE');
    expect(data.results[0].verdict).toBe('indeterminate');
    expect(data.passed).toBe(false);
    // The skip descriptor is what makes the gate verdict `indeterminate` rather
    // than a `fail` naming a disproof nobody observed.
    expect(data.skipped).toBe(true);
    expect(data.discriminant).toBe('coderabbit-reviewer-absent');
    expect(data.reason).toContain('#1');
    expect(data.report).toContain('INDETERMINATE');

    const { normalizeGateVerdict } = await import('../../../../src/verbs/gates/gate-utils.js');
    expect(normalizeGateVerdict(result)).toBe('indeterminate');
  });

  it('CodeRabbit_RealFailureAlongsideAnAbsence_StaysAFailure', async () => {
    // A disproof is a conclusion. Stamping the carrier as skipped because some
    // OTHER PR went unmeasured would hide it behind an inconclusive verdict.
    const provider = createMockProvider({
      1: makeReviewStatus([{ login: 'coderabbitai[bot]', state: 'changes_requested' }]),
      2: makeReviewStatus([{ login: 'some-human', state: 'approved' }]),
    });

    const result = await handleCheckCoderabbit(
      { owner: 'acme', repo: 'app', prNumbers: [1, 2] },
      provider,
    );

    const data = result.data as { passed: boolean; skipped?: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.skipped).toBeUndefined();
    expect(data.report).toContain('FAIL');
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
    // A `skip` is a WITHDRAWN subject — the number cannot name a PR, so there
    // was never an obligation. It is not the same as an unmeasured one.
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

  // ─── The verdict has a reader ────────────────────────────────────────────

  it('TheConsumer_BranchesOnTheAbsentReviewer_RatherThanOnPassedAlone', async () => {
    // Withholding the pass is only half the fix. The single documented consumer
    // routes `passed: false` to the shepherd fix cycle — and no amount of
    // shepherding summons a review from a reviewer that is not installed, so an
    // unread indeterminate becomes an unfixable blocking failure on every
    // governed repository that does not use this vendor. The step has to know
    // the third outcome exists, and it has to name it by the discriminant the
    // carrier actually stamps.
    const doc = readFileSync(CONSUMER_DOC, 'utf-8');

    expect(
      doc.length,
      'the consumer document was not read — an empty result proves nothing',
    ).toBeGreaterThan(0);
    expect(
      doc,
      'synthesize step 4 must name the discriminant the carrier stamps, so a ' +
        'rename cannot leave the consumer reading a verdict that no longer exists',
    ).toContain(CODERABBIT_REVIEWER_ABSENT);
    // And it must say what to DO with it, which is not the fix cycle.
    expect(doc).toMatch(/skipped/i);
  });
});

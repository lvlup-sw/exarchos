// ─── Check CodeRabbit Action Tests ──────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';

// ─── Mock child_process ─────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

import { handleCheckCoderabbit } from './check-coderabbit.js';
import type { PrReviewResult } from './check-coderabbit.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const makeReview = (login: string, state: string, submitted_at: string) => ({
  user: { login },
  state,
  submitted_at,
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleCheckCoderabbit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── All PRs Approved ───────────────────────────────────────────────────

  it('handleCheckCoderabbit_AllApproved_ReturnsPassed', () => {
    const reviews = [
      makeReview('coderabbitai[bot]', 'APPROVED', '2026-01-15T10:00:00Z'),
    ];
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(reviews)));

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [1, 2] });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results).toHaveLength(2);
    expect(data.results[0].verdict).toBe('pass');
    expect(data.results[1].verdict).toBe('pass');
  });

  // ─── CHANGES_REQUESTED → Fail ──────────────────────────────────────────

  it('handleCheckCoderabbit_ChangesRequested_ReturnsFailed', () => {
    const reviews = [
      makeReview('coderabbitai[bot]', 'CHANGES_REQUESTED', '2026-01-15T10:00:00Z'),
    ];
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(reviews)));

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [1] });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(false);
    expect(data.results[0].state).toBe('CHANGES_REQUESTED');
    expect(data.results[0].verdict).toBe('fail');
  });

  // ─── PENDING → Fail ────────────────────────────────────────────────────

  it('handleCheckCoderabbit_Pending_ReturnsFailed', () => {
    const reviews = [
      makeReview('coderabbitai[bot]', 'PENDING', '2026-01-15T10:00:00Z'),
    ];
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(reviews)));

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [1] });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(false);
    expect(data.results[0].state).toBe('PENDING');
    expect(data.results[0].verdict).toBe('fail');
  });

  // ─── No CodeRabbit Review → Pass (NONE) ────────────────────────────────

  it('handleCheckCoderabbit_NoReview_ReturnsPassedWithNone', () => {
    const reviews = [
      makeReview('some-human', 'APPROVED', '2026-01-15T10:00:00Z'),
    ];
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(reviews)));

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [1] });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results[0].state).toBe('NONE');
    expect(data.results[0].verdict).toBe('pass');
  });

  // ─── Multiple Reviews, Latest Wins ─────────────────────────────────────

  it('handleCheckCoderabbit_MultipleReviews_LatestWins', () => {
    const reviews = [
      makeReview('coderabbitai[bot]', 'CHANGES_REQUESTED', '2026-01-15T08:00:00Z'),
      makeReview('coderabbitai[bot]', 'APPROVED', '2026-01-15T12:00:00Z'),
      makeReview('coderabbitai[bot]', 'PENDING', '2026-01-15T06:00:00Z'),
    ];
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(reviews)));

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [1] });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results[0].state).toBe('APPROVED');
    expect(data.results[0].verdict).toBe('pass');
  });

  // ─── API Error → Fail ──────────────────────────────────────────────────

  it('handleCheckCoderabbit_ApiError_ReturnsFailed', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('gh: command not found');
    });

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [1] });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(false);
    expect(data.results[0].state).toBe('API_ERROR');
    expect(data.results[0].verdict).toBe('fail');
  });

  // ─── Missing Owner → Error ─────────────────────────────────────────────

  it('handleCheckCoderabbit_MissingOwner_ReturnsError', () => {
    const result = handleCheckCoderabbit({ owner: '', repo: 'app', prNumbers: [1] });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('owner');
  });

  // ─── Invalid PR Number → Skip ──────────────────────────────────────────

  it('handleCheckCoderabbit_InvalidPrNumber_ReturnsSkip', () => {
    const reviews = [
      makeReview('coderabbitai[bot]', 'APPROVED', '2026-01-15T10:00:00Z'),
    ];
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(reviews)));

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [-1, 5] });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results[0].pr).toBe(-1);
    expect(data.results[0].verdict).toBe('skip');
    expect(data.results[1].pr).toBe(5);
    expect(data.results[1].verdict).toBe('pass');
  });

  // ─── Report Contains Markdown Table ────────────────────────────────────

  it('handleCheckCoderabbit_ReportContainsMarkdownTable', () => {
    const reviews = [
      makeReview('coderabbitai[bot]', 'APPROVED', '2026-01-15T10:00:00Z'),
    ];
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(reviews)));

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [42] });

    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('## CodeRabbit Review Status');
    expect(data.report).toContain('acme/app');
    expect(data.report).toContain('| PR | State | Verdict |');
    expect(data.report).toContain('| #42 | APPROVED | pass |');
    expect(data.report).toContain('PASS');
  });

  // ─── Alternative CodeRabbit Login Names ────────────────────────────────

  it('handleCheckCoderabbit_AlternativeLoginNames_Recognized', () => {
    const reviews = [
      makeReview('coderabbit-ai[bot]', 'APPROVED', '2026-01-15T10:00:00Z'),
    ];
    mockExecFileSync.mockReturnValue(Buffer.from(JSON.stringify(reviews)));

    const result = handleCheckCoderabbit({ owner: 'acme', repo: 'app', prNumbers: [1] });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; results: PrReviewResult[] };
    expect(data.passed).toBe(true);
    expect(data.results[0].state).toBe('APPROVED');
  });
});

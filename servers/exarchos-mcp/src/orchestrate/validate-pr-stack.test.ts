// ─── Validate PR Stack Handler Tests ────────────────────────────────────────
//
// Tests use a mock VcsProvider instead of mocking execFileSync.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { VcsProvider, PrSummary, PrFilter } from '../vcs/provider.js';
import { handleValidatePrStack } from './validate-pr-stack.js';

// ─── Mock VcsProvider Helper ────────────────────────────────────────────────

function createMockProvider(overrides: {
  listPrs?: PrSummary[];
  listPrsError?: Error;
} = {}): VcsProvider {
  return {
    name: 'github',
    createPr: vi.fn(),
    checkCi: vi.fn(),
    mergePr: vi.fn(),
    addComment: vi.fn(),
    getReviewStatus: vi.fn(),
    listPrs: overrides.listPrsError
      ? vi.fn().mockRejectedValue(overrides.listPrsError)
      : vi.fn<(filter?: PrFilter) => Promise<PrSummary[]>>().mockResolvedValue(overrides.listPrs ?? []),
    getPrComments: vi.fn(),
    getPrDiff: vi.fn(),
    createIssue: vi.fn(),
    getRepository: vi.fn(),
  };
}

describe('handleValidatePrStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('NoPRs_ReturnsPassedTrue', async () => {
    const provider = createMockProvider({ listPrs: [] });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; prCount: number; errors: readonly string[] };
    expect(data.passed).toBe(true);
    expect(data.prCount).toBe(0);
    expect(data.errors).toEqual([]);
  });

  it('ValidLinearChain_ReturnsPassedTrueWithVisualization', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 3, url: '', title: '', baseRefName: 'feat-b', headRefName: 'feat-c', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; prCount: number; report: string; errors: readonly string[] };
    expect(data.passed).toBe(true);
    expect(data.prCount).toBe(3);
    expect(data.errors).toEqual([]);
    expect(data.report).toContain('#1');
    expect(data.report).toContain('#2');
    expect(data.report).toContain('#3');
    expect(data.report).toContain('main');
    expect(data.report).toContain('feat-a');
    expect(data.report).toContain('feat-b');
    expect(data.report).toContain('feat-c');
  });

  it('PRBaseNotInStack_ReturnsPassedFalseWithError', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'orphan-branch', headRefName: 'feat-b', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
    expect(data.errors.some((e: string) => e.includes('#2') && e.includes('orphan-branch'))).toBe(true);
  });

  it('MultiplePRsTargetBase_ReturnsPassedFalse', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'main', headRefName: 'feat-b', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('Multiple PRs'))).toBe(true);
  });

  it('NoPRTargetsBase_ReturnsPassedFalse', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'feat-b', headRefName: 'feat-c', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('No PR targets'))).toBe(true);
  });

  it('ProviderFailure_ReturnsErrorResult', async () => {
    const provider = createMockProvider({
      listPrsError: new Error('gh: command not found'),
    });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('GH_CLI_ERROR');
  });

  it('ForkDetection_BranchUsedAsBaseByMultiplePRs', async () => {
    const prs: PrSummary[] = [
      { number: 1, url: '', title: '', baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, url: '', title: '', baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 3, url: '', title: '', baseRefName: 'feat-a', headRefName: 'feat-c', state: 'OPEN' },
    ];
    const provider = createMockProvider({ listPrs: prs });
    const result = await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('fork'))).toBe(true);
  });

  it('MissingBaseBranch_ReturnsError', async () => {
    const result = await handleValidatePrStack({ baseBranch: '' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INVALID_INPUT');
  });

  it('UsesProviderListPrs_WithStateOpenFilter', async () => {
    const provider = createMockProvider({ listPrs: [] });
    await handleValidatePrStack({ baseBranch: 'main' }, provider);

    expect(provider.listPrs).toHaveBeenCalledWith({ state: 'open' });
  });
});

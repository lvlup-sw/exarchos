import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { handleValidatePrStack } from './validate-pr-stack.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe('handleValidatePrStack', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('NoPRs_ReturnsPassedTrue', () => {
    mockedExecFileSync.mockReturnValue(JSON.stringify([]));

    const result = handleValidatePrStack({ baseBranch: 'main' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; prCount: number; errors: readonly string[] };
    expect(data.passed).toBe(true);
    expect(data.prCount).toBe(0);
    expect(data.errors).toEqual([]);
  });

  it('ValidLinearChain_ReturnsPassedTrueWithVisualization', () => {
    const prs = [
      { number: 1, baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 3, baseRefName: 'feat-b', headRefName: 'feat-c', state: 'OPEN' },
    ];
    mockedExecFileSync.mockReturnValue(JSON.stringify(prs));

    const result = handleValidatePrStack({ baseBranch: 'main' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; prCount: number; report: string; errors: readonly string[] };
    expect(data.passed).toBe(true);
    expect(data.prCount).toBe(3);
    expect(data.errors).toEqual([]);
    // Report should contain chain visualization
    expect(data.report).toContain('#1');
    expect(data.report).toContain('#2');
    expect(data.report).toContain('#3');
    expect(data.report).toContain('main');
    expect(data.report).toContain('feat-a');
    expect(data.report).toContain('feat-b');
    expect(data.report).toContain('feat-c');
  });

  it('PRBaseNotInStack_ReturnsPassedFalseWithError', () => {
    const prs = [
      { number: 1, baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, baseRefName: 'orphan-branch', headRefName: 'feat-b', state: 'OPEN' },
    ];
    mockedExecFileSync.mockReturnValue(JSON.stringify(prs));

    const result = handleValidatePrStack({ baseBranch: 'main' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
    expect(data.errors.some((e: string) => e.includes('#2') && e.includes('orphan-branch'))).toBe(true);
  });

  it('MultiplePRsTargetBase_ReturnsPassedFalse', () => {
    const prs = [
      { number: 1, baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, baseRefName: 'main', headRefName: 'feat-b', state: 'OPEN' },
    ];
    mockedExecFileSync.mockReturnValue(JSON.stringify(prs));

    const result = handleValidatePrStack({ baseBranch: 'main' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('Multiple PRs'))).toBe(true);
  });

  it('NoPRTargetsBase_ReturnsPassedFalse', () => {
    const prs = [
      { number: 1, baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 2, baseRefName: 'feat-b', headRefName: 'feat-c', state: 'OPEN' },
    ];
    mockedExecFileSync.mockReturnValue(JSON.stringify(prs));

    const result = handleValidatePrStack({ baseBranch: 'main' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('No PR targets'))).toBe(true);
  });

  it('GhCliFailure_ReturnsErrorResult', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('gh: command not found');
    });

    const result = handleValidatePrStack({ baseBranch: 'main' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('GH_CLI_ERROR');
  });

  it('ForkDetection_BranchUsedAsBaseByMultiplePRs', () => {
    const prs = [
      { number: 1, baseRefName: 'main', headRefName: 'feat-a', state: 'OPEN' },
      { number: 2, baseRefName: 'feat-a', headRefName: 'feat-b', state: 'OPEN' },
      { number: 3, baseRefName: 'feat-a', headRefName: 'feat-c', state: 'OPEN' },
    ];
    mockedExecFileSync.mockReturnValue(JSON.stringify(prs));

    const result = handleValidatePrStack({ baseBranch: 'main' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; errors: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.errors.some((e: string) => e.includes('fork'))).toBe(true);
  });

  it('MissingBaseBranch_ReturnsError', () => {
    const result = handleValidatePrStack({ baseBranch: '' });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('INVALID_INPUT');
  });
});

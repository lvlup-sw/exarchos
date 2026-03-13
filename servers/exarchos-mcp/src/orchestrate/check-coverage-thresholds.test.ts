// ─── Check Coverage Thresholds Tests ─────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { handleCheckCoverageThresholds } from './check-coverage-thresholds.js';

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeCoverageSummary = (lines: number, branches: number, functions: number) =>
  JSON.stringify({
    total: {
      lines: { total: 100, covered: lines, skipped: 0, pct: lines },
      branches: { total: 100, covered: branches, skipped: 0, pct: branches },
      functions: { total: 100, covered: functions, skipped: 0, pct: functions },
      statements: { total: 100, covered: 90, skipped: 0, pct: 90 },
    },
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleCheckCoverageThresholds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('handleCheckCoverageThresholds_AllAbove_ReturnsPassed', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(95, 85, 100));

    const result = handleCheckCoverageThresholds({ coverageFile: '/tmp/coverage.json' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; coverage: { lines: number; branches: number; functions: number } };
    expect(data.passed).toBe(true);
    expect(data.coverage.lines).toBe(95);
    expect(data.coverage.branches).toBe(85);
    expect(data.coverage.functions).toBe(100);
  });

  it('handleCheckCoverageThresholds_LineBelowThreshold_ReturnsFailed', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(50, 85, 100));

    const result = handleCheckCoverageThresholds({ coverageFile: '/tmp/coverage.json' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(false);
  });

  it('handleCheckCoverageThresholds_BranchBelowThreshold_ReturnsFailed', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(95, 50, 100));

    const result = handleCheckCoverageThresholds({ coverageFile: '/tmp/coverage.json' });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(false);
  });

  it('handleCheckCoverageThresholds_MissingCoverageFile_ReturnsError', () => {
    mockedFs.existsSync.mockReturnValue(false);

    const result = handleCheckCoverageThresholds({ coverageFile: '/tmp/missing.json' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
  });

  it('handleCheckCoverageThresholds_InvalidJson_ReturnsError', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('not valid json {{{');

    const result = handleCheckCoverageThresholds({ coverageFile: '/tmp/bad.json' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_JSON');
  });

  it('handleCheckCoverageThresholds_ReportContainsMarkdownTable', () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(95, 85, 100));

    const result = handleCheckCoverageThresholds({ coverageFile: '/tmp/coverage.json' });

    const data = result.data as { report: string };
    expect(data.report).toContain('| Metric');
    expect(data.report).toContain('| lines');
    expect(data.report).toContain('| branches');
    expect(data.report).toContain('| functions');
    expect(data.report).toContain('PASS');
  });

  it('handleCheckCoverageThresholds_DefaultThresholds', () => {
    mockedFs.existsSync.mockReturnValue(true);
    // lines=80 (exactly at default threshold), branches=70 (exactly), functions=100 (exactly)
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(80, 70, 100));

    const result = handleCheckCoverageThresholds({ coverageFile: '/tmp/coverage.json' });

    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
  });
});

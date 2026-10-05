// These cases test the provider verdict, so the gate-runner stub calls only the provider.
// `unrunbooked-gate-evidence-dispatch.test.ts` proves the recorded evidence over real dispatch.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { handleCheckCoverageThresholds } from '../../../../src/verbs/gates/check-coverage-thresholds.js';
import type { EventStore } from '../../../../src/events/store.js';

vi.mock('node:fs');
vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
}));

const STATE_DIR = '/tmp/test-check-coverage-thresholds';
const FEATURE_ID = 'coverage-feature';
const eventStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
} as unknown as EventStore;


const mockedFs = vi.mocked(fs);

const makeCoverageSummary = (lines: number, branches: number, functions: number) =>
  JSON.stringify({
    total: {
      lines: { total: 100, covered: lines, skipped: 0, pct: lines },
      branches: { total: 100, covered: branches, skipped: 0, pct: branches },
      functions: { total: 100, covered: functions, skipped: 0, pct: functions },
      statements: { total: 100, covered: 90, skipped: 0, pct: 90 },
    },
  });

describe('handleCheckCoverageThresholds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('handleCheckCoverageThresholds_AllAbove_ReturnsPassed', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(95, 85, 100));

    const result = await handleCheckCoverageThresholds({ featureId: FEATURE_ID, coverageFile: '/tmp/coverage.json' }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; coverage: { lines: number; branches: number; functions: number } };
    expect(data.passed).toBe(true);
    expect(data.coverage.lines).toBe(95);
    expect(data.coverage.branches).toBe(85);
    expect(data.coverage.functions).toBe(100);
  });

  it('handleCheckCoverageThresholds_LineBelowThreshold_ReturnsFailed', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(50, 85, 100));

    const result = await handleCheckCoverageThresholds({ featureId: FEATURE_ID, coverageFile: '/tmp/coverage.json' }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(false);
  });

  it('handleCheckCoverageThresholds_BranchBelowThreshold_ReturnsFailed', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(95, 50, 100));

    const result = await handleCheckCoverageThresholds({ featureId: FEATURE_ID, coverageFile: '/tmp/coverage.json' }, STATE_DIR, eventStore);

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(false);
  });

  it('handleCheckCoverageThresholds_MissingCoverageFile_ReturnsError', async () => {
    mockedFs.existsSync.mockReturnValue(false);

    const result = await handleCheckCoverageThresholds({ featureId: FEATURE_ID, coverageFile: '/tmp/missing.json' }, STATE_DIR, eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FILE_NOT_FOUND');
  });

  it('handleCheckCoverageThresholds_InvalidJson_ReturnsError', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue('not valid json {{{');

    const result = await handleCheckCoverageThresholds({ featureId: FEATURE_ID, coverageFile: '/tmp/bad.json' }, STATE_DIR, eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_JSON');
  });

  it('handleCheckCoverageThresholds_ReportContainsMarkdownTable', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(95, 85, 100));

    const result = await handleCheckCoverageThresholds({ featureId: FEATURE_ID, coverageFile: '/tmp/coverage.json' }, STATE_DIR, eventStore);

    const data = result.data as { report: string };
    expect(data.report).toContain('| Metric');
    expect(data.report).toContain('| lines');
    expect(data.report).toContain('| branches');
    expect(data.report).toContain('| functions');
    expect(data.report).toContain('PASS');
  });

  /** Each value equals its default threshold: lines 80, branches 70, functions 100. */
  it('handleCheckCoverageThresholds_DefaultThresholds', async () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(makeCoverageSummary(80, 70, 100));

    const result = await handleCheckCoverageThresholds({ featureId: FEATURE_ID, coverageFile: '/tmp/coverage.json' }, STATE_DIR, eventStore);

    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
  });
});

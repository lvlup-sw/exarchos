import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { RunSummary, EvalResult } from '../evals/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../views/tools.js', () => ({
  getOrCreateEventStore: vi.fn().mockReturnValue({
    query: vi.fn().mockResolvedValue([]),
  }),
  getOrCreateMaterializer: vi.fn().mockReturnValue({
    materialize: vi.fn().mockReturnValue({ skills: {}, runs: [], regressions: [] }),
    getState: vi.fn().mockReturnValue(undefined),
    loadFromSnapshot: vi.fn().mockResolvedValue(false),
  }),
}));

import { handleEvalCompare } from './eval-compare.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeResult(
  caseId: string,
  passed: boolean,
  score: number = passed ? 1.0 : 0.0,
): EvalResult {
  return {
    caseId,
    suiteId: 'test-suite',
    passed,
    score,
    assertions: [
      {
        name: 'check',
        type: 'exact-match',
        passed,
        score,
        reason: passed ? 'Match' : 'Mismatch',
        threshold: 1.0,
        skipped: false,
      },
    ],
    duration: 10,
  };
}

function makeSummary(
  runId: string,
  results: EvalResult[],
): RunSummary {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const avgScore = results.length > 0
    ? results.reduce((sum, r) => sum + r.score, 0) / results.length
    : 0;

  return {
    runId,
    suiteId: 'test-suite',
    total: results.length,
    passed,
    failed,
    skipped: 0,
    avgScore,
    duration: 100,
    results,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleEvalCompare', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-compare-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('handleEvalCompare_TwoRuns_OutputsComparisonReport', async () => {
    // Arrange — write two run summary JSONL files
    const baselineSummary = makeSummary('run-1', [
      makeResult('c-1', true, 1.0),
      makeResult('c-2', true, 0.8),
    ]);
    const candidateSummary = makeSummary('run-2', [
      makeResult('c-1', true, 1.0),
      makeResult('c-2', true, 0.9),
    ]);

    const baselineFile = path.join(tmpDir, 'baseline.json');
    const candidateFile = path.join(tmpDir, 'candidate.json');
    await fs.writeFile(baselineFile, JSON.stringify(baselineSummary), 'utf-8');
    await fs.writeFile(candidateFile, JSON.stringify(candidateSummary), 'utf-8');

    // Act
    const result = await handleEvalCompare(
      { baseline: baselineFile, candidate: candidateFile },
      tmpDir,
    );

    // Assert
    expect(result.error).toBeUndefined();
    expect(result.verdict).toBe('safe');
    expect(result.report).toBeDefined();
  });

  it('handleEvalCompare_RegressionsFound_VerdictUnsafe', async () => {
    // Arrange — baseline c-1 passes, candidate c-1 fails
    const baselineSummary = makeSummary('run-1', [
      makeResult('c-1', true, 1.0),
    ]);
    const candidateSummary = makeSummary('run-2', [
      makeResult('c-1', false, 0.0),
    ]);

    const baselineFile = path.join(tmpDir, 'baseline.json');
    const candidateFile = path.join(tmpDir, 'candidate.json');
    await fs.writeFile(baselineFile, JSON.stringify(baselineSummary), 'utf-8');
    await fs.writeFile(candidateFile, JSON.stringify(candidateSummary), 'utf-8');

    // Act
    const result = await handleEvalCompare(
      { baseline: baselineFile, candidate: candidateFile },
      tmpDir,
    );

    // Assert
    expect(result.verdict).toBe('regressions-detected');
    const report = result.report as Record<string, unknown>;
    const regressions = report.regressions as Array<{ caseId: string }>;
    expect(regressions).toHaveLength(1);
    expect(regressions[0].caseId).toBe('c-1');
  });

  it('handleEvalCompare_NoRegressions_VerdictSafe', async () => {
    // Arrange — all cases still pass
    const baselineSummary = makeSummary('run-1', [
      makeResult('c-1', true, 1.0),
      makeResult('c-2', true, 0.8),
    ]);
    const candidateSummary = makeSummary('run-2', [
      makeResult('c-1', true, 1.0),
      makeResult('c-2', true, 0.9),
    ]);

    const baselineFile = path.join(tmpDir, 'baseline.json');
    const candidateFile = path.join(tmpDir, 'candidate.json');
    await fs.writeFile(baselineFile, JSON.stringify(baselineSummary), 'utf-8');
    await fs.writeFile(candidateFile, JSON.stringify(candidateSummary), 'utf-8');

    // Act
    const result = await handleEvalCompare(
      { baseline: baselineFile, candidate: candidateFile },
      tmpDir,
    );

    // Assert
    expect(result.verdict).toBe('safe');
    const report = result.report as Record<string, unknown>;
    const regressions = report.regressions as unknown[];
    expect(regressions).toHaveLength(0);
  });
});

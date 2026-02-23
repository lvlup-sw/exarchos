import { describe, it, expect } from 'vitest';
import { compareRuns, type ComparisonReport } from './comparison.js';
import type { RunSummary, EvalResult } from './types.js';

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

describe('compareRuns', () => {
  it('compareRuns_Regression_IdentifiesPassedToFailed', () => {
    // Arrange — baseline: c-1 passes; candidate: c-1 fails
    const baseline = makeSummary('run-1', [
      makeResult('c-1', true, 1.0),
      makeResult('c-2', true, 1.0),
    ]);
    const candidate = makeSummary('run-2', [
      makeResult('c-1', false, 0.0),
      makeResult('c-2', true, 1.0),
    ]);

    // Act
    const report = compareRuns(baseline, candidate);

    // Assert
    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0].caseId).toBe('c-1');
    expect(report.verdict).toBe('regressions-detected');
  });

  it('compareRuns_Improvement_IdentifiesFailedToPassed', () => {
    // Arrange — baseline: c-1 fails; candidate: c-1 passes
    const baseline = makeSummary('run-1', [
      makeResult('c-1', false, 0.0),
      makeResult('c-2', true, 1.0),
    ]);
    const candidate = makeSummary('run-2', [
      makeResult('c-1', true, 1.0),
      makeResult('c-2', true, 1.0),
    ]);

    // Act
    const report = compareRuns(baseline, candidate);

    // Assert
    expect(report.improvements).toHaveLength(1);
    expect(report.improvements[0].caseId).toBe('c-1');
    expect(report.verdict).toBe('safe');
  });

  it('compareRuns_ScoreDelta_CalculatesCorrectly', () => {
    // Arrange — both pass but with different scores
    const baseline = makeSummary('run-1', [
      makeResult('c-1', true, 0.8),
      makeResult('c-2', true, 0.6),
    ]);
    const candidate = makeSummary('run-2', [
      makeResult('c-1', true, 0.9),
      makeResult('c-2', true, 0.4),
    ]);

    // Act
    const report = compareRuns(baseline, candidate);

    // Assert
    expect(report.scoreDeltas).toHaveLength(2);
    const c1Delta = report.scoreDeltas.find((d) => d.caseId === 'c-1');
    const c2Delta = report.scoreDeltas.find((d) => d.caseId === 'c-2');
    expect(c1Delta).toBeDefined();
    expect(c2Delta).toBeDefined();
    expect(c1Delta!.delta).toBeCloseTo(0.1, 5);
    expect(c2Delta!.delta).toBeCloseTo(-0.2, 5);
  });

  it('compareRuns_NewCases_MarkedAsNew', () => {
    // Arrange — candidate has a case that baseline does not
    const baseline = makeSummary('run-1', [
      makeResult('c-1', true, 1.0),
    ]);
    const candidate = makeSummary('run-2', [
      makeResult('c-1', true, 1.0),
      makeResult('c-new', true, 1.0),
    ]);

    // Act
    const report = compareRuns(baseline, candidate);

    // Assert
    expect(report.newCases).toHaveLength(1);
    expect(report.newCases[0].caseId).toBe('c-new');
  });

  it('compareRuns_RemovedCases_MarkedAsRemoved', () => {
    // Arrange — baseline has a case that candidate does not
    const baseline = makeSummary('run-1', [
      makeResult('c-1', true, 1.0),
      makeResult('c-removed', true, 1.0),
    ]);
    const candidate = makeSummary('run-2', [
      makeResult('c-1', true, 1.0),
    ]);

    // Act
    const report = compareRuns(baseline, candidate);

    // Assert
    expect(report.removedCases).toHaveLength(1);
    expect(report.removedCases[0].caseId).toBe('c-removed');
  });
});

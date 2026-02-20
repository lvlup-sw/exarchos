import { describe, it, expect } from 'vitest';
import { formatRunSummary, formatMultiSuiteReport } from './cli-reporter.js';
import type { RunSummary, EvalResult } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<EvalResult> & { caseId: string }): EvalResult {
  return {
    suiteId: 'test-suite',
    passed: true,
    score: 1.0,
    assertions: [],
    duration: 50,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<RunSummary> & { suiteId: string }): RunSummary {
  const results = overrides.results ?? [];
  const total = overrides.total ?? results.length;
  const passed = overrides.passed ?? results.filter((r) => r.passed).length;
  const failed = overrides.failed ?? results.filter((r) => !r.passed).length;
  return {
    runId: 'run-001',
    total,
    passed,
    failed,
    avgScore: overrides.avgScore ?? (results.length > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / results.length
      : 0),
    duration: overrides.duration ?? 100,
    results,
    ...overrides,
  };
}

// ─── formatRunSummary ───────────────────────────────────────────────────────

describe('formatRunSummary', () => {
  it('FormatRunSummary_AllPassed_ShowsCheckmarks', () => {
    // Arrange
    const summary = makeSummary({
      suiteId: 'my-suite',
      results: [
        makeResult({ caseId: 'c-1', passed: true, score: 1.0 }),
        makeResult({ caseId: 'c-2', passed: true, score: 0.9 }),
      ],
    });

    // Act
    const output = formatRunSummary(summary);

    // Assert
    expect(output).toContain('\u2713'); // checkmark
    expect(output).not.toContain('\u2717'); // X mark
  });

  it('FormatRunSummary_FailedCase_ShowsXAndReasons', () => {
    // Arrange
    const summary = makeSummary({
      suiteId: 'my-suite',
      results: [
        makeResult({
          caseId: 'c-1',
          passed: false,
          score: 0.3,
          assertions: [
            {
              name: 'check-1',
              type: 'exact-match',
              passed: false,
              score: 0.3,
              reason: 'Mismatched fields: output',
              threshold: 1.0,
            },
          ],
        }),
      ],
    });

    // Act
    const output = formatRunSummary(summary);

    // Assert
    expect(output).toContain('\u2717'); // X mark
    expect(output).toContain('\u2514\u2500'); // L-shaped connector
    expect(output).toContain('Mismatched fields: output');
  });

  it('FormatRunSummary_ContainsSuiteHeader', () => {
    // Arrange
    const summary = makeSummary({
      suiteId: 'delegation',
      results: [],
      total: 0,
      passed: 0,
      failed: 0,
    });

    // Act
    const output = formatRunSummary(summary);

    // Assert
    expect(output).toContain('delegation');
    expect(output).toContain('\u2500\u2500'); // horizontal line
  });

  it('FormatRunSummary_ContainsFooterTotals', () => {
    // Arrange
    const summary = makeSummary({
      suiteId: 'test-suite',
      total: 5,
      passed: 3,
      failed: 2,
      avgScore: 0.75,
      duration: 2500,
      results: [
        makeResult({ caseId: 'c-1', passed: true, score: 1.0 }),
        makeResult({ caseId: 'c-2', passed: true, score: 0.9 }),
        makeResult({ caseId: 'c-3', passed: true, score: 0.8 }),
        makeResult({ caseId: 'c-4', passed: false, score: 0.3 }),
        makeResult({ caseId: 'c-5', passed: false, score: 0.25 }),
      ],
    });

    // Act
    const output = formatRunSummary(summary);

    // Assert
    expect(output).toContain('5 cases');
    expect(output).toContain('3 passed');
    expect(output).toContain('2 failed');
    expect(output).toContain('2500ms');
  });

  it('FormatRunSummary_EmptyResults_ShowsZeroSummary', () => {
    // Arrange
    const summary = makeSummary({
      suiteId: 'empty-suite',
      total: 0,
      passed: 0,
      failed: 0,
      avgScore: 0,
      duration: 10,
      results: [],
    });

    // Act
    const output = formatRunSummary(summary);

    // Assert
    expect(output).toContain('0 cases');
    expect(output).toContain('0 passed');
    expect(output).toContain('0 failed');
  });
});

// ─── formatMultiSuiteReport ─────────────────────────────────────────────────

describe('formatMultiSuiteReport', () => {
  it('FormatMultiSuiteReport_MultipleSuites_ShowsAllSections', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        results: [makeResult({ caseId: 'c-1', passed: true })],
      }),
      makeSummary({
        suiteId: 'quality-review',
        results: [makeResult({ caseId: 'c-2', passed: false, score: 0.5 })],
      }),
    ];

    // Act
    const output = formatMultiSuiteReport(summaries);

    // Assert
    expect(output).toContain('delegation');
    expect(output).toContain('quality-review');
  });

  it('FormatMultiSuiteReport_ContainsGrandTotal', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'suite-a',
        total: 3,
        passed: 2,
        failed: 1,
        results: [
          makeResult({ caseId: 'a-1', passed: true }),
          makeResult({ caseId: 'a-2', passed: true }),
          makeResult({ caseId: 'a-3', passed: false, score: 0.0 }),
        ],
      }),
      makeSummary({
        suiteId: 'suite-b',
        total: 2,
        passed: 2,
        failed: 0,
        results: [
          makeResult({ caseId: 'b-1', passed: true }),
          makeResult({ caseId: 'b-2', passed: true }),
        ],
      }),
    ];

    // Act
    const output = formatMultiSuiteReport(summaries);

    // Assert
    // Grand total: 5 total, 4 passed, 1 failed
    expect(output).toContain('5 cases');
    expect(output).toContain('4 passed');
    expect(output).toContain('1 failed');
  });

  it('FormatMultiSuiteReport_SingleSuite_NoGrandTotal', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'only-one',
        total: 2,
        passed: 2,
        failed: 0,
        results: [
          makeResult({ caseId: 'c-1', passed: true }),
          makeResult({ caseId: 'c-2', passed: true }),
        ],
      }),
    ];

    // Act
    const output = formatMultiSuiteReport(summaries);

    // Assert
    expect(output).toContain('only-one');
    // Should not have a grand total section — count occurrences of "cases"
    // The single suite has its own footer; there should be exactly one occurrence of "2 cases"
    const caseOccurrences = output.split('2 cases').length - 1;
    expect(caseOccurrences).toBe(1);
  });
});

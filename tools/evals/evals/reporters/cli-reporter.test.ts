import { describe, it, expect } from 'vitest';
import { formatRunSummary, formatMultiSuiteReport } from './cli-reporter.js';
import type { RunSummary, EvalResult } from '../types.js';

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

describe('formatRunSummary', () => {
  it('FormatRunSummary_AllPassed_ShowsCheckmarks', () => {
    const summary = makeSummary({
      suiteId: 'my-suite',
      results: [
        makeResult({ caseId: 'c-1', passed: true, score: 1.0 }),
        makeResult({ caseId: 'c-2', passed: true, score: 0.9 }),
      ],
    });

    const output = formatRunSummary(summary);

    expect(output).toContain('\u2713');
    expect(output).not.toContain('\u2717');
  });

  /** A failed case shows the X mark, and its reason after an L-shaped box-drawing connector. */
  it('FormatRunSummary_FailedCase_ShowsXAndReasons', () => {
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

    const output = formatRunSummary(summary);

    expect(output).toContain('\u2717');
    expect(output).toContain('\u2514\u2500');
    expect(output).toContain('Mismatched fields: output');
  });

  /** The suite header holds the suite name and a horizontal box-drawing line. */
  it('FormatRunSummary_ContainsSuiteHeader', () => {
    const summary = makeSummary({
      suiteId: 'delegation',
      results: [],
      total: 0,
      passed: 0,
      failed: 0,
    });

    const output = formatRunSummary(summary);

    expect(output).toContain('delegation');
    expect(output).toContain('\u2500\u2500');
  });

  it('FormatRunSummary_ContainsFooterTotals', () => {
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

    const output = formatRunSummary(summary);

    expect(output).toContain('5 cases');
    expect(output).toContain('3 passed');
    expect(output).toContain('2 failed');
    expect(output).toContain('2500ms');
  });

  it('FormatRunSummary_EmptyResults_ShowsZeroSummary', () => {
    const summary = makeSummary({
      suiteId: 'empty-suite',
      total: 0,
      passed: 0,
      failed: 0,
      avgScore: 0,
      duration: 10,
      results: [],
    });

    const output = formatRunSummary(summary);

    expect(output).toContain('0 cases');
    expect(output).toContain('0 passed');
    expect(output).toContain('0 failed');
  });
});

describe('formatMultiSuiteReport', () => {
  it('FormatMultiSuiteReport_MultipleSuites_ShowsAllSections', () => {
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

    const output = formatMultiSuiteReport(summaries);

    expect(output).toContain('delegation');
    expect(output).toContain('quality-review');
  });

  it('FormatMultiSuiteReport_ContainsGrandTotal', () => {
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

    const output = formatMultiSuiteReport(summaries);

    expect(output).toContain('5 cases');
    expect(output).toContain('4 passed');
    expect(output).toContain('1 failed');
  });

  /** One suite has its own footer and no grand total, so `2 cases` appears once. */
  it('FormatMultiSuiteReport_SingleSuite_NoGrandTotal', () => {
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

    const output = formatMultiSuiteReport(summaries);

    expect(output).toContain('only-one');
    const caseOccurrences = output.split('2 cases').length - 1;
    expect(caseOccurrences).toBe(1);
  });
});

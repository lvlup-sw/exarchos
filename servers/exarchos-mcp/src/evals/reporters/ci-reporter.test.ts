import { describe, it, expect } from 'vitest';
import { formatCIReport, formatFailedAssertions } from './ci-reporter.js';
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

// ─── formatCIReport ─────────────────────────────────────────────────────────

describe('formatCIReport', () => {
  it('formatCIReport_AllPassing_ReturnsNoticeAnnotations', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        avgScore: 1.0,
        results: [
          makeResult({ caseId: 'c-1', passed: true, score: 1.0 }),
          makeResult({ caseId: 'c-2', passed: true, score: 1.0 }),
        ],
      }),
    ];

    // Act
    const output = formatCIReport(summaries);

    // Assert
    expect(output).toContain('::notice');
    expect(output).not.toContain('::error');
  });

  it('formatCIReport_WithFailures_ReturnsErrorAnnotations', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        avgScore: 0.5,
        results: [
          makeResult({ caseId: 'c-1', passed: true, score: 1.0 }),
          makeResult({
            caseId: 'c-2',
            passed: false,
            score: 0.0,
            assertions: [
              { name: 'check-1', type: 'exact-match', passed: false, score: 0.0, reason: 'mismatch', threshold: 1.0 },
            ],
          }),
        ],
      }),
    ];

    // Act
    const output = formatCIReport(summaries);

    // Assert
    expect(output).toContain('::error');
    expect(output).toContain('::notice');
  });

  it('formatCIReport_ErrorAnnotation_IncludesCaseId', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        avgScore: 0.0,
        results: [
          makeResult({
            caseId: 'delegate-task-routing',
            passed: false,
            score: 0.0,
            assertions: [
              { name: 'check-1', type: 'exact-match', passed: false, score: 0.0, reason: 'wrong', threshold: 1.0 },
            ],
          }),
        ],
      }),
    ];

    // Act
    const output = formatCIReport(summaries);

    // Assert
    expect(output).toContain('delegate-task-routing');
    const errorLine = output.split('\n').find((l) => l.startsWith('::error'));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('title=Eval Regression: delegate-task-routing');
  });

  it('formatCIReport_ErrorAnnotation_IncludesFailedAssertionReasons', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        avgScore: 0.0,
        results: [
          makeResult({
            caseId: 'c-1',
            passed: false,
            score: 0.0,
            assertions: [
              { name: 'tool-call', type: 'tool-call', passed: false, score: 0.0, reason: 'Expected exarchos_orchestrate', threshold: 1.0 },
            ],
          }),
        ],
      }),
    ];

    // Act
    const output = formatCIReport(summaries);

    // Assert
    const errorLine = output.split('\n').find((l) => l.startsWith('::error'));
    expect(errorLine).toContain('Expected exarchos_orchestrate');
  });

  it('formatCIReport_NoticeAnnotation_IncludesPassCount', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        total: 5,
        passed: 3,
        failed: 2,
        avgScore: 0.6,
        results: [],
      }),
    ];

    // Act
    const output = formatCIReport(summaries);

    // Assert
    const noticeLine = output.split('\n').find((l) => l.startsWith('::notice'));
    expect(noticeLine).toBeDefined();
    expect(noticeLine).toContain('3/5 passed');
  });

  it('formatCIReport_NoticeAnnotation_IncludesScorePercentage', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        avgScore: 0.857,
        results: [],
      }),
    ];

    // Act
    const output = formatCIReport(summaries);

    // Assert
    const noticeLine = output.split('\n').find((l) => l.startsWith('::notice'));
    expect(noticeLine).toBeDefined();
    expect(noticeLine).toContain('85.7%');
  });

  it('formatCIReport_MultipleSuites_ReportsEachSuite', () => {
    // Arrange
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        avgScore: 1.0,
        results: [makeResult({ caseId: 'c-1', passed: true })],
      }),
      makeSummary({
        suiteId: 'quality-review',
        avgScore: 0.8,
        results: [makeResult({ caseId: 'c-2', passed: true })],
      }),
    ];

    // Act
    const output = formatCIReport(summaries);

    // Assert
    const noticeLines = output.split('\n').filter((l) => l.startsWith('::notice'));
    expect(noticeLines).toHaveLength(2);
    expect(noticeLines[0]).toContain('delegation');
    expect(noticeLines[1]).toContain('quality-review');
  });

  it('formatCIReport_EmptySummaries_ReturnsEmptyString', () => {
    // Arrange & Act
    const output = formatCIReport([]);

    // Assert
    expect(output).toBe('');
  });
});

// ─── formatFailedAssertions ─────────────────────────────────────────────────

describe('formatFailedAssertions', () => {
  it('formatFailedAssertions_SingleFailure_FormatsReason', () => {
    // Arrange
    const result = makeResult({
      caseId: 'c-1',
      passed: false,
      score: 0.0,
      assertions: [
        { name: 'tool-call', type: 'tool-call', passed: false, score: 0.0, reason: 'Missing tool invocation', threshold: 1.0 },
      ],
    });

    // Act
    const output = formatFailedAssertions(result);

    // Assert
    expect(output).toBe('tool-call: Missing tool invocation');
  });

  it('formatFailedAssertions_MultipleFailures_JoinsReasons', () => {
    // Arrange
    const result = makeResult({
      caseId: 'c-1',
      passed: false,
      score: 0.0,
      assertions: [
        { name: 'exact-match', type: 'exact-match', passed: false, score: 0.0, reason: 'Field mismatch', threshold: 1.0 },
        { name: 'schema', type: 'schema', passed: false, score: 0.0, reason: 'Invalid structure', threshold: 1.0 },
        { name: 'passing-one', type: 'exact-match', passed: true, score: 1.0, reason: 'OK', threshold: 1.0 },
      ],
    });

    // Act
    const output = formatFailedAssertions(result);

    // Assert
    expect(output).toBe('exact-match: Field mismatch; schema: Invalid structure');
    expect(output).not.toContain('passing-one');
  });
});

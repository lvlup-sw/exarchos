import { describe, it, expect } from 'vitest';
import { formatCIReport, formatFailedAssertions, escapeCommandValue, escapeCommandProperty } from './ci-reporter.js';
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

describe('formatCIReport', () => {
  it('formatCIReport_AllPassing_ReturnsNoticeAnnotations', () => {
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

    const output = formatCIReport(summaries);

    expect(output).toContain('::notice');
    expect(output).not.toContain('::error');
  });

  it('formatCIReport_WithFailures_ReturnsErrorAnnotations', () => {
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

    const output = formatCIReport(summaries);

    expect(output).toContain('::error');
    expect(output).toContain('::notice');
  });

  it('formatCIReport_ErrorAnnotation_IncludesCaseId', () => {
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

    const output = formatCIReport(summaries);

    expect(output).toContain('delegate-task-routing');
    const errorLine = output.split('\n').find((l) => l.startsWith('::error'));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('title=Eval Regression%3A delegate-task-routing');
  });

  it('formatCIReport_ErrorAnnotation_IncludesFailedAssertionReasons', () => {
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

    const output = formatCIReport(summaries);

    const errorLine = output.split('\n').find((l) => l.startsWith('::error'));
    expect(errorLine).toContain('Expected exarchos_orchestrate');
  });

  it('formatCIReport_NoticeAnnotation_IncludesPassCount', () => {
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

    const output = formatCIReport(summaries);

    const noticeLine = output.split('\n').find((l) => l.startsWith('::notice'));
    expect(noticeLine).toBeDefined();
    expect(noticeLine).toContain('3/5 passed');
  });

  it('formatCIReport_NoticeAnnotation_IncludesScorePercentage', () => {
    const summaries = [
      makeSummary({
        suiteId: 'delegation',
        avgScore: 0.857,
        results: [],
      }),
    ];

    const output = formatCIReport(summaries);

    const noticeLine = output.split('\n').find((l) => l.startsWith('::notice'));
    expect(noticeLine).toBeDefined();
    expect(noticeLine).toContain('85.7%');
  });

  it('formatCIReport_MultipleSuites_ReportsEachSuite', () => {
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

    const output = formatCIReport(summaries);

    const noticeLines = output.split('\n').filter((l) => l.startsWith('::notice'));
    expect(noticeLines).toHaveLength(2);
    expect(noticeLines[0]).toContain('delegation');
    expect(noticeLines[1]).toContain('quality-review');
  });

  it('formatCIReport_EmptySummaries_ReturnsEmptyString', () => {
    const output = formatCIReport([]);

    expect(output).toBe('');
  });
});

describe('formatFailedAssertions', () => {
  it('formatFailedAssertions_NoFailures_ReturnsDefaultMessage', () => {
    const result = makeResult({
      caseId: 'c-1',
      passed: false,
      score: 0.0,
      assertions: [],
    });

    const output = formatFailedAssertions(result);

    expect(output).toBe('No assertion details');
  });

  it('formatFailedAssertions_SingleFailure_FormatsReason', () => {
    const result = makeResult({
      caseId: 'c-1',
      passed: false,
      score: 0.0,
      assertions: [
        { name: 'tool-call', type: 'tool-call', passed: false, score: 0.0, reason: 'Missing tool invocation', threshold: 1.0 },
      ],
    });

    const output = formatFailedAssertions(result);

    expect(output).toBe('tool-call: Missing tool invocation');
  });

  it('formatFailedAssertions_MultipleFailures_JoinsReasons', () => {
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

    const output = formatFailedAssertions(result);

    expect(output).toBe('exact-match: Field mismatch; schema: Invalid structure');
    expect(output).not.toContain('passing-one');
  });
});

describe('escapeCommandValue', () => {
  it('escapeCommandValue_SpecialChars_EscapesPercentsAndNewlines', () => {
    expect(escapeCommandValue('50% done\nline2\rend')).toBe('50%25 done%0Aline2%0Dend');
  });

  it('escapeCommandValue_PlainText_ReturnsUnchanged', () => {
    expect(escapeCommandValue('hello world')).toBe('hello world');
  });
});

describe('escapeCommandProperty', () => {
  it('escapeCommandProperty_ColonsAndCommas_EscapesPropertyChars', () => {
    expect(escapeCommandProperty('key:value,item')).toBe('key%3Avalue%2Citem');
  });

  it('escapeCommandProperty_AllSpecialChars_EscapesEverything', () => {
    expect(escapeCommandProperty('a:b,c%d\ne')).toBe('a%3Ab%2Cc%25d%0Ae');
  });
});

describe('formatCIReport escaping', () => {
  it('formatCIReport_SpecialCharsInCaseId_EscapesAnnotationTitle', () => {
    const summaries = [
      makeSummary({
        suiteId: 'test:suite',
        avgScore: 0.0,
        results: [
          makeResult({
            caseId: 'case:with,special%chars',
            passed: false,
            score: 0.0,
            assertions: [
              { name: 'check', type: 'exact-match', passed: false, score: 0.0, reason: 'fail\nreason', threshold: 1.0 },
            ],
          }),
        ],
      }),
    ];

    const output = formatCIReport(summaries);

    const errorLine = output.split('\n').find((l) => l.startsWith('::error'));
    expect(errorLine).toBeDefined();
    expect(errorLine).toContain('case%3Awith%2Cspecial%25chars');
    expect(errorLine).toContain('fail%0Areason');
    const noticeLine = output.split('\n').find((l) => l.startsWith('::notice'));
    expect(noticeLine).toContain('test%3Asuite');
  });
});

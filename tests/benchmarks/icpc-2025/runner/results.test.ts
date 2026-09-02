import { describe, it, expect } from 'vitest';
import {
  buildSampleResult,
  computeVerdict,
  buildArmResult,
  aggregateResults,
} from './results.js';
import type { SampleResult, ProblemResult, ArmId } from './types.js';

describe('buildSampleResult', () => {
  it('buildSampleResult_CorrectOutput_ReturnsPass', () => {
    const result = buildSampleResult(1, '42', '42', false, false);
    expect(result.verdict).toBe('pass');
    expect(result.sampleId).toBe(1);
    expect(result.expectedOutput).toBe('42');
    expect(result.actualOutput).toBe('42');
  });

  it('buildSampleResult_WrongOutput_ReturnsFail', () => {
    const result = buildSampleResult(1, '99', '42', false, false);
    expect(result.verdict).toBe('fail');
    expect(result.actualOutput).toBe('99');
  });

  it('buildSampleResult_TimedOut_ReturnsTle', () => {
    const result = buildSampleResult(1, undefined, '42', true, false);
    expect(result.verdict).toBe('tle');
  });

  it('buildSampleResult_RuntimeError_ReturnsRte', () => {
    const result = buildSampleResult(1, undefined, '42', false, true);
    expect(result.verdict).toBe('rte');
  });

  it('buildSampleResult_NoActualOutput_ReturnsFail', () => {
    const result = buildSampleResult(1, undefined, '42', false, false);
    expect(result.verdict).toBe('fail');
    expect(result.actualOutput).toBeUndefined();
  });
});

describe('computeVerdict', () => {
  it('computeVerdict_AllPass_ReturnsPass', () => {
    const samples: SampleResult[] = [
      { sampleId: 1, verdict: 'pass', expectedOutput: '1', actualOutput: '1' },
      { sampleId: 2, verdict: 'pass', expectedOutput: '2', actualOutput: '2' },
    ];
    expect(computeVerdict(samples)).toBe('pass');
  });

  it('computeVerdict_MixedResults_ReturnsPartial', () => {
    const samples: SampleResult[] = [
      { sampleId: 1, verdict: 'pass', expectedOutput: '1', actualOutput: '1' },
      { sampleId: 2, verdict: 'fail', expectedOutput: '2', actualOutput: '99' },
    ];
    expect(computeVerdict(samples)).toBe('partial');
  });

  it('computeVerdict_AllFail_ReturnsFail', () => {
    const samples: SampleResult[] = [
      { sampleId: 1, verdict: 'fail', expectedOutput: '1', actualOutput: '99' },
      { sampleId: 2, verdict: 'fail', expectedOutput: '2', actualOutput: '88' },
    ];
    expect(computeVerdict(samples)).toBe('fail');
  });

  it('computeVerdict_NoSolution_ReturnsNoSolution', () => {
    expect(computeVerdict([])).toBe('no_solution');
  });

  it('computeVerdict_AllTle_ReturnsTle', () => {
    const samples: SampleResult[] = [
      { sampleId: 1, verdict: 'tle', expectedOutput: '1' },
      { sampleId: 2, verdict: 'tle', expectedOutput: '2' },
    ];
    expect(computeVerdict(samples)).toBe('tle');
  });

  it('computeVerdict_AnyCe_ReturnsCe', () => {
    const samples: SampleResult[] = [
      { sampleId: 1, verdict: 'fail', expectedOutput: '1' },
      { sampleId: 2, verdict: 'fail', expectedOutput: '2', actualOutput: '99' },
    ];
    // ce is an arm-level verdict computed from compile failures, not sample-level
    // With no passes, this should return fail
    expect(computeVerdict(samples)).toBe('fail');
  });
});

describe('buildArmResult', () => {
  it('builds complete ArmResult with verdict', () => {
    const samples: SampleResult[] = [
      { sampleId: 1, verdict: 'pass', expectedOutput: '1', actualOutput: '1' },
    ];
    const metrics = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      wallClockSeconds: 1.0,
      iterationCount: 1,
      linesOfCode: 10,
    };
    const result = buildArmResult('exarchos', samples, metrics, 'print(1)', 'first try');
    expect(result.arm).toBe('exarchos');
    expect(result.verdict).toBe('pass');
    expect(result.sampleResults).toEqual(samples);
    expect(result.metrics).toEqual(metrics);
    expect(result.solution).toBe('print(1)');
    expect(result.notes).toBe('first try');
  });
});

describe('aggregateResults', () => {
  it('aggregateResults_MixedVerdicts_ComputesCorrectTotals', () => {
    const makeMetrics = (tokens: number, seconds: number) => ({
      inputTokens: Math.floor(tokens * 0.67),
      outputTokens: tokens - Math.floor(tokens * 0.67),
      totalTokens: tokens,
      wallClockSeconds: seconds,
      iterationCount: 1,
      linesOfCode: 10,
    });

    const problems: ProblemResult[] = [
      {
        problemId: 'p1',
        title: 'Problem 1',
        arms: [
          { arm: 'exarchos', verdict: 'pass', sampleResults: [], metrics: makeMetrics(150, 1.0) },
          { arm: 'vanilla-plan', verdict: 'pass', sampleResults: [], metrics: makeMetrics(300, 2.0) },
          { arm: 'hn-manual', verdict: 'fail', sampleResults: [], metrics: makeMetrics(450, 3.0) },
        ],
      },
      {
        problemId: 'p2',
        title: 'Problem 2',
        arms: [
          { arm: 'exarchos', verdict: 'fail', sampleResults: [], metrics: makeMetrics(150, 1.0) },
          { arm: 'vanilla-plan', verdict: 'pass', sampleResults: [], metrics: makeMetrics(300, 2.0) },
          { arm: 'hn-manual', verdict: 'pass', sampleResults: [], metrics: makeMetrics(450, 3.0) },
        ],
      },
      {
        problemId: 'p3',
        title: 'Problem 3',
        arms: [
          { arm: 'exarchos', verdict: 'pass', sampleResults: [], metrics: makeMetrics(150, 1.0) },
          { arm: 'vanilla-plan', verdict: 'fail', sampleResults: [], metrics: makeMetrics(300, 2.0) },
          { arm: 'hn-manual', verdict: 'pass', sampleResults: [], metrics: makeMetrics(450, 3.0) },
        ],
      },
    ];

    const stats = aggregateResults(problems);

    expect(stats.totalProblems).toBe(3);
    expect(stats.totalSolved.exarchos).toBe(2);
    expect(stats.totalSolved['vanilla-plan']).toBe(2);
    expect(stats.totalSolved['hn-manual']).toBe(2);
    expect(stats.meanTokens.exarchos).toBe(150);
    expect(stats.meanTokens['vanilla-plan']).toBe(300);
    expect(stats.meanTokens['hn-manual']).toBe(450);
    expect(stats.meanTime.exarchos).toBe(1.0);
    expect(stats.meanTime['vanilla-plan']).toBe(2.0);
    expect(stats.meanTime['hn-manual']).toBe(3.0);
  });
});

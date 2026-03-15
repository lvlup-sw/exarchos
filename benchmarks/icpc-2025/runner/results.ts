import type { ArmResult, SampleResult, Verdict, ArmId, Metrics, ProblemResult } from './types.js';
import { verify } from './verifier.js';

export function buildSampleResult(
  sampleId: number,
  actualOutput: string | undefined,
  expectedOutput: string,
  timedOut: boolean,
  runtimeError: boolean,
): SampleResult {
  if (timedOut) {
    return { sampleId, verdict: 'tle', expectedOutput, actualOutput };
  }
  if (runtimeError) {
    return { sampleId, verdict: 'rte', expectedOutput, actualOutput };
  }
  if (actualOutput === undefined) {
    return { sampleId, verdict: 'fail', expectedOutput };
  }

  const { passed: match } = verify(actualOutput, expectedOutput);
  return {
    sampleId,
    verdict: match ? 'pass' : 'fail',
    expectedOutput,
    actualOutput,
  };
}

export function computeVerdict(sampleResults: SampleResult[]): Verdict {
  if (sampleResults.length === 0) {
    return 'no_solution';
  }

  const verdicts = sampleResults.map((s) => s.verdict);

  // CE takes priority
  if (verdicts.some((v) => v === 'ce')) {
    return 'ce';
  }

  const hasPass = verdicts.some((v) => v === 'pass');
  const allPass = verdicts.every((v) => v === 'pass');
  const allTle = verdicts.every((v) => v === 'tle');

  if (allPass) {
    return 'pass';
  }
  if (allTle) {
    return 'tle';
  }
  if (hasPass) {
    return 'partial';
  }

  // Check for TLE mixed with failures (no passes)
  if (verdicts.some((v) => v === 'tle')) {
    return 'tle';
  }

  return 'fail';
}

export function buildArmResult(
  arm: ArmId,
  sampleResults: SampleResult[],
  metrics: Metrics,
  solution?: string,
  notes?: string,
): ArmResult {
  const verdict = computeVerdict(sampleResults);
  return {
    arm,
    verdict,
    sampleResults,
    metrics,
    solution,
    notes,
  };
}

export interface AggregateStats {
  totalSolved: Record<ArmId, number>;
  meanTokens: Record<ArmId, number>;
  meanTime: Record<ArmId, number>;
  totalProblems: number;
}

export function aggregateResults(problems: ProblemResult[]): AggregateStats {
  const totalSolved: Record<string, number> = {};
  const tokenSums: Record<string, number> = {};
  const timeSums: Record<string, number> = {};
  const armCounts: Record<string, number> = {};

  for (const problem of problems) {
    for (const arm of problem.arms) {
      if (!(arm.arm in totalSolved)) {
        totalSolved[arm.arm] = 0;
        tokenSums[arm.arm] = 0;
        timeSums[arm.arm] = 0;
        armCounts[arm.arm] = 0;
      }

      if (arm.verdict === 'pass') {
        totalSolved[arm.arm]++;
      }

      tokenSums[arm.arm] += arm.metrics.totalTokens;
      timeSums[arm.arm] += arm.metrics.wallClockSeconds;
      armCounts[arm.arm]++;
    }
  }

  const meanTokens: Record<string, number> = {};
  const meanTime: Record<string, number> = {};

  for (const armId of Object.keys(armCounts)) {
    const count = armCounts[armId];
    meanTokens[armId] = count > 0 ? tokenSums[armId] / count : 0;
    meanTime[armId] = count > 0 ? timeSums[armId] / count : 0;
  }

  return {
    totalSolved: totalSolved as Record<ArmId, number>,
    meanTokens: meanTokens as Record<ArmId, number>,
    meanTime: meanTime as Record<ArmId, number>,
    totalProblems: problems.length,
  };
}

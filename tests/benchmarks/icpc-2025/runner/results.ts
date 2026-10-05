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

/**
 * Reduces the sample verdicts to one arm verdict.
 * No `ce` case exists: a compile failure is an arm-level outcome, so a sample never carries it.
 * With no pass, any `tle` gives `tle`, and all `rte` gives `rte`.
 */
export function computeVerdict(sampleResults: SampleResult[]): Verdict {
  if (sampleResults.length === 0) {
    return 'no_solution';
  }

  const verdicts = sampleResults.map((s) => s.verdict);

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

  if (verdicts.some((v) => v === 'tle')) {
    return 'tle';
  }

  if (verdicts.every((v) => v === 'rte')) {
    return 'rte';
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
  totalSolved: Partial<Record<ArmId, number>>;
  meanTokens: Partial<Record<ArmId, number>>;
  meanTime: Partial<Record<ArmId, number>>;
  totalProblems: number;
}

/**
 * Computes the solved count and the mean tokens and time of each arm.
 * Each sum reads through `?? 0`, because `noUncheckedIndexedAccess` types a record subscript as `number | undefined`.
 */
export function aggregateResults(problems: ProblemResult[]): AggregateStats {
  const totalSolved: Record<string, number> = {};
  const tokenSums: Record<string, number> = {};
  const timeSums: Record<string, number> = {};
  const armCounts: Record<string, number> = {};

  for (const problem of problems) {
    for (const arm of problem.arms) {
      const id = arm.arm;
      totalSolved[id] = (totalSolved[id] ?? 0) + (arm.verdict === 'pass' ? 1 : 0);
      tokenSums[id] = (tokenSums[id] ?? 0) + arm.metrics.totalTokens;
      timeSums[id] = (timeSums[id] ?? 0) + arm.metrics.wallClockSeconds;
      armCounts[id] = (armCounts[id] ?? 0) + 1;
    }
  }

  const meanTokens: Record<string, number> = {};
  const meanTime: Record<string, number> = {};

  for (const [armId, count] of Object.entries(armCounts)) {
    meanTokens[armId] = count > 0 ? (tokenSums[armId] ?? 0) / count : 0;
    meanTime[armId] = count > 0 ? (timeSums[armId] ?? 0) / count : 0;
  }

  return {
    totalSolved: totalSolved as Partial<Record<ArmId, number>>,
    meanTokens: meanTokens as Partial<Record<ArmId, number>>,
    meanTime: meanTime as Partial<Record<ArmId, number>>,
    totalProblems: problems.length,
  };
}

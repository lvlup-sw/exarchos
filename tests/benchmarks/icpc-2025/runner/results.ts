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

  // No `ce` check here. `SampleVerdict` is pass/fail/tle/rte — a compile failure
  // is an ARM-level outcome decided by `runSolution`, so a sample can never
  // carry it and the guard that used to sit here could never fire.
  // `computeVerdict_AnyCe_ReturnsCe` already asserts the real behaviour.

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

  // Preserve RTE verdict when all samples are runtime errors
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

export function aggregateResults(problems: ProblemResult[]): AggregateStats {
  const totalSolved: Record<string, number> = {};
  const tokenSums: Record<string, number> = {};
  const timeSums: Record<string, number> = {};
  const armCounts: Record<string, number> = {};

  // `Record<string, number>` indexes to `number | undefined` under
  // `noUncheckedIndexedAccess`, and the `in` check above does not narrow a later
  // subscript. Reading through a local with a `?? 0` seed says the same thing the
  // seeding block said, in a form the checker can follow.
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

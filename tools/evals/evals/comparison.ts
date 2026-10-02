import type { RunSummary } from './types.js';

export interface RegressionEntry {
  readonly caseId: string;
  readonly baselineScore: number;
  readonly candidateScore: number;
}

export interface ImprovementEntry {
  readonly caseId: string;
  readonly baselineScore: number;
  readonly candidateScore: number;
}

export interface ScoreDelta {
  readonly caseId: string;
  readonly baselineScore: number;
  readonly candidateScore: number;
  readonly delta: number;
}

export interface NewCaseEntry {
  readonly caseId: string;
  readonly score: number;
  readonly passed: boolean;
}

export interface RemovedCaseEntry {
  readonly caseId: string;
  readonly score: number;
  readonly passed: boolean;
}

export interface ComparisonReport {
  readonly regressions: ReadonlyArray<RegressionEntry>;
  readonly improvements: ReadonlyArray<ImprovementEntry>;
  readonly newCases: ReadonlyArray<NewCaseEntry>;
  readonly removedCases: ReadonlyArray<RemovedCaseEntry>;
  readonly scoreDeltas: ReadonlyArray<ScoreDelta>;
  readonly verdict: 'safe' | 'regressions-detected';
}

/**
 * Compares a baseline run with a candidate run. A regression is a case that passed in the baseline
 * and fails in the candidate. An improvement is the reverse. Any regression sets the verdict to
 * `regressions-detected`.
 */
export function compareRuns(
  baseline: RunSummary,
  candidate: RunSummary,
): ComparisonReport {
  const baselineMap = new Map(
    baseline.results.map((r) => [r.caseId, r]),
  );

  const candidateMap = new Map(
    candidate.results.map((r) => [r.caseId, r]),
  );

  const regressions: RegressionEntry[] = [];
  const improvements: ImprovementEntry[] = [];
  const scoreDeltas: ScoreDelta[] = [];
  const newCases: NewCaseEntry[] = [];
  const removedCases: RemovedCaseEntry[] = [];

  for (const [caseId, candidateResult] of candidateMap) {
    const baselineResult = baselineMap.get(caseId);

    if (!baselineResult) {
      newCases.push({
        caseId,
        score: candidateResult.score,
        passed: candidateResult.passed,
      });
      continue;
    }

    if (baselineResult.passed && !candidateResult.passed) {
      regressions.push({
        caseId,
        baselineScore: baselineResult.score,
        candidateScore: candidateResult.score,
      });
    }

    if (!baselineResult.passed && candidateResult.passed) {
      improvements.push({
        caseId,
        baselineScore: baselineResult.score,
        candidateScore: candidateResult.score,
      });
    }

    scoreDeltas.push({
      caseId,
      baselineScore: baselineResult.score,
      candidateScore: candidateResult.score,
      delta: candidateResult.score - baselineResult.score,
    });
  }

  for (const [caseId, baselineResult] of baselineMap) {
    if (!candidateMap.has(caseId)) {
      removedCases.push({
        caseId,
        score: baselineResult.score,
        passed: baselineResult.passed,
      });
    }
  }

  const verdict = regressions.length > 0 ? 'regressions-detected' : 'safe';

  return {
    regressions,
    improvements,
    newCases,
    removedCases,
    scoreDeltas,
    verdict,
  };
}

import type { RunSummary } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── Comparison Logic ───────────────────────────────────────────────────────

/**
 * Compare two eval run summaries and produce a comparison report.
 *
 * Identifies regressions (passed->failed), improvements (failed->passed),
 * new cases, removed cases, and score deltas between baseline and candidate.
 */
export function compareRuns(
  baseline: RunSummary,
  candidate: RunSummary,
): ComparisonReport {
  // Index baseline results by caseId
  const baselineMap = new Map(
    baseline.results.map((r) => [r.caseId, r]),
  );

  // Index candidate results by caseId
  const candidateMap = new Map(
    candidate.results.map((r) => [r.caseId, r]),
  );

  const regressions: RegressionEntry[] = [];
  const improvements: ImprovementEntry[] = [];
  const scoreDeltas: ScoreDelta[] = [];
  const newCases: NewCaseEntry[] = [];
  const removedCases: RemovedCaseEntry[] = [];

  // Compare cases present in both runs
  for (const [caseId, candidateResult] of candidateMap) {
    const baselineResult = baselineMap.get(caseId);

    if (!baselineResult) {
      // Case only in candidate -- new case
      newCases.push({
        caseId,
        score: candidateResult.score,
        passed: candidateResult.passed,
      });
      continue;
    }

    // Detect regressions: was passing, now failing
    if (baselineResult.passed && !candidateResult.passed) {
      regressions.push({
        caseId,
        baselineScore: baselineResult.score,
        candidateScore: candidateResult.score,
      });
    }

    // Detect improvements: was failing, now passing
    if (!baselineResult.passed && candidateResult.passed) {
      improvements.push({
        caseId,
        baselineScore: baselineResult.score,
        candidateScore: candidateResult.score,
      });
    }

    // Calculate score delta
    scoreDeltas.push({
      caseId,
      baselineScore: baselineResult.score,
      candidateScore: candidateResult.score,
      delta: candidateResult.score - baselineResult.score,
    });
  }

  // Find removed cases (in baseline but not in candidate)
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

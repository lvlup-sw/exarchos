import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EvalResultsViewState } from '../views/eval-results-view.js';

export interface SkillCorrelation {
  readonly skill: string;
  readonly gatePassRate: number;
  readonly evalScore: number;
  readonly evalTrend: 'improving' | 'stable' | 'degrading';
  readonly qualityTrend: 'improving' | 'stable' | 'degrading';
  readonly regressionCount: number;
}

export interface QualityCorrelation {
  readonly skills: Record<string, SkillCorrelation>;
}

function deriveQualityTrend(passRate: number): 'improving' | 'stable' | 'degrading' {
  if (passRate >= 0.7) return 'stable';
  return 'degrading';
}

/** Correlates gate results with eval results for each skill that is in both views. */
export function correlateQualityAndEvals(
  codeQuality: CodeQualityViewState,
  evalResults: EvalResultsViewState,
): QualityCorrelation {
  const skills: Record<string, SkillCorrelation> = {};

  for (const skillName of Object.keys(codeQuality.skills)) {
    if (!Object.hasOwn(evalResults.skills, skillName)) continue;
    const qualityMetrics = codeQuality.skills[skillName];
    if (!Object.hasOwn(evalResults.skills, skillName)) continue;
    const evalMetrics = evalResults.skills[skillName];
    if (qualityMetrics === undefined || evalMetrics === undefined) continue;

    skills[skillName] = {
      skill: skillName,
      gatePassRate: qualityMetrics.gatePassRate,
      evalScore: evalMetrics.latestScore,
      evalTrend: evalMetrics.trend,
      qualityTrend: deriveQualityTrend(qualityMetrics.gatePassRate),
      regressionCount: evalMetrics.regressionCount,
    };
  }

  return { skills };
}

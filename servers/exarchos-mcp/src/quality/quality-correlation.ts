import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EvalResultsViewState } from '../views/eval-results-view.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function deriveQualityTrend(passRate: number): 'improving' | 'stable' | 'degrading' {
  if (passRate >= 0.7) return 'stable';
  return 'degrading';
}

// ─── Main Function ──────────────────────────────────────────────────────────

export function correlateQualityAndEvals(
  codeQuality: CodeQualityViewState,
  evalResults: EvalResultsViewState,
): QualityCorrelation {
  const skills: Record<string, SkillCorrelation> = {};

  for (const skillName of Object.keys(codeQuality.skills)) {
    if (!Object.hasOwn(evalResults.skills, skillName)) continue; // only include skills present in BOTH views
    const qualityMetrics = codeQuality.skills[skillName];
    if (!Object.hasOwn(evalResults.skills, skillName)) continue;
    const evalMetrics = evalResults.skills[skillName];

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

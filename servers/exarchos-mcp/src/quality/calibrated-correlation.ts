// ─── Calibrated Correlation ─────────────────────────────────────────────────
//
// Enriches skill correlation data with LLM judge calibration metrics.
// When a judge has been calibrated (eval.judge.calibrated event), we can
// derive a signal confidence level based on TPR/TNR thresholds.
// ────────────────────────────────────────────────────────────────────────────

import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EvalResultsViewState } from '../views/eval-results-view.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export type SignalConfidence = 'high' | 'medium' | 'low';

export interface CalibrationData {
  readonly skill: string;
  readonly rubricName: string;
  readonly tpr: number;
  readonly tnr: number;
  readonly totalCases: number;
  readonly f1: number;
}

export interface CalibratedSkillCorrelation {
  readonly skill: string;
  readonly gatePassRate: number;
  readonly regressionCount: number;
  readonly calibration: CalibrationData | null;
  readonly signalConfidence: SignalConfidence;
}

export interface CalibratedCorrelation {
  readonly skills: Record<string, CalibratedSkillCorrelation>;
}

// ─── Enriched View States ──────────────────────────────────────────────────

export interface EnrichedViewStates {
  readonly codeQuality: CodeQualityViewState;
  readonly evalResults: EvalResultsViewState;
  readonly calibrations: ReadonlyArray<CalibrationData>;
}

// ─── Thresholds ────────────────────────────────────────────────────────────

const HIGH_TPR_THRESHOLD = 0.85;
const HIGH_TNR_THRESHOLD = 0.80;
const MEDIUM_TPR_THRESHOLD = 0.70;
const MEDIUM_TNR_THRESHOLD = 0.60;

// ─── Confidence Derivation ─────────────────────────────────────────────────

/**
 * Derive signal confidence from calibration data.
 * High confidence requires both TPR >= 0.85 and TNR >= 0.80.
 * Medium confidence requires both TPR >= 0.70 and TNR >= 0.60.
 * Otherwise returns 'low'.
 */
export function deriveSignalConfidence(calibration: CalibrationData | null): SignalConfidence {
  if (!calibration) return 'low';

  if (calibration.tpr >= HIGH_TPR_THRESHOLD && calibration.tnr >= HIGH_TNR_THRESHOLD) {
    return 'high';
  }

  if (calibration.tpr >= MEDIUM_TPR_THRESHOLD && calibration.tnr >= MEDIUM_TNR_THRESHOLD) {
    return 'medium';
  }

  return 'low';
}

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Correlate code quality and eval results with calibration data.
 * For each skill present in the code quality view, look up any matching
 * calibration data and derive signal confidence.
 */
export function correlateWithCalibration(
  enriched: EnrichedViewStates,
): CalibratedCorrelation {
  const skills: Record<string, CalibratedSkillCorrelation> = {};

  for (const [skillName, qualityMetrics] of Object.entries(enriched.codeQuality.skills)) {
    const calibration = enriched.calibrations.find(c => c.skill === skillName) ?? null;
    const regressionCount = enriched.codeQuality.regressions.filter(
      r => r.skill === skillName,
    ).length;

    skills[skillName] = {
      skill: skillName,
      gatePassRate: qualityMetrics.gatePassRate,
      regressionCount,
      calibration,
      signalConfidence: deriveSignalConfidence(calibration),
    };
  }

  return { skills };
}

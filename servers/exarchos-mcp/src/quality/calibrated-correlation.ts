import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EvalResultsViewState } from '../views/eval-results-view.js';
import type { SkillCorrelation } from './quality-correlation.js';
import { correlateQualityAndEvals } from './quality-correlation.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface JudgeCalibration {
  readonly skill: string;
  readonly tpr: number;
  readonly tnr: number;
  readonly calibratedAt: string;
  readonly sampleSize: number;
}

export interface CalibratedSkillCorrelation extends SkillCorrelation {
  readonly judgeTPR: number;
  readonly judgeTNR: number;
  readonly judgeCalibrated: boolean;
  readonly signalConfidence: 'high' | 'medium' | 'low';
}

export interface SignalConfidenceInput {
  readonly judgeCalibrated: boolean;
  readonly judgeTPR: number;
  readonly judgeTNR: number;
  readonly totalEvalRuns: number;
  readonly totalGateExecutions: number;
}

// ─── Calibration Thresholds ─────────────────────────────────────────────────

const TPR_THRESHOLD = 0.85;
const TNR_THRESHOLD = 0.80;
const MIN_EVAL_RUNS = 10;
const MIN_GATE_EXECUTIONS = 20;

// ─── Signal Confidence Derivation ───────────────────────────────────────────

/**
 * Derive signal confidence from judge calibration data and data volume.
 *
 * - `high`   — judge calibrated (TPR >= 0.85, TNR >= 0.80) AND 10+ eval runs AND 20+ gate executions
 * - `medium` — judge calibrated but insufficient data volume
 * - `low`    — judge not calibrated or calibration below thresholds
 */
export function deriveSignalConfidence(input: SignalConfidenceInput): 'high' | 'medium' | 'low' {
  const meetsCalibrationThresholds =
    input.judgeCalibrated &&
    input.judgeTPR >= TPR_THRESHOLD &&
    input.judgeTNR >= TNR_THRESHOLD;

  if (!meetsCalibrationThresholds) return 'low';

  const meetsVolumeThresholds =
    input.totalEvalRuns >= MIN_EVAL_RUNS &&
    input.totalGateExecutions >= MIN_GATE_EXECUTIONS;

  if (!meetsVolumeThresholds) return 'medium';

  return 'high';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find the latest calibration for a given skill, sorted by calibratedAt timestamp.
 */
function findLatestCalibration(
  calibrations: ReadonlyArray<JudgeCalibration>,
  skill: string,
): JudgeCalibration | undefined {
  const matching = calibrations.filter((c) => c.skill === skill);
  if (matching.length === 0) return undefined;

  return matching.reduce((latest, current) =>
    current.calibratedAt > latest.calibratedAt ? current : latest,
  );
}

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Extend quality correlation with judge calibration data to produce
 * confidence-weighted signals.
 *
 * For each skill present in both views, finds the latest calibration,
 * derives judge calibrated state, and computes signal confidence.
 */
export function correlateWithCalibration(
  codeQuality: CodeQualityViewState,
  evalResults: EvalResultsViewState & { readonly calibrations: ReadonlyArray<JudgeCalibration> },
): CalibratedSkillCorrelation[] {
  const baseCorrelation = correlateQualityAndEvals(codeQuality, evalResults);
  const calibrations = evalResults.calibrations;

  const results: CalibratedSkillCorrelation[] = [];

  for (const [skillName, correlation] of Object.entries(baseCorrelation.skills)) {
    const latestCalibration = findLatestCalibration(calibrations, skillName);
    const qualityMetrics = codeQuality.skills[skillName];
    const evalMetrics = evalResults.skills[skillName];

    const judgeTPR = latestCalibration?.tpr ?? 0;
    const judgeTNR = latestCalibration?.tnr ?? 0;
    const judgeCalibrated = latestCalibration !== undefined;

    const signalConfidence = deriveSignalConfidence({
      judgeCalibrated,
      judgeTPR,
      judgeTNR,
      totalEvalRuns: evalMetrics.totalRuns,
      totalGateExecutions: qualityMetrics.totalExecutions,
    });

    results.push({
      ...correlation,
      judgeTPR,
      judgeTNR,
      judgeCalibrated,
      signalConfidence,
    });
  }

  return results;
}

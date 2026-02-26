// ─── Prompt Refinement Signal Evaluation ────────────────────────────────────
//
// Evaluates quality data from multiple sources and produces refinement
// signal objects when action is needed. The caller is responsible for
// emitting events — this module is pure and testable.
// ────────────────────────────────────────────────────────────────────────────

import type { QualityRegression } from '../views/code-quality-view.js';
import type { CalibratedSkillCorrelation } from './calibrated-correlation.js';
import type { AttributionResult } from './attribution.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface RefinementEvidence {
  readonly gatePassRate: number;
  readonly evalScore: number;
  readonly topFailureCategories: ReadonlyArray<{ readonly category: string; readonly count: number }>;
  readonly selfCorrectionRate: number;
  readonly recentRegressions: number;
}

export interface RefinementSignalInput {
  readonly skill: string;
  readonly signalConfidence: 'high' | 'medium' | 'low';
  readonly regressions: QualityRegression[];
  readonly calibratedCorrelation: CalibratedSkillCorrelation | null;
  readonly attribution: AttributionResult | null;
  readonly promptPaths: string[];
}

export interface RefinementSignal {
  readonly skill: string;
  readonly signalConfidence: 'high' | 'medium';
  readonly trigger: 'regression' | 'trend-degradation' | 'attribution-outlier';
  readonly evidence: RefinementEvidence;
  readonly suggestedAction: string;
  readonly affectedPromptPaths: string[];
}

// ─── Thresholds ─────────────────────────────────────────────────────────────

const GATE_PASS_RATE_DEGRADATION_THRESHOLD = 0.60;
const ATTRIBUTION_NEGATIVE_STRENGTH_THRESHOLD = 0.7;

// ─── Evidence Builder ───────────────────────────────────────────────────────

function buildEvidence(input: RefinementSignalInput): RefinementEvidence {
  const correlation = input.calibratedCorrelation;

  return {
    gatePassRate: correlation?.gatePassRate ?? 0,
    evalScore: correlation?.evalScore ?? 0,
    topFailureCategories: [],
    selfCorrectionRate: 0,
    recentRegressions: input.regressions.length,
  };
}

// ─── Suggested Action Builders ──────────────────────────────────────────────

function buildRegressionAction(regression: QualityRegression): string {
  return `Quality regression detected in ${regression.gate} gate for skill '${regression.skill}' with ${regression.consecutiveFailures} consecutive failures. Review the prompt instructions related to ${regression.gate} validation.`;
}

function buildTrendDegradationAction(input: RefinementSignalInput): string {
  const passRate = input.calibratedCorrelation?.gatePassRate ?? 0;
  const passRatePercent = Math.round(passRate * 100);
  return `Gate pass rate dropped to ${passRatePercent}%, significantly below acceptable levels. Run git log on recent skill prompt changes to identify the degradation source.`;
}

function buildAttributionOutlierAction(input: RefinementSignalInput): string {
  return `Attribution analysis for dimension '${input.attribution?.dimension ?? 'unknown'}' reveals a strong negative correlation between quality factors. Investigate prompt-version changes that may have introduced the regression.`;
}

// ─── Trigger Evaluators ─────────────────────────────────────────────────────

function evaluateRegressionTrigger(
  input: RefinementSignalInput,
  confidence: 'high' | 'medium',
  evidence: RefinementEvidence,
): RefinementSignal[] {
  if (input.regressions.length === 0) return [];

  return input.regressions.map((regression) => ({
    skill: input.skill,
    signalConfidence: confidence,
    trigger: 'regression' as const,
    evidence,
    suggestedAction: buildRegressionAction(regression),
    affectedPromptPaths: input.promptPaths,
  }));
}

function evaluateTrendDegradationTrigger(
  input: RefinementSignalInput,
  confidence: 'high' | 'medium',
  evidence: RefinementEvidence,
): RefinementSignal[] {
  const correlation = input.calibratedCorrelation;
  if (!correlation) return [];

  const isDegrading = correlation.gatePassRate < GATE_PASS_RATE_DEGRADATION_THRESHOLD;
  if (!isDegrading) return [];

  return [{
    skill: input.skill,
    signalConfidence: confidence,
    trigger: 'trend-degradation',
    evidence,
    suggestedAction: buildTrendDegradationAction(input),
    affectedPromptPaths: input.promptPaths,
  }];
}

function evaluateAttributionOutlierTrigger(
  input: RefinementSignalInput,
  confidence: 'high' | 'medium',
  evidence: RefinementEvidence,
): RefinementSignal[] {
  const attribution = input.attribution;
  if (!attribution) return [];

  const hasStrongNegative = attribution.correlations.some(
    (c) => c.direction === 'negative' && c.strength >= ATTRIBUTION_NEGATIVE_STRENGTH_THRESHOLD,
  );
  if (!hasStrongNegative) return [];

  return [{
    skill: input.skill,
    signalConfidence: confidence,
    trigger: 'attribution-outlier',
    evidence,
    suggestedAction: buildAttributionOutlierAction(input),
    affectedPromptPaths: input.promptPaths,
  }];
}

// ─── Main Function ──────────────────────────────────────────────────────────

/**
 * Evaluate quality data and produce refinement signals when action is needed.
 *
 * Three trigger conditions (emits if ANY match):
 * 1. Regression — A QualityRegression is detected AND confidence is high/medium
 * 2. Trend degradation — Pass rate dropped below threshold AND confidence is high/medium
 * 3. Attribution outlier — Strong negative correlation in prompt-version dimension AND confidence is high/medium
 *
 * Guards:
 * - Never emits when signalConfidence is 'low'
 * - All signals include affectedPromptPaths and human-readable suggestedAction
 */
export function evaluateRefinementSignals(input: RefinementSignalInput): RefinementSignal[] {
  // Guard: never emit on low confidence
  if (input.signalConfidence === 'low') return [];

  const confidence = input.signalConfidence as 'high' | 'medium';
  const evidence = buildEvidence(input);

  const signals: RefinementSignal[] = [
    ...evaluateRegressionTrigger(input, confidence, evidence),
    ...evaluateTrendDegradationTrigger(input, confidence, evidence),
    ...evaluateAttributionOutlierTrigger(input, confidence, evidence),
  ];

  return signals;
}

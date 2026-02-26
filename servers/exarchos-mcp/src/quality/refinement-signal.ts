// ─── Refinement Signal Evaluator ────────────────────────────────────────────
//
// Evaluates whether quality signals are strong enough to trigger automated
// refinement actions (e.g., generating regression eval cases, suggesting
// model changes). Only emits signals when confidence is sufficient.
// ────────────────────────────────────────────────────────────────────────────

import type { QualityRegression } from '../views/code-quality-view.js';
import type { CalibratedSkillCorrelation, SignalConfidence } from './calibrated-correlation.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export type RefinementTrigger = 'regression' | 'attribution-outlier' | 'eval-degradation';

export interface AttributionOutlier {
  readonly dimension: string;
  readonly correlationStrength: number;
  readonly direction: 'positive' | 'negative';
  readonly sampleSize: number;
}

export interface RefinementSignal {
  readonly skill: string;
  readonly trigger: RefinementTrigger;
  readonly signalConfidence: SignalConfidence;
  readonly regression: QualityRegression | null;
  readonly attribution: AttributionOutlier | null;
  readonly suggestedAction: string;
}

export interface RefinementSignalInput {
  readonly correlations: Record<string, CalibratedSkillCorrelation>;
  readonly regressions: ReadonlyArray<QualityRegression>;
  readonly attributionOutliers?: ReadonlyArray<AttributionOutlier & { readonly skill: string }>;
}

// ─── Thresholds ────────────────────────────────────────────────────────────

const MIN_SIGNAL_CONFIDENCE: SignalConfidence = 'medium';
const ATTRIBUTION_CORRELATION_THRESHOLD = 0.6;

// ─── Helpers ───────────────────────────────────────────────────────────────

function confidenceRank(c: SignalConfidence): number {
  switch (c) {
    case 'high': return 2;
    case 'medium': return 1;
    case 'low': return 0;
  }
}

function meetsMinConfidence(confidence: SignalConfidence): boolean {
  return confidenceRank(confidence) >= confidenceRank(MIN_SIGNAL_CONFIDENCE);
}

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Evaluate whether quality data warrants refinement signals.
 *
 * Only produces signals when:
 * 1. There is a regression AND calibrated confidence is at least 'medium'
 * 2. There is an attribution outlier AND calibrated confidence is at least 'medium'
 *
 * Returns empty array when confidence is too low to act on.
 */
export function evaluateRefinementSignals(
  input: RefinementSignalInput,
): RefinementSignal[] {
  const signals: RefinementSignal[] = [];

  // Check regressions
  for (const regression of input.regressions) {
    const correlation = input.correlations[regression.skill];
    if (!correlation) continue;
    if (!meetsMinConfidence(correlation.signalConfidence)) continue;

    signals.push({
      skill: regression.skill,
      trigger: 'regression',
      signalConfidence: correlation.signalConfidence,
      regression,
      attribution: null,
      suggestedAction: `Generate regression eval for ${regression.gate} gate in ${regression.skill} skill`,
    });
  }

  // Check attribution outliers
  if (input.attributionOutliers) {
    for (const outlier of input.attributionOutliers) {
      const correlation = input.correlations[outlier.skill];
      if (!correlation) continue;
      if (!meetsMinConfidence(correlation.signalConfidence)) continue;
      if (Math.abs(outlier.correlationStrength) < ATTRIBUTION_CORRELATION_THRESHOLD) continue;

      const action = outlier.direction === 'negative'
        ? `Consider changing ${outlier.dimension} — strong negative correlation with gate failures`
        : `Investigate ${outlier.dimension} — strong positive correlation with gate failures`;

      signals.push({
        skill: outlier.skill,
        trigger: 'attribution-outlier',
        signalConfidence: correlation.signalConfidence,
        regression: null,
        attribution: {
          dimension: outlier.dimension,
          correlationStrength: outlier.correlationStrength,
          direction: outlier.direction,
          sampleSize: outlier.sampleSize,
        },
        suggestedAction: action,
      });
    }
  }

  return signals;
}

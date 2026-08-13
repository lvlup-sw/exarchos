import { describe, it, expect } from 'vitest';
import type { QualityRegression } from '../views/code-quality-view.js';
import type { CalibratedSkillCorrelation } from './calibrated-correlation.js';
import type { AttributionResult } from './attribution.js';
import type { RefinementSignalInput } from './refinement-signal.js';

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeRegression(overrides: Partial<QualityRegression> = {}): QualityRegression {
  return {
    skill: 'delegation',
    gate: 'typecheck',
    consecutiveFailures: 4,
    firstFailureCommit: 'abc123',
    lastFailureCommit: 'def789',
    detectedAt: '2026-02-25T00:00:00.000Z',
    ...overrides,
  };
}

function makeCalibrated(overrides: Partial<CalibratedSkillCorrelation> = {}): CalibratedSkillCorrelation {
  return {
    skill: 'delegation',
    gatePassRate: 0.85,
    evalScore: 0.9,
    evalTrend: 'stable',
    qualityTrend: 'stable',
    regressionCount: 0,
    judgeTPR: 0.90,
    judgeTNR: 0.85,
    judgeCalibrated: true,
    signalConfidence: 'high',
    ...overrides,
  };
}

function makeAttribution(overrides: Partial<AttributionResult> = {}): AttributionResult {
  return {
    dimension: 'prompt-version',
    entries: [],
    correlations: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<RefinementSignalInput> = {}): RefinementSignalInput {
  return {
    skill: 'delegation',
    signalConfidence: 'high',
    regressions: [],
    calibratedCorrelation: null,
    attribution: null,
    promptPaths: ['skills/delegation/SKILL.md'],
    ...overrides,
  };
}

// ─── evaluateRefinementSignals Tests ────────────────────────────────────────

describe('evaluateRefinementSignals', () => {
  it('EvaluateRefinementSignals_RegressionWithHighConfidence_EmitsSignal', async () => {
    const { evaluateRefinementSignals } = await import('./refinement-signal.js');

    const input = makeInput({
      signalConfidence: 'high',
      regressions: [makeRegression()],
      calibratedCorrelation: makeCalibrated({ signalConfidence: 'high' }),
    });

    const signals = evaluateRefinementSignals(input);

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const regressionSignal = signals.find(s => s.trigger === 'regression');
    expect(regressionSignal).toBeDefined();
    expect(regressionSignal!.signalConfidence).toBe('high');
    expect(regressionSignal!.skill).toBe('delegation');
  });

  it('EvaluateRefinementSignals_RegressionWithLowConfidence_DoesNotEmit', async () => {
    const { evaluateRefinementSignals } = await import('./refinement-signal.js');

    const input = makeInput({
      signalConfidence: 'low',
      regressions: [makeRegression()],
      calibratedCorrelation: makeCalibrated({ signalConfidence: 'low' }),
    });

    const signals = evaluateRefinementSignals(input);

    expect(signals).toHaveLength(0);
  });

  it('EvaluateRefinementSignals_TrendDegradation_EmitsSignal', async () => {
    const { evaluateRefinementSignals } = await import('./refinement-signal.js');

    const input = makeInput({
      signalConfidence: 'medium',
      calibratedCorrelation: makeCalibrated({
        signalConfidence: 'medium',
        gatePassRate: 0.45, // significantly below average
        qualityTrend: 'degrading',
      }),
    });

    const signals = evaluateRefinementSignals(input);

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const trendSignal = signals.find(s => s.trigger === 'trend-degradation');
    expect(trendSignal).toBeDefined();
    expect(trendSignal!.signalConfidence).toBe('medium');
  });

  it('EvaluateRefinementSignals_AttributionOutlier_EmitsSignal', async () => {
    const { evaluateRefinementSignals } = await import('./refinement-signal.js');

    const input = makeInput({
      signalConfidence: 'high',
      attribution: makeAttribution({
        dimension: 'prompt-version',
        correlations: [
          {
            factor1: 'gatePassRate',
            factor2: 'evalScore',
            direction: 'negative',
            strength: 0.8,
          },
        ],
      }),
    });

    const signals = evaluateRefinementSignals(input);

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const attributionSignal = signals.find(s => s.trigger === 'attribution-outlier');
    expect(attributionSignal).toBeDefined();
    expect(attributionSignal!.signalConfidence).toBe('high');
  });

  it('EvaluateRefinementSignals_IncludesAffectedPromptPaths', async () => {
    const { evaluateRefinementSignals } = await import('./refinement-signal.js');

    const promptPaths = ['skills/delegation/SKILL.md', 'skills/delegation/references/guide.md'];
    const input = makeInput({
      signalConfidence: 'high',
      regressions: [makeRegression()],
      calibratedCorrelation: makeCalibrated({ signalConfidence: 'high' }),
      promptPaths,
    });

    const signals = evaluateRefinementSignals(input);

    expect(signals.length).toBeGreaterThanOrEqual(1);
    for (const signal of signals) {
      expect(signal.affectedPromptPaths).toEqual(promptPaths);
    }
  });

  it('EvaluateRefinementSignals_IncludesEvidence', async () => {
    const { evaluateRefinementSignals } = await import('./refinement-signal.js');

    const input = makeInput({
      signalConfidence: 'high',
      regressions: [makeRegression()],
      calibratedCorrelation: makeCalibrated({
        signalConfidence: 'high',
        gatePassRate: 0.65,
        evalScore: 0.72,
        regressionCount: 2,
      }),
    });

    const signals = evaluateRefinementSignals(input);

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const signal = signals[0];
    expect(signal.evidence).toBeDefined();
    expect(typeof signal.evidence.gatePassRate).toBe('number');
    expect(typeof signal.evidence.evalScore).toBe('number');
    expect(Array.isArray(signal.evidence.topFailureCategories)).toBe(true);
    expect(typeof signal.evidence.selfCorrectionRate).toBe('number');
    expect(typeof signal.evidence.recentRegressions).toBe('number');
  });
});

// ─── buildSuggestedAction Tests ──────────────────────────────────────────────

describe('buildSuggestedAction', () => {
  it('BuildSuggestedAction_Regression_DescribesGateCategory', async () => {
    const { evaluateRefinementSignals } = await import('./refinement-signal.js');

    const input = makeInput({
      signalConfidence: 'high',
      regressions: [makeRegression({ gate: 'typecheck', skill: 'delegation' })],
      calibratedCorrelation: makeCalibrated({ signalConfidence: 'high' }),
    });

    const signals = evaluateRefinementSignals(input);
    const regressionSignal = signals.find(s => s.trigger === 'regression');

    expect(regressionSignal).toBeDefined();
    expect(regressionSignal!.suggestedAction).toContain('typecheck');
  });

  it('BuildSuggestedAction_TrendDegradation_SuggestsGitLog', async () => {
    const { evaluateRefinementSignals } = await import('./refinement-signal.js');

    const input = makeInput({
      signalConfidence: 'medium',
      calibratedCorrelation: makeCalibrated({
        signalConfidence: 'medium',
        gatePassRate: 0.45,
        qualityTrend: 'degrading',
      }),
    });

    const signals = evaluateRefinementSignals(input);
    const trendSignal = signals.find(s => s.trigger === 'trend-degradation');

    expect(trendSignal).toBeDefined();
    expect(trendSignal!.suggestedAction.toLowerCase()).toContain('git log');
  });
});

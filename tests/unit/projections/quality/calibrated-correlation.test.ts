import { describe, it, expect } from 'vitest';
import {
  correlateWithCalibration,
  deriveSignalConfidence,
} from '../../../../src/projections/quality/calibrated-correlation.js';
import type { CalibratedSkillCorrelation } from '../../../../src/projections/quality/calibrated-correlation.js';
import type { CodeQualityViewState } from '../../../../src/projections/views/code-quality-view.js';
import type { EvalResultsViewState } from '../../../../src/projections/views/eval-results-view.js';
import type { JudgeCalibration } from '../../../../src/projections/quality/calibrated-correlation.js';

function makeCodeQuality(
  skills: Record<string, { gatePassRate: number; totalExecutions: number }>,
): CodeQualityViewState {
  const skillEntries: CodeQualityViewState['skills'] = {};
  for (const [name, data] of Object.entries(skills)) {
    skillEntries[name] = {
      skill: name,
      totalExecutions: data.totalExecutions,
      gatePassRate: data.gatePassRate,
      selfCorrectionRate: 0,
      avgRemediationAttempts: 0,
      topFailureCategories: [],
    };
  }
  return {
    skills: skillEntries,
    models: {},
    gates: {},
    regressions: [],
    benchmarks: [],
  };
}

function makeEvalResults(
  skills: Record<string, { latestScore: number; totalRuns: number; trend?: 'improving' | 'stable' | 'degrading' }>,
  calibrations: JudgeCalibration[] = [],
): EvalResultsViewState & { readonly calibrations: ReadonlyArray<JudgeCalibration> } {
  const skillEntries: EvalResultsViewState['skills'] = {};
  for (const [name, data] of Object.entries(skills)) {
    skillEntries[name] = {
      skill: name,
      latestScore: data.latestScore,
      trend: data.trend ?? 'stable',
      lastRunId: `run-${name}`,
      lastRunTimestamp: '2026-02-25T00:00:00Z',
      totalRuns: data.totalRuns,
      regressionCount: 0,
      capabilityPassRate: data.latestScore,
    };
  }
  return {
    skills: skillEntries,
    runs: [],
    regressions: [],
    calibrations,
  };
}

/**
 * The thresholds are a true-positive rate of 0.85, a true-negative rate of 0.80, 10 eval runs and 20 gate executions.
 * A judge that is not calibrated, or is below a rate threshold, gives `low`.
 * A calibrated judge with too little data gives `medium`.
 */
describe('deriveSignalConfidence', () => {
  it('DeriveSignalConfidence_AllThresholdsMet_ReturnsHigh', () => {
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.85,
      totalEvalRuns: 12,
      totalGateExecutions: 25,
    });

    expect(result).toBe('high');
  });

  it('DeriveSignalConfidence_InsufficientVolume_ReturnsMedium', () => {
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.85,
      totalEvalRuns: 5,
      totalGateExecutions: 15,
    });

    expect(result).toBe('medium');
  });

  it('DeriveSignalConfidence_CalibratedButLowEvalRuns_ReturnsMedium', () => {
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.85,
      totalEvalRuns: 8,
      totalGateExecutions: 30,
    });

    expect(result).toBe('medium');
  });

  it('DeriveSignalConfidence_CalibratedButLowGateExecutions_ReturnsMedium', () => {
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.85,
      totalEvalRuns: 15,
      totalGateExecutions: 10,
    });

    expect(result).toBe('medium');
  });

  it('DeriveSignalConfidence_NotCalibrated_ReturnsLow', () => {
    const result = deriveSignalConfidence({
      judgeCalibrated: false,
      judgeTPR: 0,
      judgeTNR: 0,
      totalEvalRuns: 50,
      totalGateExecutions: 100,
    });

    expect(result).toBe('low');
  });

  it('DeriveSignalConfidence_BelowTPRThreshold_ReturnsLow', () => {
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.70,
      judgeTNR: 0.90,
      totalEvalRuns: 20,
      totalGateExecutions: 50,
    });

    expect(result).toBe('low');
  });

  it('DeriveSignalConfidence_BelowTNRThreshold_ReturnsLow', () => {
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.70,
      totalEvalRuns: 20,
      totalGateExecutions: 50,
    });

    expect(result).toBe('low');
  });

  /** Each threshold is inclusive. */
  it('DeriveSignalConfidence_ExactThresholds_ReturnsHigh', () => {
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.85,
      judgeTNR: 0.80,
      totalEvalRuns: 10,
      totalGateExecutions: 20,
    });

    expect(result).toBe('high');
  });
});

describe('correlateWithCalibration', () => {
  it('CorrelateWithCalibration_CalibratedJudge_ReturnsHighConfidence', () => {
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 25 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 12 } },
      [
        {
          skill: 'delegation',
          tpr: 0.90,
          tnr: 0.85,
          calibratedAt: '2026-02-20T00:00:00Z',
          sampleSize: 50,
        },
      ],
    );

    const result = correlateWithCalibration(codeQuality, evalResults);

    expect(result).toHaveLength(1);
    const delegation = result[0];
    expect(delegation.skill).toBe('delegation');
    expect(delegation.judgeTPR).toBe(0.90);
    expect(delegation.judgeTNR).toBe(0.85);
    expect(delegation.judgeCalibrated).toBe(true);
    expect(delegation.signalConfidence).toBe('high');
    expect(delegation.gatePassRate).toBe(0.9);
    expect(delegation.evalScore).toBe(0.85);
  });

  /** A skill in both views with no calibration gets zero rates and `judgeCalibrated: false`. */
  it('CorrelateWithCalibration_UncalibratedJudge_ReturnsLowConfidence', () => {
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 25 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 12 } },
      [],
    );

    const result = correlateWithCalibration(codeQuality, evalResults);

    expect(result).toHaveLength(1);
    const delegation = result[0];
    expect(delegation.judgeCalibrated).toBe(false);
    expect(delegation.judgeTPR).toBe(0);
    expect(delegation.judgeTNR).toBe(0);
    expect(delegation.signalConfidence).toBe('low');
  });

  /** The judge is calibrated, but 5 gate executions and 3 eval runs are below the volume thresholds. */
  it('CorrelateWithCalibration_CalibratedButLowData_ReturnsMediumConfidence', () => {
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 5 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 3 } },
      [
        {
          skill: 'delegation',
          tpr: 0.90,
          tnr: 0.85,
          calibratedAt: '2026-02-20T00:00:00Z',
          sampleSize: 50,
        },
      ],
    );

    const result = correlateWithCalibration(codeQuality, evalResults);

    expect(result).toHaveLength(1);
    const delegation = result[0];
    expect(delegation.judgeCalibrated).toBe(true);
    expect(delegation.signalConfidence).toBe('medium');
  });

  it('CorrelateWithCalibration_BelowThresholdTPR_ReturnsLowConfidence', () => {
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 30 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 15 } },
      [
        {
          skill: 'delegation',
          tpr: 0.70,
          tnr: 0.90,
          calibratedAt: '2026-02-20T00:00:00Z',
          sampleSize: 50,
        },
      ],
    );

    const result = correlateWithCalibration(codeQuality, evalResults);

    expect(result).toHaveLength(1);
    expect(result[0].signalConfidence).toBe('low');
  });

  /** A skill that is only in the code-quality view gets no entry. */
  it('CorrelateWithCalibration_NoEvalResults_SkillExcluded', () => {
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 25 },
    });

    const evalResults = makeEvalResults({}, []);

    const result = correlateWithCalibration(codeQuality, evalResults);

    expect(result).toHaveLength(0);
  });

  /** `delegation` has a calibration, and `synthesis` has none. */
  it('CorrelateWithCalibration_MultipleSkills_CorrectCalibrationPerSkill', () => {
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 30 },
      synthesis: { gatePassRate: 0.7, totalExecutions: 25 },
    });

    const evalResults = makeEvalResults(
      {
        delegation: { latestScore: 0.85, totalRuns: 12 },
        synthesis: { latestScore: 0.60, totalRuns: 11 },
      },
      [
        {
          skill: 'delegation',
          tpr: 0.90,
          tnr: 0.85,
          calibratedAt: '2026-02-20T00:00:00Z',
          sampleSize: 50,
        },
      ],
    );

    const result = correlateWithCalibration(codeQuality, evalResults);

    expect(result).toHaveLength(2);
    const delegationCorr = result.find((c) => c.skill === 'delegation');
    const synthesisCorr = result.find((c) => c.skill === 'synthesis');

    expect(delegationCorr?.signalConfidence).toBe('high');
    expect(synthesisCorr?.signalConfidence).toBe('low');
  });

  /** The skill has two calibrations. The one with the later `calibratedAt` has the high rates. */
  it('CorrelateWithCalibration_MultipleCalibrations_UsesLatest', () => {
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 30 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 12 } },
      [
        {
          skill: 'delegation',
          tpr: 0.60,
          tnr: 0.60,
          calibratedAt: '2026-02-10T00:00:00Z',
          sampleSize: 20,
        },
        {
          skill: 'delegation',
          tpr: 0.92,
          tnr: 0.88,
          calibratedAt: '2026-02-22T00:00:00Z',
          sampleSize: 50,
        },
      ],
    );

    const result = correlateWithCalibration(codeQuality, evalResults);

    expect(result).toHaveLength(1);
    expect(result[0].judgeTPR).toBe(0.92);
    expect(result[0].judgeTNR).toBe(0.88);
    expect(result[0].signalConfidence).toBe('high');
  });

  /** `qualityTrend` comes from the base correlation, which derives it from `gatePassRate`. */
  it('CorrelateWithCalibration_PreservesBaseCorrelationFields', () => {
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.75, totalExecutions: 30 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.82, totalRuns: 15, trend: 'improving' } },
      [
        {
          skill: 'delegation',
          tpr: 0.90,
          tnr: 0.85,
          calibratedAt: '2026-02-20T00:00:00Z',
          sampleSize: 50,
        },
      ],
    );

    const result = correlateWithCalibration(codeQuality, evalResults);

    expect(result).toHaveLength(1);
    const corr = result[0];
    expect(corr.skill).toBe('delegation');
    expect(corr.gatePassRate).toBe(0.75);
    expect(corr.evalScore).toBe(0.82);
    expect(corr.evalTrend).toBe('improving');
    expect(corr.regressionCount).toBe(0);
    expect(corr.qualityTrend).toBe('stable');
  });
});

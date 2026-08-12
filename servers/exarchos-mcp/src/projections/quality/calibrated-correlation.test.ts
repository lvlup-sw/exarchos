import { describe, it, expect } from 'vitest';
import {
  correlateWithCalibration,
  deriveSignalConfidence,
} from './calibrated-correlation.js';
import type { CalibratedSkillCorrelation } from './calibrated-correlation.js';
import type { CodeQualityViewState } from '../views/code-quality-view.js';
import type { EvalResultsViewState } from '../views/eval-results-view.js';
import type { JudgeCalibration } from './calibrated-correlation.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

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

// ─── deriveSignalConfidence ──────────────────────────────────────────────────

describe('deriveSignalConfidence', () => {
  it('DeriveSignalConfidence_AllThresholdsMet_ReturnsHigh', () => {
    // Arrange: calibrated judge (TPR >= 0.85, TNR >= 0.80), 10+ eval runs, 20+ gate executions
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.85,
      totalEvalRuns: 12,
      totalGateExecutions: 25,
    });

    // Assert
    expect(result).toBe('high');
  });

  it('DeriveSignalConfidence_InsufficientVolume_ReturnsMedium', () => {
    // Arrange: calibrated judge but below data volume thresholds
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.85,
      totalEvalRuns: 5,   // below 10
      totalGateExecutions: 15, // below 20
    });

    // Assert
    expect(result).toBe('medium');
  });

  it('DeriveSignalConfidence_CalibratedButLowEvalRuns_ReturnsMedium', () => {
    // Arrange: calibrated judge, enough gate executions, but not enough eval runs
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.85,
      totalEvalRuns: 8,   // below 10
      totalGateExecutions: 30, // above 20
    });

    // Assert
    expect(result).toBe('medium');
  });

  it('DeriveSignalConfidence_CalibratedButLowGateExecutions_ReturnsMedium', () => {
    // Arrange: calibrated judge, enough eval runs, but not enough gate executions
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.85,
      totalEvalRuns: 15,  // above 10
      totalGateExecutions: 10, // below 20
    });

    // Assert
    expect(result).toBe('medium');
  });

  it('DeriveSignalConfidence_NotCalibrated_ReturnsLow', () => {
    // Arrange: judge not calibrated at all
    const result = deriveSignalConfidence({
      judgeCalibrated: false,
      judgeTPR: 0,
      judgeTNR: 0,
      totalEvalRuns: 50,
      totalGateExecutions: 100,
    });

    // Assert
    expect(result).toBe('low');
  });

  it('DeriveSignalConfidence_BelowTPRThreshold_ReturnsLow', () => {
    // Arrange: calibrated flag true but TPR below 0.85
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.70,   // below 0.85
      judgeTNR: 0.90,
      totalEvalRuns: 20,
      totalGateExecutions: 50,
    });

    // Assert
    expect(result).toBe('low');
  });

  it('DeriveSignalConfidence_BelowTNRThreshold_ReturnsLow', () => {
    // Arrange: calibrated flag true but TNR below 0.80
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.90,
      judgeTNR: 0.70,   // below 0.80
      totalEvalRuns: 20,
      totalGateExecutions: 50,
    });

    // Assert
    expect(result).toBe('low');
  });

  it('DeriveSignalConfidence_ExactThresholds_ReturnsHigh', () => {
    // Arrange: exactly at all thresholds
    const result = deriveSignalConfidence({
      judgeCalibrated: true,
      judgeTPR: 0.85,
      judgeTNR: 0.80,
      totalEvalRuns: 10,
      totalGateExecutions: 20,
    });

    // Assert
    expect(result).toBe('high');
  });
});

// ─── correlateWithCalibration ────────────────────────────────────────────────

describe('correlateWithCalibration', () => {
  it('CorrelateWithCalibration_CalibratedJudge_ReturnsHighConfidence', () => {
    // Arrange: skill with calibrated judge, sufficient data volume
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

    // Act
    const result = correlateWithCalibration(codeQuality, evalResults);

    // Assert
    expect(result).toHaveLength(1);
    const delegation = result[0];
    expect(delegation.skill).toBe('delegation');
    expect(delegation.judgeTPR).toBe(0.90);
    expect(delegation.judgeTNR).toBe(0.85);
    expect(delegation.judgeCalibrated).toBe(true);
    expect(delegation.signalConfidence).toBe('high');
    // Preserves base correlation fields
    expect(delegation.gatePassRate).toBe(0.9);
    expect(delegation.evalScore).toBe(0.85);
  });

  it('CorrelateWithCalibration_UncalibratedJudge_ReturnsLowConfidence', () => {
    // Arrange: skill present in both views but no calibration data
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 25 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 12 } },
      [], // no calibrations
    );

    // Act
    const result = correlateWithCalibration(codeQuality, evalResults);

    // Assert
    expect(result).toHaveLength(1);
    const delegation = result[0];
    expect(delegation.judgeCalibrated).toBe(false);
    expect(delegation.judgeTPR).toBe(0);
    expect(delegation.judgeTNR).toBe(0);
    expect(delegation.signalConfidence).toBe('low');
  });

  it('CorrelateWithCalibration_CalibratedButLowData_ReturnsMediumConfidence', () => {
    // Arrange: calibrated judge but insufficient data volume
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 5 }, // only 5 gate executions
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 3 } }, // only 3 eval runs
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

    // Act
    const result = correlateWithCalibration(codeQuality, evalResults);

    // Assert
    expect(result).toHaveLength(1);
    const delegation = result[0];
    expect(delegation.judgeCalibrated).toBe(true);
    expect(delegation.signalConfidence).toBe('medium');
  });

  it('CorrelateWithCalibration_BelowThresholdTPR_ReturnsLowConfidence', () => {
    // Arrange: calibration exists but TPR is below threshold
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 30 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 15 } },
      [
        {
          skill: 'delegation',
          tpr: 0.70, // below 0.85 threshold
          tnr: 0.90,
          calibratedAt: '2026-02-20T00:00:00Z',
          sampleSize: 50,
        },
      ],
    );

    // Act
    const result = correlateWithCalibration(codeQuality, evalResults);

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0].signalConfidence).toBe('low');
  });

  it('CorrelateWithCalibration_NoEvalResults_SkillExcluded', () => {
    // Arrange: skill in code quality but not in eval results
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 25 },
    });

    const evalResults = makeEvalResults({}, []);

    // Act
    const result = correlateWithCalibration(codeQuality, evalResults);

    // Assert
    expect(result).toHaveLength(0);
  });

  it('CorrelateWithCalibration_MultipleSkills_CorrectCalibrationPerSkill', () => {
    // Arrange: two skills with different calibration levels
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
        // synthesis has no calibration
      ],
    );

    // Act
    const result = correlateWithCalibration(codeQuality, evalResults);

    // Assert
    expect(result).toHaveLength(2);
    const delegationCorr = result.find((c) => c.skill === 'delegation');
    const synthesisCorr = result.find((c) => c.skill === 'synthesis');

    expect(delegationCorr?.signalConfidence).toBe('high');
    expect(synthesisCorr?.signalConfidence).toBe('low');
  });

  it('CorrelateWithCalibration_MultipleCalibrations_UsesLatest', () => {
    // Arrange: multiple calibration entries for same skill, should use latest
    const codeQuality = makeCodeQuality({
      delegation: { gatePassRate: 0.9, totalExecutions: 30 },
    });

    const evalResults = makeEvalResults(
      { delegation: { latestScore: 0.85, totalRuns: 12 } },
      [
        {
          skill: 'delegation',
          tpr: 0.60,  // old, low TPR
          tnr: 0.60,
          calibratedAt: '2026-02-10T00:00:00Z',
          sampleSize: 20,
        },
        {
          skill: 'delegation',
          tpr: 0.92,  // latest, high TPR
          tnr: 0.88,
          calibratedAt: '2026-02-22T00:00:00Z',
          sampleSize: 50,
        },
      ],
    );

    // Act
    const result = correlateWithCalibration(codeQuality, evalResults);

    // Assert
    expect(result).toHaveLength(1);
    expect(result[0].judgeTPR).toBe(0.92);
    expect(result[0].judgeTNR).toBe(0.88);
    expect(result[0].signalConfidence).toBe('high');
  });

  it('CorrelateWithCalibration_PreservesBaseCorrelationFields', () => {
    // Arrange
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

    // Act
    const result = correlateWithCalibration(codeQuality, evalResults);

    // Assert
    expect(result).toHaveLength(1);
    const corr = result[0];
    expect(corr.skill).toBe('delegation');
    expect(corr.gatePassRate).toBe(0.75);
    expect(corr.evalScore).toBe(0.82);
    expect(corr.evalTrend).toBe('improving');
    expect(corr.regressionCount).toBe(0);
    // qualityTrend derives from gatePassRate via existing logic
    expect(corr.qualityTrend).toBe('stable');
  });
});

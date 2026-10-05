import { describe, it, expect } from 'vitest';

import { codeQualityProjection } from '../../../../src/projections/views/code-quality-view.js';
import type { CodeQualityViewState } from '../../../../src/projections/views/code-quality-view.js';
import { evalResultsProjection } from '../../../../src/projections/views/eval-results-view.js';
import type { EvalResultsViewState } from '../../../../src/projections/views/eval-results-view.js';

import { correlateWithCalibration, deriveSignalConfidence } from '../../../../src/projections/quality/calibrated-correlation.js';
import type { JudgeCalibration, SignalConfidenceInput } from '../../../../src/projections/quality/calibrated-correlation.js';
import { evaluateRefinementSignals } from '../../../../src/projections/quality/refinement-signal.js';
import type { RefinementSignalInput } from '../../../../src/projections/quality/refinement-signal.js';
import { generateQualityHints } from '../../../../src/projections/quality/hints.js';
import type { CalibrationContext } from '../../../../src/projections/quality/hints.js';

import type { WorkflowEvent } from '../../../../src/events/schemas.js';

function makeEvent(
  type: string,
  data: Record<string, unknown>,
  seq: number,
  streamId = 'test-stream',
): WorkflowEvent {
  return {
    streamId,
    sequence: seq,
    timestamp: '2026-02-25T00:00:00.000Z',
    type: type as WorkflowEvent['type'],
    schemaVersion: '1.0',
    data,
  };
}

function makeGateEvent(
  seq: number,
  opts: {
    gateName: string;
    skill: string;
    passed: boolean;
    duration?: number;
    reason?: string;
    commit?: string;
    promptVersion?: string;
  },
): WorkflowEvent {
  return makeEvent('gate.executed', {
    gateName: opts.gateName,
    skill: opts.skill,
    layer: 'regression',
    passed: opts.passed,
    duration: opts.duration ?? 1200,
    details: {
      skill: opts.skill,
      reason: opts.reason ?? (opts.passed ? undefined : 'Type error in module'),
      commit: opts.commit ?? `commit-${seq}`,
      promptVersion: opts.promptVersion,
    },
  }, seq);
}

function makeCalibrationEvent(seq: number, opts: {
  skill: string;
  rubricName?: string;
  tpr: number;
  tnr: number;
  totalCases?: number;
  accuracy?: number;
  f1?: number;
}): WorkflowEvent {
  return makeEvent('eval.judge.calibrated', {
    skill: opts.skill,
    rubricName: opts.rubricName ?? 'completeness',
    split: 'validation',
    tpr: opts.tpr,
    tnr: opts.tnr,
    accuracy: opts.accuracy ?? 0.87,
    f1: opts.f1 ?? 0.88,
    tp: 27, fp: 2, tn: 25, fn: 3,
    goldStandardVersion: '1.0.0',
    rubricVersion: '1.0.0',
  }, seq);
}

function makeRemediationEvent(seq: number, opts: {
  skill: string;
  gateName: string;
  totalAttempts?: number;
  taskId?: string;
}): WorkflowEvent {
  return makeEvent('remediation.succeeded', {
    skill: opts.skill,
    gateName: opts.gateName,
    totalAttempts: opts.totalAttempts ?? 2,
    taskId: opts.taskId ?? 'task-001',
    finalStrategy: 'direct-fix',
  }, seq);
}

function makeEvalRunEvent(seq: number, opts: {
  suiteId: string;
  avgScore?: number;
  total?: number;
  passed?: number;
  failed?: number;
}): WorkflowEvent {
  return makeEvent('eval.run.completed', {
    runId: `run-${seq}`,
    suiteId: opts.suiteId,
    trigger: 'local',
    total: opts.total ?? 10,
    passed: opts.passed ?? 8,
    failed: opts.failed ?? 2,
    avgScore: opts.avgScore ?? 0.8,
    duration: 5000,
  }, seq);
}

function materializeCodeQuality(events: WorkflowEvent[]): CodeQualityViewState {
  let state = codeQualityProjection.init();
  for (const event of events) {
    state = codeQualityProjection.apply(state, event);
  }
  return state;
}

function materializeEvalResults(events: WorkflowEvent[]): EvalResultsViewState {
  let state = evalResultsProjection.init();
  for (const event of events) {
    state = evalResultsProjection.apply(state, event);
  }
  return state;
}

describe('Flywheel Integration', () => {
  it('FlywheelLoop_GateFailures_ProducesRefinementSignal', () => {
    const events: WorkflowEvent[] = [
      makeGateEvent(1, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(2, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(3, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(4, { gateName: 'typecheck', skill: 'delegation', passed: false }),
    ];

    const cqState = materializeCodeQuality(events);

    expect(cqState.regressions.length).toBeGreaterThanOrEqual(1);
    const regression = cqState.regressions.find(
      r => r.skill === 'delegation' && r.gate === 'typecheck',
    );
    expect(regression).toBeDefined();
    expect(regression!.consecutiveFailures).toBeGreaterThanOrEqual(3);

    const signalInput: RefinementSignalInput = {
      skill: 'delegation',
      signalConfidence: 'high',
      regressions: cqState.regressions,
      calibratedCorrelation: null,
      attribution: null,
      promptPaths: ['skills/delegation/SKILL.md'],
    };

    const signals = evaluateRefinementSignals(signalInput);

    expect(signals.length).toBeGreaterThanOrEqual(1);
    const regressionSignal = signals.find(s => s.trigger === 'regression');
    expect(regressionSignal).toBeDefined();
    expect(regressionSignal!.skill).toBe('delegation');
  });

  /**
   * The 12 eval runs and 24 gate executions meet the volume thresholds for `high` confidence.
   * The first 20 gate events pass and the last 4 fail, which makes a regression.
   */
  it('FlywheelLoop_CalibratedJudge_HighConfidenceSignal', () => {
    const calibrationEvent = makeCalibrationEvent(1, {
      skill: 'delegation',
      tpr: 0.90,
      tnr: 0.85,
    });

    const evalRunEvents: WorkflowEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evalRunEvents.push(makeEvalRunEvent(100 + i, { suiteId: 'delegation', avgScore: 0.85 }));
    }

    const evalState = materializeEvalResults([calibrationEvent, ...evalRunEvents]);
    expect(evalState.calibrations.length).toBe(1);
    expect(evalState.calibrations[0].skill).toBe('delegation');
    expect(evalState.calibrations[0].tpr).toBe(0.90);
    expect(evalState.calibrations[0].tnr).toBe(0.85);

    const gateEvents: WorkflowEvent[] = [];
    for (let i = 2; i <= 25; i++) {
      gateEvents.push(makeGateEvent(i, {
        gateName: 'typecheck',
        skill: 'delegation',
        passed: i < 22,
      }));
    }
    const cqState = materializeCodeQuality(gateEvents);

    const calibrations: JudgeCalibration[] = [{
      skill: 'delegation',
      tpr: 0.90,
      tnr: 0.85,
      calibratedAt: '2026-02-25T00:00:00.000Z',
      sampleSize: 30,
    }];

    const enrichedEvalState = {
      ...evalState,
      calibrations,
    };
    const correlations = correlateWithCalibration(cqState, enrichedEvalState);

    const delegationCorrelation = correlations.find(c => c.skill === 'delegation');
    expect(delegationCorrelation).toBeDefined();
    expect(delegationCorrelation!.signalConfidence).toBe('high');

    const signals = evaluateRefinementSignals({
      skill: 'delegation',
      signalConfidence: delegationCorrelation!.signalConfidence,
      regressions: cqState.regressions,
      calibratedCorrelation: delegationCorrelation!,
      attribution: null,
      promptPaths: ['skills/delegation/SKILL.md'],
    });

    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].signalConfidence).toBe('high');
  });

  it('FlywheelLoop_UncalibratedJudge_NoSignalEmitted', () => {
    const gateEvents: WorkflowEvent[] = [
      makeGateEvent(1, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(2, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(3, { gateName: 'typecheck', skill: 'delegation', passed: false }),
    ];
    const cqState = materializeCodeQuality(gateEvents);

    expect(cqState.regressions.length).toBeGreaterThanOrEqual(1);

    const confidenceInput: SignalConfidenceInput = {
      judgeCalibrated: false,
      judgeTPR: 0,
      judgeTNR: 0,
      totalEvalRuns: 0,
      totalGateExecutions: 3,
    };
    const confidence = deriveSignalConfidence(confidenceInput);
    expect(confidence).toBe('low');

    const signals = evaluateRefinementSignals({
      skill: 'delegation',
      signalConfidence: 'low',
      regressions: cqState.regressions,
      calibratedCorrelation: null,
      attribution: null,
      promptPaths: ['skills/delegation/SKILL.md'],
    });

    expect(signals).toEqual([]);
  });

  it('FlywheelLoop_AttributionOutlier_SuggestsModelChange', () => {
    const attribution = {
      dimension: 'prompt-version' as const,
      entries: [],
      correlations: [{
        factor1: 'gatePassRate',
        factor2: 'evalScore',
        direction: 'negative' as const,
        strength: 0.85,
      }],
    };

    const signals = evaluateRefinementSignals({
      skill: 'delegation',
      signalConfidence: 'high',
      regressions: [],
      calibratedCorrelation: null,
      attribution,
      promptPaths: ['skills/delegation/SKILL.md'],
    });

    const outlierSignal = signals.find(s => s.trigger === 'attribution-outlier');
    expect(outlierSignal).toBeDefined();
    expect(outlierSignal!.skill).toBe('delegation');
    expect(outlierSignal!.suggestedAction).toBeDefined();
  });

  /** The eval runs put `delegation` in the eval view, because `correlateWithCalibration` needs the skill in both views. */
  it('FlywheelLoop_EndToEnd_EventsFlowThroughAllComponents', () => {
    const events: WorkflowEvent[] = [
      makeGateEvent(1, { gateName: 'typecheck', skill: 'delegation', passed: true }),
      makeGateEvent(2, { gateName: 'lint', skill: 'delegation', passed: true }),
      makeGateEvent(3, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(4, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(5, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(6, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeRemediationEvent(7, { skill: 'delegation', gateName: 'typecheck' }),
      makeRemediationEvent(8, { skill: 'delegation', gateName: 'typecheck', totalAttempts: 3 }),
      makeCalibrationEvent(9, { skill: 'delegation', tpr: 0.90, tnr: 0.85 }),
    ];

    const evalRunEvents: WorkflowEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evalRunEvents.push(makeEvalRunEvent(100 + i, { suiteId: 'delegation', avgScore: 0.82 }));
    }

    const cqState = materializeCodeQuality(events);
    const evalState = materializeEvalResults([...events, ...evalRunEvents]);

    expect(cqState.regressions.length).toBeGreaterThanOrEqual(1);
    expect(evalState.calibrations.length).toBe(1);
    expect(evalState.skills['delegation']).toBeDefined();

    const calibrations: JudgeCalibration[] = evalState.calibrations.map(c => ({
      skill: c.skill,
      tpr: c.tpr,
      tnr: c.tnr,
      calibratedAt: '2026-02-25T00:00:00.000Z',
      sampleSize: 30,
    }));

    const enrichedEvalState = {
      ...evalState,
      calibrations,
    };
    const correlationResults = correlateWithCalibration(cqState, enrichedEvalState);

    const delegationCorrelation = correlationResults.find(c => c.skill === 'delegation');

    const signalConfidence = delegationCorrelation?.signalConfidence ?? 'low';
    const signals = evaluateRefinementSignals({
      skill: 'delegation',
      signalConfidence,
      regressions: cqState.regressions,
      calibratedCorrelation: delegationCorrelation ?? null,
      attribution: null,
      promptPaths: ['skills/delegation/SKILL.md'],
    });

    const calibrationContext: CalibrationContext = {
      signalConfidence,
      refinementSignals: signals,
    };

    const hints = generateQualityHints(cqState, undefined, calibrationContext);

    expect(hints.length).toBeGreaterThan(0);
    const gateHint = hints.find(h => h.category === 'gate');
    expect(gateHint).toBeDefined();

    if (signals.length > 0) {
      const refinementHint = hints.find(h => h.category === 'refinement');
      expect(refinementHint).toBeDefined();
    }

    expect(delegationCorrelation).toBeDefined();
  });
});

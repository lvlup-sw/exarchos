import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Views
import { codeQualityProjection } from '../../views/code-quality-view.js';
import type { CodeQualityViewState, QualityRegression, GateMetrics } from '../../views/code-quality-view.js';
import { evalResultsProjection } from '../../views/eval-results-view.js';
import type { EvalResultsViewState } from '../../views/eval-results-view.js';

// Quality modules
import { correlateWithCalibration, deriveSignalConfidence } from '../calibrated-correlation.js';
import type { JudgeCalibration, SignalConfidenceInput } from '../calibrated-correlation.js';
import { evaluateRefinementSignals } from '../refinement-signal.js';
import type { RefinementSignalInput } from '../refinement-signal.js';
import { generateRegressionEval, writeAutoRegressionCase } from '../regression-eval-generator.js';
import type { SignalConfidence } from '../regression-eval-generator.js';
import { generateQualityHints } from '../hints.js';
import type { CalibrationContext } from '../hints.js';

// Event types
import type { WorkflowEvent } from '../../event-store/schemas.js';

// ─── Test Helpers ──────────────────────────────────────────────────────────

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
    totalCases: opts.totalCases ?? 30,
    f1: opts.f1 ?? 0.88,
    goldStandardVersion: '1.0.0',
    rubricVersion: '1.0.0',
  }, seq);
}

function makeRemediationEvent(seq: number, opts: {
  skill: string;
  gate: string;
  attempts?: number;
  durationMs?: number;
}): WorkflowEvent {
  return makeEvent('remediation.succeeded', {
    skill: opts.skill,
    gate: opts.gate,
    attempts: opts.attempts ?? 2,
    durationMs: opts.durationMs ?? 5000,
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

// ─── Integration Tests ────────────────────────────────────────────────────

describe('Flywheel Integration', () => {
  // ─── Test 1 ──────────────────────────────────────────────────────────────

  it('FlywheelLoop_GateFailures_ProducesRefinementSignal', () => {
    // Arrange: Emit 4 gate.executed events with passed: false for the same skill/gate
    const events: WorkflowEvent[] = [
      makeGateEvent(1, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(2, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(3, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(4, { gateName: 'typecheck', skill: 'delegation', passed: false }),
    ];

    // Act: Materialize CodeQualityView
    const cqState = materializeCodeQuality(events);

    // Assert: regression is detected
    expect(cqState.regressions.length).toBeGreaterThanOrEqual(1);
    const regression = cqState.regressions.find(
      r => r.skill === 'delegation' && r.gate === 'typecheck',
    );
    expect(regression).toBeDefined();
    expect(regression!.consecutiveFailures).toBeGreaterThanOrEqual(3);

    // Act: Feed into evaluateRefinementSignals with high confidence
    const signalInput: RefinementSignalInput = {
      skill: 'delegation',
      signalConfidence: 'high',
      regressions: cqState.regressions,
      calibratedCorrelation: null,
      attribution: null,
      promptPaths: ['skills/delegation/SKILL.md'],
    };

    const signals = evaluateRefinementSignals(signalInput);

    // Assert: at least one refinement signal with trigger: 'regression'
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const regressionSignal = signals.find(s => s.trigger === 'regression');
    expect(regressionSignal).toBeDefined();
    expect(regressionSignal!.skill).toBe('delegation');
  });

  // ─── Test 2 ──────────────────────────────────────────────────────────────

  it('FlywheelLoop_CalibratedJudge_HighConfidenceSignal', () => {
    // Arrange: Emit an eval.judge.calibrated event with high TPR/TNR
    const calibrationEvent = makeCalibrationEvent(1, {
      skill: 'delegation',
      tpr: 0.90,
      tnr: 0.85,
    });

    // Also emit eval runs so the delegation skill exists in eval results
    const evalRunEvents: WorkflowEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evalRunEvents.push(makeEvalRunEvent(100 + i, { suiteId: 'delegation', avgScore: 0.85 }));
    }

    // Act: Materialize EvalResultsView — verify calibration is recorded
    const evalState = materializeEvalResults([calibrationEvent, ...evalRunEvents]);
    expect(evalState.calibrations.length).toBe(1);
    expect(evalState.calibrations[0].skill).toBe('delegation');
    expect(evalState.calibrations[0].tpr).toBe(0.90);
    expect(evalState.calibrations[0].tnr).toBe(0.85);

    // Arrange: Sufficient gate events to trigger high data volume
    const gateEvents: WorkflowEvent[] = [];
    for (let i = 2; i <= 25; i++) {
      gateEvents.push(makeGateEvent(i, {
        gateName: 'typecheck',
        skill: 'delegation',
        passed: i < 22, // first 20 pass, last 4 fail → regression
      }));
    }
    const cqState = materializeCodeQuality(gateEvents);

    // Act: correlateWithCalibration
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

    // Find delegation correlation
    const delegationCorrelation = correlations.find(c => c.skill === 'delegation');
    expect(delegationCorrelation).toBeDefined();
    expect(delegationCorrelation!.signalConfidence).toBe('high');

    // Act: evaluateRefinementSignals with the correlation + regression
    const signals = evaluateRefinementSignals({
      skill: 'delegation',
      signalConfidence: delegationCorrelation!.signalConfidence,
      regressions: cqState.regressions,
      calibratedCorrelation: delegationCorrelation!,
      attribution: null,
      promptPaths: ['skills/delegation/SKILL.md'],
    });

    // Assert: signal has signalConfidence: 'high'
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].signalConfidence).toBe('high');
  });

  // ─── Test 3 ──────────────────────────────────────────────────────────────

  it('FlywheelLoop_UncalibratedJudge_NoSignalEmitted', () => {
    // Arrange: No calibration event — judge uncalibrated
    const gateEvents: WorkflowEvent[] = [
      makeGateEvent(1, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(2, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(3, { gateName: 'typecheck', skill: 'delegation', passed: false }),
    ];
    const cqState = materializeCodeQuality(gateEvents);

    // Assert: regression exists
    expect(cqState.regressions.length).toBeGreaterThanOrEqual(1);

    // Act: deriveSignalConfidence returns 'low' when no calibration
    const confidenceInput: SignalConfidenceInput = {
      judgeCalibrated: false,
      judgeTPR: 0,
      judgeTNR: 0,
      totalEvalRuns: 0,
      totalGateExecutions: 3,
    };
    const confidence = deriveSignalConfidence(confidenceInput);
    expect(confidence).toBe('low');

    // Act: evaluateRefinementSignals returns empty array for low confidence
    const signals = evaluateRefinementSignals({
      skill: 'delegation',
      signalConfidence: 'low',
      regressions: cqState.regressions,
      calibratedCorrelation: null,
      attribution: null,
      promptPaths: ['skills/delegation/SKILL.md'],
    });

    // Assert: no signals emitted because confidence is too low
    expect(signals).toEqual([]);
  });

  // ─── Test 4 ──────────────────────────────────────────────────────────────

  it('FlywheelLoop_CapturedTrace_GeneratesRegressionEval', async () => {
    // Arrange: Set up a regression
    const regression: QualityRegression = {
      skill: 'delegation',
      gate: 'typecheck',
      consecutiveFailures: 4,
      firstFailureCommit: 'commit-1',
      lastFailureCommit: 'commit-4',
      detectedAt: '2026-02-25T00:00:00.000Z',
    };

    const traces: WorkflowEvent[] = [
      makeGateEvent(1, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(2, { gateName: 'typecheck', skill: 'delegation', passed: false }),
    ];

    const gateMetrics: GateMetrics = {
      gate: 'typecheck',
      executionCount: 10,
      passRate: 0.6,
      avgDuration: 1500,
      failureReasons: [{ reason: 'Type error in module', count: 4 }],
    };

    // Act: generateRegressionEval with high confidence
    const evalCase = generateRegressionEval(regression, traces, gateMetrics, 'high');

    // Assert: returns a GeneratedRegressionCase
    expect(evalCase).not.toBeNull();
    expect(evalCase!.source).toBe('auto-generated');
    expect(evalCase!.trigger).toEqual(regression);
    expect(evalCase!.evalCase).toBeDefined();
    expect(evalCase!.evalCase.tags).toContain('auto-generated');

    // Act: writeAutoRegressionCase with a temp directory
    const tempDir = await mkdtemp(join(tmpdir(), 'flywheel-test-'));
    try {
      const result = await writeAutoRegressionCase(evalCase!, tempDir);

      // Assert: file is written with valid JSONL
      expect(result.written).toBe(true);
      const content = await readFile(result.path, 'utf-8');
      expect(content.trim()).not.toBe('');

      // Verify it's valid JSON (JSONL is one JSON object per line)
      const parsed = JSON.parse(content.trim());
      expect(parsed.id).toBeDefined();
      expect(parsed.type).toBeDefined();
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  // ─── Test 5 ──────────────────────────────────────────────────────────────

  it('FlywheelLoop_AttributionOutlier_SuggestsModelChange', () => {
    // Arrange: Attribution data with strong negative correlation in prompt-version dimension
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

    // Act: evaluateRefinementSignals with high confidence + attribution
    const signals = evaluateRefinementSignals({
      skill: 'delegation',
      signalConfidence: 'high',
      regressions: [],
      calibratedCorrelation: null,
      attribution,
      promptPaths: ['skills/delegation/SKILL.md'],
    });

    // Assert: signal has trigger: 'attribution-outlier'
    const outlierSignal = signals.find(s => s.trigger === 'attribution-outlier');
    expect(outlierSignal).toBeDefined();
    expect(outlierSignal!.skill).toBe('delegation');
    expect(outlierSignal!.suggestedAction).toBeDefined();
  });

  // ─── Test 6 ──────────────────────────────────────────────────────────────

  it('FlywheelLoop_EndToEnd_EventsFlowThroughAllComponents', () => {
    // Step 1: Create events
    const events: WorkflowEvent[] = [
      // Some passing gate events
      makeGateEvent(1, { gateName: 'typecheck', skill: 'delegation', passed: true }),
      makeGateEvent(2, { gateName: 'lint', skill: 'delegation', passed: true }),
      // Failing gate events (to create regression)
      makeGateEvent(3, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(4, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(5, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(6, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      // Remediation events
      makeRemediationEvent(7, { skill: 'delegation', gate: 'typecheck' }),
      makeRemediationEvent(8, { skill: 'delegation', gate: 'typecheck', attempts: 3 }),
      // Calibration event
      makeCalibrationEvent(9, { skill: 'delegation', tpr: 0.90, tnr: 0.85 }),
    ];

    // Eval run events — needed to populate evalResults.skills['delegation']
    // (correlateWithCalibration requires skills in both views)
    const evalRunEvents: WorkflowEvent[] = [];
    for (let i = 0; i < 12; i++) {
      evalRunEvents.push(makeEvalRunEvent(100 + i, { suiteId: 'delegation', avgScore: 0.82 }));
    }

    // Step 2: Materialize both views
    const cqState = materializeCodeQuality(events);
    const evalState = materializeEvalResults([...events, ...evalRunEvents]);

    // Verify views materialized correctly
    expect(cqState.regressions.length).toBeGreaterThanOrEqual(1);
    expect(evalState.calibrations.length).toBe(1);
    expect(evalState.skills['delegation']).toBeDefined();

    // Step 3: Build calibration-enriched eval state
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

    // Find delegation correlation
    const delegationCorrelation = correlationResults.find(c => c.skill === 'delegation');

    // Step 4: evaluateRefinementSignals
    const signalConfidence = delegationCorrelation?.signalConfidence ?? 'low';
    const signals = evaluateRefinementSignals({
      skill: 'delegation',
      signalConfidence,
      regressions: cqState.regressions,
      calibratedCorrelation: delegationCorrelation ?? null,
      attribution: null,
      promptPaths: ['skills/delegation/SKILL.md'],
    });

    // Step 5: generateQualityHints with calibration context
    const calibrationContext: CalibrationContext = {
      signalConfidence,
      refinementSignals: signals,
    };

    const hints = generateQualityHints(cqState, undefined, calibrationContext);

    // Assert: hints include gate-related hints (from regression/low pass rate)
    expect(hints.length).toBeGreaterThan(0);
    const gateHint = hints.find(h => h.category === 'gate');
    expect(gateHint).toBeDefined();

    // Should have refinement hints from signals (if signals were generated)
    if (signals.length > 0) {
      const refinementHint = hints.find(h => h.category === 'refinement');
      expect(refinementHint).toBeDefined();
    }

    // Verify the full chain produced actionable output
    expect(delegationCorrelation).toBeDefined();
  });
});

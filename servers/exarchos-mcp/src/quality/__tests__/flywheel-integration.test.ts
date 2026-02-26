import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Views
import { codeQualityProjection } from '../../views/code-quality-view.js';
import type { CodeQualityViewState, QualityRegression } from '../../views/code-quality-view.js';
import { evalResultsProjection } from '../../views/eval-results-view.js';
import type { EvalResultsViewState } from '../../views/eval-results-view.js';

// Quality modules
import { correlateWithCalibration, deriveSignalConfidence } from '../calibrated-correlation.js';
import type { CalibrationData, EnrichedViewStates } from '../calibrated-correlation.js';
import { evaluateRefinementSignals } from '../refinement-signal.js';
import type { RefinementSignalInput } from '../refinement-signal.js';
import { generateRegressionEval, writeAutoRegressionCase } from '../regression-eval-generator.js';
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
  f1?: number;
}): WorkflowEvent {
  return makeEvent('eval.judge.calibrated', {
    skill: opts.skill,
    rubricName: opts.rubricName ?? 'completeness',
    split: 'validation',
    tpr: opts.tpr,
    tnr: opts.tnr,
    totalCases: opts.totalCases ?? 30,
    f1: opts.f1 ?? 0.88,
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

    // Act: Create calibrated correlation with high confidence calibration
    const calibration: CalibrationData = {
      skill: 'delegation',
      rubricName: 'completeness',
      tpr: 0.90,
      tnr: 0.85,
      totalCases: 30,
      f1: 0.88,
    };

    const enriched: EnrichedViewStates = {
      codeQuality: cqState,
      evalResults: evalResultsProjection.init(),
      calibrations: [calibration],
    };

    const correlation = correlateWithCalibration(enriched);

    // Act: Feed into evaluateRefinementSignals
    const signalInput: RefinementSignalInput = {
      correlations: correlation.skills,
      regressions: cqState.regressions,
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

    // Act: Materialize EvalResultsView — verify calibration is recorded
    const evalState = materializeEvalResults([calibrationEvent]);
    expect(evalState.calibrations.length).toBe(1);
    expect(evalState.calibrations[0].skill).toBe('delegation');
    expect(evalState.calibrations[0].tpr).toBe(0.90);
    expect(evalState.calibrations[0].tnr).toBe(0.85);

    // Arrange: Create code quality state with a regression
    const gateEvents: WorkflowEvent[] = [
      makeGateEvent(2, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(3, { gateName: 'typecheck', skill: 'delegation', passed: false }),
      makeGateEvent(4, { gateName: 'typecheck', skill: 'delegation', passed: false }),
    ];
    const cqState = materializeCodeQuality(gateEvents);

    // Act: correlateWithCalibration using enriched view states
    const enriched: EnrichedViewStates = {
      codeQuality: cqState,
      evalResults: evalState,
      calibrations: evalState.calibrations.map(c => ({
        skill: c.skill,
        rubricName: c.rubricName,
        tpr: c.tpr,
        tnr: c.tnr,
        totalCases: c.totalCases,
        f1: c.f1,
      })),
    };
    const correlation = correlateWithCalibration(enriched);

    // Act: evaluateRefinementSignals with the correlation + regression
    const signals = evaluateRefinementSignals({
      correlations: correlation.skills,
      regressions: cqState.regressions,
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
    const confidence = deriveSignalConfidence(null);
    expect(confidence).toBe('low');

    // Act: correlateWithCalibration with no calibrations
    const enriched: EnrichedViewStates = {
      codeQuality: cqState,
      evalResults: evalResultsProjection.init(),
      calibrations: [],
    };
    const correlation = correlateWithCalibration(enriched);

    // Verify the correlation has low signal confidence
    expect(correlation.skills['delegation'].signalConfidence).toBe('low');

    // Act: evaluateRefinementSignals returns empty array
    const signals = evaluateRefinementSignals({
      correlations: correlation.skills,
      regressions: cqState.regressions,
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

    const traces = [
      { gate: 'typecheck', skill: 'delegation', failureReason: 'TS2345', commit: 'commit-1' },
      { gate: 'typecheck', skill: 'delegation', failureReason: 'TS2345', commit: 'commit-2' },
    ];

    // Act: generateRegressionEval with high confidence
    const evalCase = generateRegressionEval({
      regression,
      traces,
      confidence: 'high',
    });

    // Assert: returns a GeneratedRegressionCase with source: 'auto-generated'
    expect(evalCase).not.toBeNull();
    expect(evalCase!.source).toBe('auto-generated');
    expect(evalCase!.skill).toBe('delegation');
    expect(evalCase!.gate).toBe('typecheck');
    expect(evalCase!.confidence).toBe('high');
    expect(evalCase!.traces).toHaveLength(2);

    // Act: writeAutoRegressionCase with a temp directory
    const tempDir = await mkdtemp(join(tmpdir(), 'flywheel-test-'));
    try {
      const filepath = await writeAutoRegressionCase(evalCase!, tempDir);

      // Assert: file is written with valid JSONL
      const content = await readFile(filepath, 'utf-8');
      expect(content.trim()).not.toBe('');

      // Verify it's valid JSON (JSONL is one JSON object per line)
      const parsed = JSON.parse(content.trim());
      expect(parsed.source).toBe('auto-generated');
      expect(parsed.skill).toBe('delegation');
      expect(parsed.gate).toBe('typecheck');
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });

  // ─── Test 5 ──────────────────────────────────────────────────────────────

  it('FlywheelLoop_AttributionOutlier_SuggestsModelChange', () => {
    // Arrange: Code quality state with a skill
    const gateEvents: WorkflowEvent[] = [
      makeGateEvent(1, { gateName: 'typecheck', skill: 'delegation', passed: false, promptVersion: 'v1.2' }),
      makeGateEvent(2, { gateName: 'typecheck', skill: 'delegation', passed: false, promptVersion: 'v1.2' }),
      makeGateEvent(3, { gateName: 'typecheck', skill: 'delegation', passed: false, promptVersion: 'v1.2' }),
    ];
    const cqState = materializeCodeQuality(gateEvents);

    // Arrange: Calibrated correlation with high confidence
    const calibration: CalibrationData = {
      skill: 'delegation',
      rubricName: 'completeness',
      tpr: 0.92,
      tnr: 0.88,
      totalCases: 40,
      f1: 0.90,
    };

    const enriched: EnrichedViewStates = {
      codeQuality: cqState,
      evalResults: evalResultsProjection.init(),
      calibrations: [calibration],
    };
    const correlation = correlateWithCalibration(enriched);

    // Arrange: Attribution data with strong negative correlation in prompt-version dimension
    const attributionOutliers = [
      {
        skill: 'delegation',
        dimension: 'prompt-version',
        correlationStrength: -0.85,
        direction: 'negative' as const,
        sampleSize: 20,
      },
    ];

    // Act: evaluateRefinementSignals with high confidence + attribution
    const signals = evaluateRefinementSignals({
      correlations: correlation.skills,
      regressions: cqState.regressions,
      attributionOutliers,
    });

    // Assert: signal has trigger: 'attribution-outlier'
    const outlierSignal = signals.find(s => s.trigger === 'attribution-outlier');
    expect(outlierSignal).toBeDefined();
    expect(outlierSignal!.skill).toBe('delegation');
    expect(outlierSignal!.attribution).toBeDefined();
    expect(outlierSignal!.attribution!.dimension).toBe('prompt-version');
    expect(outlierSignal!.suggestedAction).toContain('prompt-version');
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

    // Step 2: Materialize both views
    const cqState = materializeCodeQuality(events);
    const evalState = materializeEvalResults(events);

    // Verify views materialized correctly
    expect(cqState.regressions.length).toBeGreaterThanOrEqual(1);
    expect(evalState.calibrations.length).toBe(1);

    // Step 3: correlateWithCalibration
    const enriched: EnrichedViewStates = {
      codeQuality: cqState,
      evalResults: evalState,
      calibrations: evalState.calibrations.map(c => ({
        skill: c.skill,
        rubricName: c.rubricName,
        tpr: c.tpr,
        tnr: c.tnr,
        totalCases: c.totalCases,
        f1: c.f1,
      })),
    };
    const correlation = correlateWithCalibration(enriched);

    // Step 4: evaluateRefinementSignals
    const signals = evaluateRefinementSignals({
      correlations: correlation.skills,
      regressions: cqState.regressions,
    });

    // Step 5: generateQualityHints with calibration context
    const calibrationContext: CalibrationContext = {
      signalConfidence: correlation.skills['delegation']?.signalConfidence ?? 'low',
      refinementSignals: signals,
    };

    const hints = generateQualityHints(cqState, undefined, calibrationContext);

    // Assert: hints include both 'actionable' confidence and refinement suggestions
    expect(hints.length).toBeGreaterThan(0);

    // Should have at least one gate-related hint (from regression/low pass rate)
    const gateHint = hints.find(h => h.category === 'gate');
    expect(gateHint).toBeDefined();

    // Should have refinement hints from signals (if signals were generated)
    if (signals.length > 0) {
      const refinementHint = hints.find(h => h.category === 'refinement');
      expect(refinementHint).toBeDefined();
      expect(refinementHint!.confidence).toBe('high');
    }

    // Verify the full chain produced actionable output
    expect(correlation.skills['delegation']).toBeDefined();
    expect(correlation.skills['delegation'].signalConfidence).toBe('high');
  });
});

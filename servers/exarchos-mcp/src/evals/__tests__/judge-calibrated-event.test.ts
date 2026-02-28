import { describe, it, expect } from 'vitest';
import {
  JudgeCalibratedDataSchema,
  EventTypes,
} from '../../event-store/schemas.js';
import {
  evalResultsProjection,
  type EvalResultsViewState,
} from '../../views/eval-results-view.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeEvent(
  sequence: number,
  type: string,
  data: Record<string, unknown>,
): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence,
    timestamp: `2025-06-01T10:00:0${sequence}.000Z`,
    type: type as WorkflowEvent['type'],
    schemaVersion: '1.0',
    data,
  };
}

// ─── Schema Tests ───────────────────────────────────────────────────────────

describe('JudgeCalibratedDataSchema', () => {
  it('JudgeCalibratedDataSchema_ValidData_ParsesSuccessfully', () => {
    // Arrange
    const validData = {
      skill: 'code-review',
      rubricName: 'correctness',
      split: 'validation',
      tpr: 0.92,
      tnr: 0.88,
      accuracy: 0.90,
      f1: 0.91,
      goldStandardVersion: 'abc123def456',
      rubricVersion: '1.2.0',
    };

    // Act
    const parsed = JudgeCalibratedDataSchema.parse(validData);

    // Assert
    expect(parsed.skill).toBe('code-review');
    expect(parsed.rubricName).toBe('correctness');
    expect(parsed.split).toBe('validation');
    expect(parsed.tpr).toBe(0.92);
    expect(parsed.tnr).toBe(0.88);
    expect(parsed.accuracy).toBe(0.90);
    expect(parsed.f1).toBe(0.91);
    expect(parsed.goldStandardVersion).toBe('abc123def456');
    expect(parsed.rubricVersion).toBe('1.2.0');
  });

  it('JudgeCalibratedDataSchema_TestSplit_ParsesSuccessfully', () => {
    // Arrange
    const validData = {
      skill: 'debugging',
      rubricName: 'root-cause',
      split: 'test',
      tpr: 0.85,
      tnr: 0.90,
      accuracy: 0.87,
      f1: 0.86,
      goldStandardVersion: 'deadbeef',
      rubricVersion: '2.0.0',
    };

    // Act
    const parsed = JudgeCalibratedDataSchema.parse(validData);

    // Assert
    expect(parsed.split).toBe('test');
  });

  it('JudgeCalibratedDataSchema_MissingTPR_ThrowsValidationError', () => {
    // Arrange
    const invalidData = {
      skill: 'code-review',
      rubricName: 'correctness',
      split: 'validation',
      // tpr is missing
      tnr: 0.88,
      accuracy: 0.90,
      f1: 0.91,
      goldStandardVersion: 'abc123',
      rubricVersion: '1.0.0',
    };

    // Act & Assert
    expect(() => JudgeCalibratedDataSchema.parse(invalidData)).toThrow();
  });

  it('JudgeCalibratedDataSchema_InvalidSplit_ThrowsValidationError', () => {
    // Arrange
    const invalidData = {
      skill: 'code-review',
      rubricName: 'correctness',
      split: 'training',  // invalid — must be 'validation' or 'test'
      tpr: 0.92,
      tnr: 0.88,
      accuracy: 0.90,
      f1: 0.91,
      goldStandardVersion: 'abc123',
      rubricVersion: '1.0.0',
    };

    // Act & Assert
    expect(() => JudgeCalibratedDataSchema.parse(invalidData)).toThrow();
  });
});

describe('EventTypes — eval.judge.calibrated', () => {
  it('EventTypes_IncludesJudgeCalibrated', () => {
    expect(EventTypes).toContain('eval.judge.calibrated');
  });
});

// ─── View Tests ─────────────────────────────────────────────────────────────

describe('EvalResultsView — eval.judge.calibrated handler', () => {
  it('EvalResultsView_JudgeCalibratedEvent_TracksCalibrationHistory', () => {
    // Arrange
    const init = evalResultsProjection.init();
    const event = makeEvent(1, 'eval.judge.calibrated', {
      skill: 'code-review',
      rubricName: 'correctness',
      split: 'validation',
      tpr: 0.92,
      tnr: 0.88,
      accuracy: 0.90,
      f1: 0.91,
      goldStandardVersion: 'abc123',
      rubricVersion: '1.0.0',
    });

    // Act
    const result = evalResultsProjection.apply(init, event);

    // Assert
    expect(result.calibrations).toHaveLength(1);
    expect(result.calibrations[0].skill).toBe('code-review');
    expect(result.calibrations[0].rubricName).toBe('correctness');
    expect(result.calibrations[0].split).toBe('validation');
    expect(result.calibrations[0].tpr).toBe(0.92);
    expect(result.calibrations[0].tnr).toBe(0.88);
    expect(result.calibrations[0].accuracy).toBe(0.90);
    expect(result.calibrations[0].f1).toBe(0.91);
    expect(result.calibrations[0].calibratedAt).toBe('2025-06-01T10:00:01.000Z');
  });

  it('EvalResultsView_JudgeCalibratedEvent_UpdatesLatestCalibration', () => {
    // Arrange
    const init = evalResultsProjection.init();
    const event1 = makeEvent(1, 'eval.judge.calibrated', {
      skill: 'code-review',
      rubricName: 'correctness',
      split: 'validation',
      tpr: 0.80,
      tnr: 0.75,
      accuracy: 0.78,
      f1: 0.79,
      goldStandardVersion: 'aaa111',
      rubricVersion: '1.0.0',
    });
    const event2 = makeEvent(2, 'eval.judge.calibrated', {
      skill: 'code-review',
      rubricName: 'correctness',
      split: 'validation',
      tpr: 0.92,
      tnr: 0.88,
      accuracy: 0.90,
      f1: 0.91,
      goldStandardVersion: 'bbb222',
      rubricVersion: '1.1.0',
    });

    // Act
    const state1 = evalResultsProjection.apply(init, event1);
    const state2 = evalResultsProjection.apply(state1, event2);

    // Assert — latest calibration is the most recent one appended
    expect(state2.calibrations).toHaveLength(2);
    const latest = state2.calibrations[state2.calibrations.length - 1];
    expect(latest.tpr).toBe(0.92);
    expect(latest.calibratedAt).toBe('2025-06-01T10:00:02.000Z');
  });

  it('EvalResultsView_MultipleCalibrations_KeepsHistory', () => {
    // Arrange
    const init = evalResultsProjection.init();
    const events = [
      makeEvent(1, 'eval.judge.calibrated', {
        skill: 'code-review',
        rubricName: 'correctness',
        split: 'validation',
        tpr: 0.80,
        tnr: 0.75,
        accuracy: 0.78,
        f1: 0.79,
        goldStandardVersion: 'aaa111',
        rubricVersion: '1.0.0',
      }),
      makeEvent(2, 'eval.judge.calibrated', {
        skill: 'debugging',
        rubricName: 'root-cause',
        split: 'test',
        tpr: 0.85,
        tnr: 0.90,
        accuracy: 0.87,
        f1: 0.86,
        goldStandardVersion: 'bbb222',
        rubricVersion: '2.0.0',
      }),
      makeEvent(3, 'eval.judge.calibrated', {
        skill: 'code-review',
        rubricName: 'correctness',
        split: 'validation',
        tpr: 0.95,
        tnr: 0.93,
        accuracy: 0.94,
        f1: 0.94,
        goldStandardVersion: 'ccc333',
        rubricVersion: '1.2.0',
      }),
    ];

    // Act
    let state: EvalResultsViewState = init;
    for (const event of events) {
      state = evalResultsProjection.apply(state, event);
    }

    // Assert — all three calibrations are preserved in order
    expect(state.calibrations).toHaveLength(3);
    expect(state.calibrations[0].skill).toBe('code-review');
    expect(state.calibrations[0].tpr).toBe(0.80);
    expect(state.calibrations[1].skill).toBe('debugging');
    expect(state.calibrations[1].tpr).toBe(0.85);
    expect(state.calibrations[2].skill).toBe('code-review');
    expect(state.calibrations[2].tpr).toBe(0.95);
  });

  it('EvalResultsView_JudgeCalibratedEvent_NoData_ReturnsUnchanged', () => {
    // Arrange
    const init = evalResultsProjection.init();
    const event: WorkflowEvent = {
      streamId: 'test-stream',
      sequence: 1,
      timestamp: '2025-06-01T10:00:00.000Z',
      type: 'eval.judge.calibrated' as WorkflowEvent['type'],
      schemaVersion: '1.0',
      // no data
    };

    // Act
    const result = evalResultsProjection.apply(init, event);

    // Assert — calibrations should remain empty
    expect(result.calibrations).toHaveLength(0);
  });
});

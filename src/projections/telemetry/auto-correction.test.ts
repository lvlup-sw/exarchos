import { describe, it, expect } from 'vitest';
import { matchCorrection, applyCorrections, ConsistencyTracker } from './auto-correction.js';
import type { ToolMetrics } from './telemetry-projection.js';
import { initToolMetrics } from './telemetry-projection.js';

/** Helper: creates ToolMetrics with specified overrides. */
function makeMetrics(overrides: Partial<ToolMetrics> = {}): ToolMetrics {
  return { ...initToolMetrics(), ...overrides };
}

describe('matchCorrection', () => {
  it('MatchCorrectionRule_ViewTasksExceedsThreshold_NoFields_ReturnsFieldsCorrection', () => {
    // Arrange
    const metrics = makeMetrics({ p95Bytes: 1500 });
    const args: Record<string, unknown> = {};
    const consecutiveBreaches = 5;

    // Act
    const result = matchCorrection('exarchos_view', 'tasks', args, metrics, consecutiveBreaches);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.param).toBe('fields');
    expect(result!.value).toEqual(['id', 'title', 'status', 'assignee']);
  });

  it('MatchCorrectionRule_EventQueryExceedsThreshold_NoLimit_ReturnsLimitCorrection', () => {
    // Arrange
    const metrics = makeMetrics({ p95Bytes: 2500 });
    const args: Record<string, unknown> = {};
    const consecutiveBreaches = 5;

    // Act
    const result = matchCorrection('exarchos_event', 'query', args, metrics, consecutiveBreaches);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.param).toBe('limit');
    expect(result!.value).toBe(50);
  });

  it('MatchCorrectionRule_WorkflowGetExceedsThreshold_NoFieldsNoQuery_ReturnsFieldsCorrection', () => {
    // Arrange
    const metrics = makeMetrics({ p95Bytes: 800 });
    const args: Record<string, unknown> = {};
    const consecutiveBreaches = 5;

    // Act
    const result = matchCorrection('exarchos_workflow', 'get', args, metrics, consecutiveBreaches);

    // Assert
    expect(result).not.toBeNull();
    expect(result!.param).toBe('fields');
    expect(result!.value).toEqual(['phase', 'tasks', 'artifacts']);
  });

  it('MatchCorrectionRule_ExplicitFieldsProvided_ReturnsNull', () => {
    // Arrange
    const metrics = makeMetrics({ p95Bytes: 1500 });
    const args: Record<string, unknown> = { fields: ['id'] };
    const consecutiveBreaches = 5;

    // Act
    const result = matchCorrection('exarchos_view', 'tasks', args, metrics, consecutiveBreaches);

    // Assert — additive-only: no correction when fields already set
    expect(result).toBeNull();
  });

  it('MatchCorrectionRule_BelowConsistencyWindow_ReturnsNull', () => {
    // Arrange
    const metrics = makeMetrics({ p95Bytes: 1500 });
    const args: Record<string, unknown> = {};
    const consecutiveBreaches = 3; // Below CONSISTENCY_WINDOW_SIZE of 5

    // Act
    const result = matchCorrection('exarchos_view', 'tasks', args, metrics, consecutiveBreaches);

    // Assert
    expect(result).toBeNull();
  });
});

describe('applyCorrections', () => {
  it('ApplyCorrections_SkipAutoCorrection_ReturnsOriginalArgs', () => {
    // Arrange
    const args: Record<string, unknown> = { skipAutoCorrection: true, action: 'tasks' };
    const corrections = [{ param: 'fields', value: ['id', 'title'], rule: 'exarchos_view:tasks:fields' }];

    // Act
    const result = applyCorrections(args, corrections);

    // Assert
    expect(result.args).toEqual(args);
    expect(result.applied).toEqual([]);
  });

  it('ApplyCorrections_WithCorrections_ReturnsModifiedArgs', () => {
    // Arrange
    const args: Record<string, unknown> = { action: 'tasks' };
    const corrections = [{ param: 'fields', value: ['id', 'title'], rule: 'exarchos_view:tasks:fields' }];

    // Act
    const result = applyCorrections(args, corrections);

    // Assert
    expect(result.args).toEqual({ action: 'tasks', fields: ['id', 'title'] });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].param).toBe('fields');
  });
});

describe('ConsistencyTracker', () => {
  it('ConsistencyTracker_RecordBreach_TracksConsecutiveCount', () => {
    // Arrange
    const tracker = new ConsistencyTracker();
    const key = 'exarchos_view:tasks:p95Bytes';

    // Act — record 3 breaches, then a non-breach, then 2 more breaches
    expect(tracker.record(key, true)).toBe(1);
    expect(tracker.record(key, true)).toBe(2);
    expect(tracker.record(key, true)).toBe(3);

    // Non-breach resets the counter
    expect(tracker.record(key, false)).toBe(0);

    // Starts counting again from 1
    expect(tracker.record(key, true)).toBe(1);
    expect(tracker.record(key, true)).toBe(2);
  });

  it('ConsistencyTracker_BelowWindowSize_NoCorrection', () => {
    // Arrange
    const tracker = new ConsistencyTracker();
    const key = 'exarchos_view:tasks:p95Bytes';

    // Act — record 4 breaches (below CONSISTENCY_WINDOW_SIZE of 5)
    for (let i = 0; i < 4; i++) {
      tracker.record(key, true);
    }

    // Assert — not yet at the window size
    expect(tracker.shouldCorrect(key)).toBe(false);

    // 5th breach crosses the threshold
    tracker.record(key, true);
    expect(tracker.shouldCorrect(key)).toBe(true);
  });
});

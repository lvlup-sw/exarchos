import { describe, it, expect } from 'vitest';
import { matchCorrection, applyCorrections, ConsistencyTracker } from '../../../../src/projections/telemetry/auto-correction.js';
import type { ToolMetrics } from '../../../../src/projections/telemetry/telemetry-projection.js';
import { initToolMetrics } from '../../../../src/projections/telemetry/telemetry-projection.js';

/** Builds a `ToolMetrics` from the initial values and the given overrides. */
function makeMetrics(overrides: Partial<ToolMetrics> = {}): ToolMetrics {
  return { ...initToolMetrics(), ...overrides };
}

describe('matchCorrection', () => {
  it('MatchCorrectionRule_ViewTasksExceedsThreshold_NoFields_ReturnsFieldsCorrection', () => {
    const metrics = makeMetrics({ p95Bytes: 1500 });
    const args: Record<string, unknown> = {};
    const consecutiveBreaches = 5;

    const result = matchCorrection('exarchos_view', 'tasks', args, metrics, consecutiveBreaches);

    expect(result).not.toBeNull();
    expect(result!.param).toBe('fields');
    expect(result!.value).toEqual(['id', 'title', 'status', 'assignee']);
  });

  it('MatchCorrectionRule_EventQueryExceedsThreshold_NoLimit_ReturnsLimitCorrection', () => {
    const metrics = makeMetrics({ p95Bytes: 2500 });
    const args: Record<string, unknown> = {};
    const consecutiveBreaches = 5;

    const result = matchCorrection('exarchos_event', 'query', args, metrics, consecutiveBreaches);

    expect(result).not.toBeNull();
    expect(result!.param).toBe('limit');
    expect(result!.value).toBe(50);
  });

  it('MatchCorrectionRule_WorkflowGetExceedsThreshold_NoFieldsNoQuery_ReturnsFieldsCorrection', () => {
    const metrics = makeMetrics({ p95Bytes: 800 });
    const args: Record<string, unknown> = {};
    const consecutiveBreaches = 5;

    const result = matchCorrection('exarchos_workflow', 'get', args, metrics, consecutiveBreaches);

    expect(result).not.toBeNull();
    expect(result!.param).toBe('fields');
    expect(result!.value).toEqual(['phase', 'tasks', 'artifacts']);
  });

  /** The rule matches only when the caller did not set `fields`. */
  it('MatchCorrectionRule_ExplicitFieldsProvided_ReturnsNull', () => {
    const metrics = makeMetrics({ p95Bytes: 1500 });
    const args: Record<string, unknown> = { fields: ['id'] };
    const consecutiveBreaches = 5;

    const result = matchCorrection('exarchos_view', 'tasks', args, metrics, consecutiveBreaches);

    expect(result).toBeNull();
  });

  /** Three consecutive breaches are fewer than `CONSISTENCY_WINDOW_SIZE`, which is 5. */
  it('MatchCorrectionRule_BelowConsistencyWindow_ReturnsNull', () => {
    const metrics = makeMetrics({ p95Bytes: 1500 });
    const args: Record<string, unknown> = {};
    const consecutiveBreaches = 3;

    const result = matchCorrection('exarchos_view', 'tasks', args, metrics, consecutiveBreaches);

    expect(result).toBeNull();
  });
});

describe('applyCorrections', () => {
  it('ApplyCorrections_SkipAutoCorrection_ReturnsOriginalArgs', () => {
    const args: Record<string, unknown> = { skipAutoCorrection: true, action: 'tasks' };
    const corrections = [{ param: 'fields', value: ['id', 'title'], rule: 'exarchos_view:tasks:fields' }];

    const result = applyCorrections(args, corrections);

    expect(result.args).toEqual(args);
    expect(result.applied).toEqual([]);
  });

  it('ApplyCorrections_WithCorrections_ReturnsModifiedArgs', () => {
    const args: Record<string, unknown> = { action: 'tasks' };
    const corrections = [{ param: 'fields', value: ['id', 'title'], rule: 'exarchos_view:tasks:fields' }];

    const result = applyCorrections(args, corrections);

    expect(result.args).toEqual({ action: 'tasks', fields: ['id', 'title'] });
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].param).toBe('fields');
  });
});

describe('ConsistencyTracker', () => {
  /** A non-breach resets the counter to 0, and the next breach counts from 1. */
  it('ConsistencyTracker_RecordBreach_TracksConsecutiveCount', () => {
    const tracker = new ConsistencyTracker();
    const key = 'exarchos_view:tasks:p95Bytes';

    expect(tracker.record(key, true)).toBe(1);
    expect(tracker.record(key, true)).toBe(2);
    expect(tracker.record(key, true)).toBe(3);

    expect(tracker.record(key, false)).toBe(0);

    expect(tracker.record(key, true)).toBe(1);
    expect(tracker.record(key, true)).toBe(2);
  });

  /** Four breaches are fewer than `CONSISTENCY_WINDOW_SIZE`. The fifth breach reaches it. */
  it('ConsistencyTracker_BelowWindowSize_NoCorrection', () => {
    const tracker = new ConsistencyTracker();
    const key = 'exarchos_view:tasks:p95Bytes';

    for (let i = 0; i < 4; i++) {
      tracker.record(key, true);
    }

    expect(tracker.shouldCorrect(key)).toBe(false);

    tracker.record(key, true);
    expect(tracker.shouldCorrect(key)).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateQualityHints } from '../../../../src/projections/quality/hints.js';
import type { QualityHint, CalibrationContext } from '../../../../src/projections/quality/hints.js';
import type { CodeQualityViewState } from '../../../../src/projections/views/code-quality-view.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { RefinementSignal } from '../../../../src/projections/quality/refinement-signal.js';
import type { TelemetryViewState } from '../../../../src/projections/telemetry/telemetry-projection.js';
import { initToolMetrics } from '../../../../src/projections/telemetry/telemetry-projection.js';

function makeState(overrides: Partial<CodeQualityViewState> = {}): CodeQualityViewState {
  return {
    skills: {},
    gates: {},
    regressions: [],
    benchmarks: [],
    ...overrides,
  };
}

describe('generateQualityHints', () => {
  describe('empty and missing state', () => {
    it('should return empty array for empty state', () => {
      const state = makeState();
      const hints = generateQualityHints(state);
      expect(hints).toEqual([]);
    });

    it('should return empty array when no skills in state', () => {
      const state = makeState({ skills: {} });
      const hints = generateQualityHints(state);
      expect(hints).toEqual([]);
    });
  });

  describe('targetSkill filtering', () => {
    it('should scope hints to targetSkill only', () => {
      const state = makeState({
        skills: {
          alpha: {
            skill: 'alpha',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'lint', count: 1 }],
          },
          beta: {
            skill: 'beta',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'test', count: 1 }],
          },
        },
      });

      const hints = generateQualityHints(state, 'alpha');
      const skillHints = hints.filter(h => h.category === 'gate');
      expect(skillHints).toHaveLength(1);
      expect(skillHints[0].skill).toBe('alpha');
    });

    it('should return hints for all skills when no targetSkill', () => {
      const state = makeState({
        skills: {
          alpha: {
            skill: 'alpha',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'lint', count: 1 }],
          },
          beta: {
            skill: 'beta',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'test', count: 1 }],
          },
        },
      });

      const hints = generateQualityHints(state);
      const gateHints = hints.filter(h => h.category === 'gate');
      expect(gateHints).toHaveLength(2);
      expect(gateHints.map(h => h.skill).sort()).toEqual(['alpha', 'beta']);
    });
  });

  describe('gate pass rate rule', () => {
    it('should return warning hint when gate pass rate is below threshold', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1.5,
            topFailureCategories: [
              { category: 'lint', count: 5 },
              { category: 'type-check', count: 3 },
              { category: 'test', count: 2 },
            ],
          },
        },
      });

      const hints = generateQualityHints(state);

      expect(hints).toHaveLength(1);
      expect(hints[0].skill).toBe('my-skill');
      expect(hints[0].category).toBe('gate');
      expect(hints[0].severity).toBe('warning');
      expect(hints[0].hint).toContain('70%');
      expect(hints[0].hint).toContain('lint');
      expect(hints[0].hint).toContain('type-check');
      expect(hints[0].hint).toContain('test');
    });

    it('should return no hint when gate pass rate is at threshold', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.80,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
      });

      const hints = generateQualityHints(state);
      expect(hints).toHaveLength(0);
    });

    it('should return no hint when gate pass rate is above threshold', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.95,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
      });

      const hints = generateQualityHints(state);
      expect(hints).toHaveLength(0);
    });
  });

  describe('consecutive failures rule', () => {
    it('should return warning hint when consecutive failures >= 3', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        regressions: [
          {
            skill: 'my-skill',
            gate: 'check-types',
            consecutiveFailures: 3,
            firstFailureCommit: 'abc123',
            lastFailureCommit: 'def456',
            detectedAt: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const hints = generateQualityHints(state);
      const failureHint = hints.find(h => h.category === 'gate' && h.hint.includes('consecutive'));

      expect(failureHint).toBeDefined();
      expect(failureHint!.skill).toBe('my-skill');
      expect(failureHint!.severity).toBe('warning');
      expect(failureHint!.hint).toContain('check-types');
      expect(failureHint!.hint).toContain('3');
    });

    it('should return no hint when consecutive failures < 3', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        regressions: [
          {
            skill: 'my-skill',
            gate: 'check-types',
            consecutiveFailures: 2,
            firstFailureCommit: 'abc123',
            lastFailureCommit: 'def456',
            detectedAt: '2024-01-01T00:00:00Z',
          },
        ],
      });

      const hints = generateQualityHints(state);
      const failureHint = hints.find(h => h.hint.includes('consecutive'));
      expect(failureHint).toBeUndefined();
    });

    it('should return no hint when no regressions exist', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        regressions: [],
      });

      const hints = generateQualityHints(state);
      const failureHint = hints.find(h => h.hint.includes('consecutive'));
      expect(failureHint).toBeUndefined();
    });
  });

  describe('benchmark regression rule', () => {
    it('should return warning hint when benchmark is degrading', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        benchmarks: [
          {
            operation: 'event-append',
            metric: 'latency-ms',
            values: [
              { value: 10, commit: 'a', timestamp: '2024-01-01T00:00:00Z' },
              { value: 20, commit: 'b', timestamp: '2024-01-02T00:00:00Z' },
              { value: 30, commit: 'c', timestamp: '2024-01-03T00:00:00Z' },
            ],
            trend: 'degrading',
          },
        ],
      });

      const hints = generateQualityHints(state);
      const benchHint = hints.find(h => h.category === 'benchmark');

      expect(benchHint).toBeDefined();
      expect(benchHint!.severity).toBe('warning');
      expect(benchHint!.hint).toContain('event-append');
    });

    it('should return no hint when benchmark is stable', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        benchmarks: [
          {
            operation: 'event-append',
            metric: 'latency-ms',
            values: [{ value: 10, commit: 'a', timestamp: '2024-01-01T00:00:00Z' }],
            trend: 'stable',
          },
        ],
      });

      const hints = generateQualityHints(state);
      const benchHint = hints.find(h => h.category === 'benchmark');
      expect(benchHint).toBeUndefined();
    });

    it('should return no hint when benchmark is improving', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        benchmarks: [
          {
            operation: 'event-append',
            metric: 'latency-ms',
            values: [{ value: 10, commit: 'a', timestamp: '2024-01-01T00:00:00Z' }],
            trend: 'improving',
          },
        ],
      });

      const hints = generateQualityHints(state);
      const benchHint = hints.find(h => h.category === 'benchmark');
      expect(benchHint).toBeUndefined();
    });
  });

  describe('self-correction rate rule', () => {
    it('should return info hint when self-correction rate is high', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 20,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.35,
            avgRemediationAttempts: 2,
            topFailureCategories: [],
          },
        },
      });

      const hints = generateQualityHints(state);
      const scHint = hints.find(h => h.hint.includes('self-correction'));

      expect(scHint).toBeDefined();
      expect(scHint!.skill).toBe('my-skill');
      expect(scHint!.severity).toBe('info');
      expect(scHint!.hint).toContain('35%');
    });

    it('should return no hint when self-correction rate is low', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 20,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.20,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
      });

      const hints = generateQualityHints(state);
      const scHint = hints.find(h => h.hint.includes('self-correction'));
      expect(scHint).toBeUndefined();
    });
  });

  describe('PBT failure rule', () => {
    it('should return warning hint when PBT gate failure rate is above threshold', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 20,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        gates: {
          'check-property-tests': {
            gate: 'check-property-tests',
            executionCount: 20,
            passRate: 0.80,
            avgDuration: 100,
            failureReasons: [{ reason: 'property violation', count: 4 }],
          },
        },
      });

      const hints = generateQualityHints(state);
      const pbtHint = hints.find(h => h.category === 'pbt');

      expect(pbtHint).toBeDefined();
      expect(pbtHint!.severity).toBe('warning');
      expect(pbtHint!.hint).toContain('20%');
    });

    it('should return no hint when PBT gate pass rate is high', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 20,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        gates: {
          'check-property-tests': {
            gate: 'check-property-tests',
            executionCount: 20,
            passRate: 0.95,
            avgDuration: 100,
            failureReasons: [],
          },
        },
      });

      const hints = generateQualityHints(state);
      const pbtHint = hints.find(h => h.category === 'pbt');
      expect(pbtHint).toBeUndefined();
    });

    it('should return no hint when no PBT gate exists', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 20,
            gatePassRate: 0.90,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
        gates: {},
      });

      const hints = generateQualityHints(state);
      const pbtHint = hints.find(h => h.category === 'pbt');
      expect(pbtHint).toBeUndefined();
    });
  });

  describe('hint cap and prioritization', () => {
    /** The three skills each trigger two rules, so the uncapped list holds more than 5 hints. */
    it('should return at most 5 hints when more are generated', () => {
      const state = makeState({
        skills: {
          'skill-a': {
            skill: 'skill-a',
            totalExecutions: 20,
            gatePassRate: 0.50,
            selfCorrectionRate: 0.40,
            avgRemediationAttempts: 3,
            topFailureCategories: [{ category: 'lint', count: 10 }],
          },
          'skill-b': {
            skill: 'skill-b',
            totalExecutions: 20,
            gatePassRate: 0.60,
            selfCorrectionRate: 0.35,
            avgRemediationAttempts: 2,
            topFailureCategories: [{ category: 'test', count: 8 }],
          },
          'skill-c': {
            skill: 'skill-c',
            totalExecutions: 20,
            gatePassRate: 0.55,
            selfCorrectionRate: 0.50,
            avgRemediationAttempts: 4,
            topFailureCategories: [{ category: 'build', count: 9 }],
          },
        },
        benchmarks: [
          {
            operation: 'event-append',
            metric: 'latency-ms',
            values: [{ value: 10, commit: 'a', timestamp: '2024-01-01T00:00:00Z' }],
            trend: 'degrading',
          },
        ],
        gates: {
          'check-property-tests': {
            gate: 'check-property-tests',
            executionCount: 20,
            passRate: 0.70,
            avgDuration: 100,
            failureReasons: [{ reason: 'violation', count: 6 }],
          },
        },
      });

      const hints = generateQualityHints(state);
      expect(hints.length).toBeLessThanOrEqual(5);
    });

    /** The skill triggers a warning for a low gate pass rate and an info hint for a high self-correction rate. */
    it('should prioritize warnings over info hints', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 20,
            gatePassRate: 0.50,
            selfCorrectionRate: 0.40,
            avgRemediationAttempts: 3,
            topFailureCategories: [{ category: 'lint', count: 10 }],
          },
        },
      });

      const hints = generateQualityHints(state);
      const warningIdx = hints.findIndex(h => h.severity === 'warning');
      const infoIdx = hints.findIndex(h => h.severity === 'info');

      expect(warningIdx).not.toBe(-1);
      expect(infoIdx).not.toBe(-1);
      expect(warningIdx).toBeLessThan(infoIdx);
    });

    it('should filter to targetSkill only', () => {
      const state = makeState({
        skills: {
          'skill-a': {
            skill: 'skill-a',
            totalExecutions: 10,
            gatePassRate: 0.50,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'lint', count: 5 }],
          },
          'skill-b': {
            skill: 'skill-b',
            totalExecutions: 10,
            gatePassRate: 0.60,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'test', count: 4 }],
          },
        },
      });

      const hints = generateQualityHints(state, 'skill-a');
      expect(hints.every(h => h.skill === 'skill-a')).toBe(true);
      expect(hints.length).toBeGreaterThan(0);
    });

    it('should return empty array when targetSkill is not in state', () => {
      const state = makeState({
        skills: {
          'skill-a': {
            skill: 'skill-a',
            totalExecutions: 10,
            gatePassRate: 0.50,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'lint', count: 5 }],
          },
        },
      });

      const hints = generateQualityHints(state, 'nonexistent-skill');
      expect(hints).toEqual([]);
    });

    it('should return hints for all skills when no targetSkill provided', () => {
      const state = makeState({
        skills: {
          'skill-a': {
            skill: 'skill-a',
            totalExecutions: 10,
            gatePassRate: 0.50,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'lint', count: 5 }],
          },
          'skill-b': {
            skill: 'skill-b',
            totalExecutions: 10,
            gatePassRate: 0.60,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [{ category: 'test', count: 4 }],
          },
        },
      });

      const hints = generateQualityHints(state);
      const skillsInHints = new Set(hints.map(h => h.skill));
      expect(skillsInHints.has('skill-a')).toBe(true);
      expect(skillsInHints.has('skill-b')).toBe(true);
    });
  });

  describe('event emission', () => {
    let mockEventStore: { append: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      mockEventStore = {
        append: vi.fn().mockResolvedValue({}),
      };
    });

    it('GenerateQualityHints_WithHints_EmitsEvent', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1.5,
            topFailureCategories: [
              { category: 'lint', count: 5 },
              { category: 'type-check', count: 3 },
            ],
          },
        },
      });

      const hints = generateQualityHints(state, 'my-skill', undefined, undefined, mockEventStore as unknown as EventStore);

      expect(hints.length).toBeGreaterThan(0);
      expect(mockEventStore.append).toHaveBeenCalledTimes(1);

      const [streamId, event] = mockEventStore.append.mock.calls[0];
      expect(streamId).toBe('quality-hints');
      expect(event.type).toBe('quality.hint.generated');
      expect(event.data.skill).toBe('my-skill');
      expect(event.data.hintCount).toBe(hints.length);
      expect(event.data.categories).toEqual(expect.arrayContaining(['gate']));
      expect(event.data.generatedAt).toBeDefined();
    });

    it('GenerateQualityHints_NoHints_DoesNotEmitEvent', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.95,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1,
            topFailureCategories: [],
          },
        },
      });

      const hints = generateQualityHints(state, 'my-skill', undefined, undefined, mockEventStore as unknown as EventStore);

      expect(hints).toHaveLength(0);
      expect(mockEventStore.append).not.toHaveBeenCalled();
    });

    it('GenerateQualityHints_NoTargetSkill_EmitsGlobalSkill', () => {
      const state = makeState({
        skills: {
          'alpha': {
            skill: 'alpha',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1.5,
            topFailureCategories: [{ category: 'lint', count: 5 }],
          },
        },
      });

      generateQualityHints(state, undefined, undefined, undefined, mockEventStore as unknown as EventStore);

      expect(mockEventStore.append).toHaveBeenCalledTimes(1);
      const [, event] = mockEventStore.append.mock.calls[0];
      expect(event.data.skill).toBe('global');
    });

    it('GenerateQualityHints_EventStoreNull_DoesNotThrow', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1.5,
            topFailureCategories: [{ category: 'lint', count: 5 }],
          },
        },
      });

      const hints = generateQualityHints(state, 'my-skill', undefined, undefined, null);
      expect(hints.length).toBeGreaterThan(0);
    });

    /** The function does not wait for the append and ignores its failure. */
    it('GenerateQualityHints_EventStoreAppendFails_DoesNotThrow', () => {
      mockEventStore.append.mockRejectedValue(new Error('append failed'));

      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1.5,
            topFailureCategories: [{ category: 'lint', count: 5 }],
          },
        },
      });

      const hints = generateQualityHints(state, 'my-skill', undefined, undefined, mockEventStore as unknown as EventStore);
      expect(hints.length).toBeGreaterThan(0);
      expect(mockEventStore.append).toHaveBeenCalledTimes(1);
    });

    it('GenerateQualityHints_MultipleCategories_EmitsUniqueCategories', () => {
      const state = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 20,
            gatePassRate: 0.50,
            selfCorrectionRate: 0.40,
            avgRemediationAttempts: 3,
            topFailureCategories: [{ category: 'lint', count: 10 }],
          },
        },
        benchmarks: [
          {
            operation: 'event-append',
            metric: 'latency-ms',
            values: [{ value: 10, commit: 'a', timestamp: '2024-01-01T00:00:00Z' }],
            trend: 'degrading',
          },
        ],
      });

      generateQualityHints(state, undefined, undefined, undefined, mockEventStore as unknown as EventStore);

      const [, event] = mockEventStore.append.mock.calls[0];
      const categories = event.data.categories as string[];
      expect(categories.length).toBe(new Set(categories).size);
      expect(categories).toContain('gate');
      expect(categories).toContain('benchmark');
    });
  });

  describe('telemetry hint integration', () => {
    function makeTelemetryState(tools: Record<string, Partial<ReturnType<typeof initToolMetrics>>>): TelemetryViewState {
      const fullTools: Record<string, ReturnType<typeof initToolMetrics>> = {};
      for (const [name, partial] of Object.entries(tools)) {
        fullTools[name] = { ...initToolMetrics(), ...partial };
      }
      return {
        tools: fullTools,
        sessionStart: new Date().toISOString(),
        totalInvocations: 0,
        totalTokens: 0,
        windowSize: 1000,
      };
    }

    it('GenerateQualityHints_WithTelemetryHints_IncludesTelemetryCategory', () => {
      const qualityState = makeState();
      const telemetryState = makeTelemetryState({
        view_tasks: { p95Bytes: 1500 },
      });

      const hints = generateQualityHints(qualityState, undefined, undefined, telemetryState);

      const telemetryHints = hints.filter(h => h.category === 'telemetry');
      expect(telemetryHints.length).toBeGreaterThan(0);
      expect(telemetryHints[0].skill).toBe('global');
      expect(telemetryHints[0].severity).toBe('info');
    });

    it('GenerateQualityHints_WithoutTelemetryState_OmitsTelemetryHints', () => {
      const qualityState = makeState();

      const hints = generateQualityHints(qualityState);

      const telemetryHints = hints.filter(h => h.category === 'telemetry');
      expect(telemetryHints).toHaveLength(0);
    });

    it('GenerateQualityHints_TelemetryHintsSortedWithOthers', () => {
      const qualityState = makeState({
        skills: {
          'my-skill': {
            skill: 'my-skill',
            totalExecutions: 10,
            gatePassRate: 0.70,
            selfCorrectionRate: 0.10,
            avgRemediationAttempts: 1.5,
            topFailureCategories: [{ category: 'lint', count: 5 }],
          },
        },
      });
      const telemetryState = makeTelemetryState({
        view_tasks: { p95Bytes: 1500 },
      });

      const hints = generateQualityHints(qualityState, undefined, undefined, telemetryState);

      const warningIdx = hints.findIndex(h => h.severity === 'warning');
      const telemetryIdx = hints.findIndex(h => h.category === 'telemetry');

      expect(warningIdx).not.toBe(-1);
      expect(telemetryIdx).not.toBe(-1);
      expect(warningIdx).toBeLessThan(telemetryIdx);
    });

    it('GenerateQualityHints_TelemetryNoThresholdsExceeded_NoTelemetryHints', () => {
      const qualityState = makeState();
      const telemetryState = makeTelemetryState({
        view_tasks: { p95Bytes: 100 },
        workflow_get: { p95Bytes: 50 },
      });

      const hints = generateQualityHints(qualityState, undefined, undefined, telemetryState);

      const telemetryHints = hints.filter(h => h.category === 'telemetry');
      expect(telemetryHints).toHaveLength(0);
    });

    it('GenerateQualityHints_TelemetryHintsCountTowardsCap', () => {
      const qualityState = makeState({
        skills: {
          'skill-a': {
            skill: 'skill-a',
            totalExecutions: 20,
            gatePassRate: 0.50,
            selfCorrectionRate: 0.40,
            avgRemediationAttempts: 3,
            topFailureCategories: [{ category: 'lint', count: 10 }],
          },
          'skill-b': {
            skill: 'skill-b',
            totalExecutions: 20,
            gatePassRate: 0.60,
            selfCorrectionRate: 0.35,
            avgRemediationAttempts: 2,
            topFailureCategories: [{ category: 'test', count: 8 }],
          },
          'skill-c': {
            skill: 'skill-c',
            totalExecutions: 20,
            gatePassRate: 0.55,
            selfCorrectionRate: 0.50,
            avgRemediationAttempts: 4,
            topFailureCategories: [{ category: 'build', count: 9 }],
          },
        },
      });
      const telemetryState = makeTelemetryState({
        view_tasks: { p95Bytes: 1500 },
        workflow_get: { p95Bytes: 800 },
        event_query: { p95Bytes: 2500 },
      });

      const hints = generateQualityHints(qualityState, undefined, undefined, telemetryState);

      expect(hints.length).toBeLessThanOrEqual(5);
    });
  });

  describe('calibration context enrichment', () => {
    const baseSkillState = {
      skills: {
        'my-skill': {
          skill: 'my-skill',
          totalExecutions: 10,
          gatePassRate: 0.70,
          selfCorrectionRate: 0.10,
          avgRemediationAttempts: 1.5,
          topFailureCategories: [
            { category: 'lint', count: 5 },
            { category: 'type-check', count: 3 },
          ],
        },
      },
    };

    const makeRefinementSignal = (overrides: Partial<RefinementSignal> = {}): RefinementSignal => ({
      skill: 'my-skill',
      signalConfidence: 'high',
      trigger: 'regression',
      evidence: {
        metric: 'gate-pass-rate',
        baseline: 0.90,
        current: 0.70,
        threshold: 0.80,
      },
      suggestedAction: 'Review gate configuration for lint rules',
      affectedPromptPaths: ['skills/my-skill/prompts/lint-check.md'],
      ...overrides,
    });

    it('GenerateQualityHints_WithCalibration_IncludesConfidenceLevel', () => {
      const state = makeState(baseSkillState);
      const calibration: CalibrationContext = {
        signalConfidence: 'high',
        refinementSignals: [],
      };

      const hints = generateQualityHints(state, 'my-skill', calibration);

      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) {
        expect(hint.confidenceLevel).toBeDefined();
      }
    });

    it('GenerateQualityHints_LowConfidence_MarksAsAdvisory', () => {
      const state = makeState(baseSkillState);
      const calibration: CalibrationContext = {
        signalConfidence: 'low',
        refinementSignals: [],
      };

      const hints = generateQualityHints(state, 'my-skill', calibration);

      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) {
        expect(hint.confidenceLevel).toBe('advisory');
      }
    });

    it('GenerateQualityHints_HighConfidence_MarksAsActionable', () => {
      const state = makeState(baseSkillState);
      const calibration: CalibrationContext = {
        signalConfidence: 'high',
        refinementSignals: [],
      };

      const hints = generateQualityHints(state, 'my-skill', calibration);

      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) {
        expect(hint.confidenceLevel).toBe('actionable');
      }
    });

    it('GenerateQualityHints_WithRefinementSuggestion_IncludesPromptPaths', () => {
      const state = makeState(baseSkillState);
      const signal = makeRefinementSignal();
      const calibration: CalibrationContext = {
        signalConfidence: 'high',
        refinementSignals: [signal],
      };

      const hints = generateQualityHints(state, 'my-skill', calibration);

      const refinementHint = hints.find(h => h.category === 'refinement');
      expect(refinementHint).toBeDefined();
      expect(refinementHint!.hint).toContain(signal.suggestedAction);
      expect(refinementHint!.affectedPromptPaths).toEqual(signal.affectedPromptPaths);
    });

    /** With no calibration context, a hint has no `confidenceLevel`. The test also accepts `advisory`. */
    it('GenerateQualityHints_NoCalibrationData_DefaultsToLowConfidence', () => {
      const state = makeState(baseSkillState);

      const hints = generateQualityHints(state, 'my-skill');

      expect(hints.length).toBeGreaterThan(0);
      for (const hint of hints) {
        expect([undefined, 'advisory']).toContain(hint.confidenceLevel);
      }
    });
  });
});

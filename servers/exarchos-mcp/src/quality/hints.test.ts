import { describe, it, expect } from 'vitest';
import { generateQualityHints } from './hints.js';
import type { QualityHint } from './hints.js';
import type { CodeQualityViewState } from '../views/code-quality-view.js';

// ─── Test Helper ────────────────────────────────────────────────────────────

function makeState(overrides: Partial<CodeQualityViewState> = {}): CodeQualityViewState {
  return {
    skills: {},
    gates: {},
    regressions: [],
    benchmarks: [],
    ...overrides,
  };
}

// ─── T1: QualityHint interface, types, and low gate pass rate rule ──────────

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

  // ─── T2: Consecutive failures and benchmark regression rules ────────────

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

  // ─── T3: Self-correction rate and PBT failure rules ─────────────────────

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
});

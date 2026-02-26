import { describe, it, expect } from 'vitest';
import { fc, test as fcTest } from '@fast-check/vitest';
import {
  codeQualityProjection,
  CODE_QUALITY_VIEW,
} from './code-quality-view.js';
import type { CodeQualityViewState } from './code-quality-view.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

const makeEvent = (type: string, data: Record<string, unknown>, seq = 1): WorkflowEvent => ({
  streamId: 'test',
  sequence: seq,
  timestamp: new Date().toISOString(),
  type: type as WorkflowEvent['type'],
  data,
  schemaVersion: '1.0',
});

// ─── T12: Init ────────────────────────────────────────────────────────────────

describe('CodeQualityView', () => {
  describe('init', () => {
    it('codeQualityProjection_Init_ReturnsEmptyState', () => {
      const state = codeQualityProjection.init();
      expect(state).toEqual({
        skills: {},
        models: {},
        gates: {},
        regressions: [],
        benchmarks: [],
      });
    });
  });

  // ─── T13: gate.executed handling ──────────────────────────────────────────

  describe('apply - gate.executed', () => {
    it('Apply_GateExecuted_Passed_UpdatesGateMetrics', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 1200,
        details: {},
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.gates['typecheck']).toBeDefined();
      expect(next.gates['typecheck'].executionCount).toBe(1);
      expect(next.gates['typecheck'].passRate).toBe(1);
    });

    it('Apply_GateExecuted_Failed_UpdatesGateMetrics', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: false,
        duration: 800,
        details: { reason: 'TS2345' },
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.gates['typecheck']).toBeDefined();
      expect(next.gates['typecheck'].executionCount).toBe(1);
      expect(next.gates['typecheck'].passRate).toBe(0);
      expect(next.gates['typecheck'].failureReasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: 'TS2345' })]),
      );
    });

    it('Apply_GateExecuted_UpdatesSkillMetrics', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 1200,
        details: { skill: 'delegation' },
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.skills['delegation']).toBeDefined();
      expect(next.skills['delegation'].totalExecutions).toBe(1);
      expect(next.skills['delegation'].gatePassRate).toBe(1);
    });

    it('Apply_GateExecuted_MultipleEvents_CalculatesAverageDuration', () => {
      let state = codeQualityProjection.init();

      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 1000,
      }, 1));

      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 3000,
      }, 2));

      expect(state.gates['typecheck'].executionCount).toBe(2);
      expect(state.gates['typecheck'].avgDuration).toBe(2000);
    });
  });

  // ─── T14: benchmark.completed handling ────────────────────────────────────

  describe('apply - benchmark.completed', () => {
    it('Apply_BenchmarkCompleted_AppendsTrend', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('benchmark.completed', {
        taskId: 'task-1',
        results: [{
          operation: 'event-append',
          metric: 'p99-latency',
          value: 42,
          unit: 'ms',
          passed: true,
        }],
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.benchmarks).toHaveLength(1);
      expect(next.benchmarks[0].operation).toBe('event-append');
      expect(next.benchmarks[0].metric).toBe('p99-latency');
      expect(next.benchmarks[0].values).toHaveLength(1);
      expect(next.benchmarks[0].values[0].value).toBe(42);
    });

    it('Apply_BenchmarkCompleted_UpdatesTrendDirection', () => {
      let state = codeQualityProjection.init();

      // Three improving values (decreasing latency)
      for (let i = 1; i <= 3; i++) {
        state = codeQualityProjection.apply(state, makeEvent('benchmark.completed', {
          taskId: `task-${i}`,
          results: [{
            operation: 'event-append',
            metric: 'p99-latency',
            value: 100 - (i * 10),
            unit: 'ms',
            passed: true,
          }],
        }, i));
      }

      const trend = state.benchmarks.find(
        (b) => b.operation === 'event-append' && b.metric === 'p99-latency',
      );
      expect(trend).toBeDefined();
      expect(trend!.values).toHaveLength(3);
      expect(trend!.trend).toBe('improving');
    });
  });

  // ─── T15: Regression detection ────────────────────────────────────────────

  describe('apply - regression detection', () => {
    it('Apply_ThreeConsecutiveGateFailures_CreatesRegression', () => {
      let state = codeQualityProjection.init();

      for (let i = 1; i <= 3; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', commit: `commit-${i}` },
        }, i));
      }

      expect(state.regressions).toHaveLength(1);
      expect(state.regressions[0].skill).toBe('delegation');
      expect(state.regressions[0].gate).toBe('typecheck');
      expect(state.regressions[0].consecutiveFailures).toBe(3);
      expect(state.regressions[0].firstFailureCommit).toBe('commit-1');
      expect(state.regressions[0].lastFailureCommit).toBe('commit-3');
    });

    it('Apply_GatePass_ResetsFailureCounter', () => {
      let state = codeQualityProjection.init();

      // Two failures
      for (let i = 1; i <= 2; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', commit: `commit-${i}` },
        }, i));
      }

      // One pass resets
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 500,
        details: { skill: 'delegation' },
      }, 3));

      // Two more failures should NOT trigger regression (only 2, not 3)
      for (let i = 4; i <= 5; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', commit: `commit-${i}` },
        }, i));
      }

      expect(state.regressions).toHaveLength(0);
    });
  });

  // ─── Per-model attribution ──────────────────────────────────────────────

  describe('apply - per-model attribution', () => {
    it('Apply_GateExecuted_WithModel_UpdatesModelMetrics', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 1200,
        details: { model: 'claude-opus-4-6' },
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.models['claude-opus-4-6']).toBeDefined();
      expect(next.models['claude-opus-4-6'].totalExecutions).toBe(1);
      expect(next.models['claude-opus-4-6'].gatePassRate).toBe(1);
    });

    it('Apply_GateExecuted_WithoutModel_DoesNotCreateModelEntry', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 1200,
        details: {},
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.models).toEqual({});
    });

    it('Apply_GateExecuted_MultipleModels_TracksIndependently', () => {
      let state = codeQualityProjection.init();

      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 1000,
        details: { model: 'claude-opus-4-6' },
      }, 1));

      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: false,
        duration: 800,
        details: { model: 'claude-sonnet-4-6', reason: 'TS2345' },
      }, 2));

      expect(state.models['claude-opus-4-6'].totalExecutions).toBe(1);
      expect(state.models['claude-opus-4-6'].gatePassRate).toBe(1);
      expect(state.models['claude-sonnet-4-6'].totalExecutions).toBe(1);
      expect(state.models['claude-sonnet-4-6'].gatePassRate).toBe(0);
    });

    it('Init_IncludesEmptyModelsRecord', () => {
      const state = codeQualityProjection.init();
      expect(state.models).toEqual({});
    });
  });

  // ─── topFailureCategories population ────────────────────────────────────

  describe('apply - topFailureCategories', () => {
    it('CodeQualityView_GateFailedWithReason_PopulatesTopFailureCategories', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: false,
        duration: 500,
        details: { skill: 'delegation', reason: 'TS2345' },
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.skills['delegation'].topFailureCategories).toEqual([
        { category: 'TS2345', count: 1 },
      ]);
    });

    it('CodeQualityView_MultipleFailureReasons_SortedByCount', () => {
      let state = codeQualityProjection.init();

      // Add 'TS2345' twice
      for (let i = 1; i <= 2; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', reason: 'TS2345' },
        }, i));
      }

      // Add 'TS1234' three times
      for (let i = 3; i <= 5; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', reason: 'TS1234' },
        }, i));
      }

      const categories = state.skills['delegation'].topFailureCategories;
      expect(categories[0]).toEqual({ category: 'TS1234', count: 3 });
      expect(categories[1]).toEqual({ category: 'TS2345', count: 2 });
    });

    it('CodeQualityView_MoreThan10Categories_TruncatesToTop10', () => {
      let state = codeQualityProjection.init();
      let seq = 1;

      // Add 12 distinct categories, each with count = 1
      for (let i = 1; i <= 12; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', reason: `category-${i}` },
        }, seq++));
      }

      const categories = state.skills['delegation'].topFailureCategories;
      expect(categories.length).toBe(10);
    });

    it('CodeQualityView_GatePassedNoReason_DoesNotAddCategory', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 500,
        details: { skill: 'delegation' },
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.skills['delegation'].topFailureCategories).toEqual([]);
    });

    it('CodeQualityView_FailureNoReason_UsesGateNameAsCategory', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: false,
        duration: 500,
        details: { skill: 'delegation' },
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next.skills['delegation'].topFailureCategories).toEqual([
        { category: 'typecheck', count: 1 },
      ]);
    });

    it('CodeQualityView_SameCategory_IncrementsCount', () => {
      let state = codeQualityProjection.init();

      for (let i = 1; i <= 3; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', reason: 'TS2345' },
        }, i));
      }

      expect(state.skills['delegation'].topFailureCategories).toEqual([
        { category: 'TS2345', count: 3 },
      ]);
    });
  });

  // ─── remediation.succeeded handling ───────────────────────────────────────

  describe('apply - remediation.succeeded', () => {
    it('CodeQualityView_RemediationSucceeded_UpdatesSelfCorrectionRate', () => {
      let state = codeQualityProjection.init();
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck', layer: 'build', passed: true, duration: 500,
        details: { skill: 'delegation' },
      }, 1));
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck', layer: 'build', passed: false, duration: 500,
        details: { skill: 'delegation' },
      }, 2));

      const next = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
        skill: 'delegation', totalAttempts: 2,
      }, 3));

      expect(next.skills['delegation'].selfCorrectionRate).toBeGreaterThan(0);
      expect(next.skills['delegation'].selfCorrectionRate).toBeLessThanOrEqual(1);
    });

    it('CodeQualityView_RemediationSucceeded_UpdatesAvgRemediationAttempts', () => {
      let state = codeQualityProjection.init();
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck', layer: 'build', passed: false, duration: 500,
        details: { skill: 'delegation' },
      }, 1));

      const next = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
        skill: 'delegation', totalAttempts: 3,
      }, 2));

      expect(next.skills['delegation'].avgRemediationAttempts).toBe(3);
    });

    it('CodeQualityView_MultipleRemediations_CorrectRunningAverage', () => {
      let state = codeQualityProjection.init();
      for (let i = 1; i <= 3; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck', layer: 'build', passed: false, duration: 500,
          details: { skill: 'delegation' },
        }, i));
      }

      state = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
        skill: 'delegation', totalAttempts: 2,
      }, 4));
      state = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
        skill: 'delegation', totalAttempts: 4,
      }, 5));

      expect(state.skills['delegation'].avgRemediationAttempts).toBe(3);
    });

    it('CodeQualityView_RemediationForUnknownSkill_CreatesSkillEntry', () => {
      const state = codeQualityProjection.init();
      const next = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
        skill: 'unknown-skill', totalAttempts: 1,
      }, 1));

      expect(next.skills['unknown-skill']).toBeDefined();
      expect(next.skills['unknown-skill'].avgRemediationAttempts).toBe(1);
    });

    it('CodeQualityView_NoRemediations_RateRemainsZero', () => {
      let state = codeQualityProjection.init();
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck', layer: 'build', passed: false, duration: 500,
        details: { skill: 'delegation' },
      }, 1));

      expect(state.skills['delegation'].selfCorrectionRate).toBe(0);
      expect(state.skills['delegation'].avgRemediationAttempts).toBe(0);
    });

    it('CodeQualityView_RemediationAfterGateFailure_CorrelatesCorrectly', () => {
      let state = codeQualityProjection.init();
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck', layer: 'build', passed: true, duration: 500,
        details: { skill: 'planning' },
      }, 1));
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck', layer: 'build', passed: false, duration: 500,
        details: { skill: 'planning' },
      }, 2));
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck', layer: 'build', passed: true, duration: 500,
        details: { skill: 'planning' },
      }, 3));
      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck', layer: 'build', passed: false, duration: 500,
        details: { skill: 'planning' },
      }, 4));

      state = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
        skill: 'planning', totalAttempts: 2,
      }, 5));

      const rate = state.skills['planning'].selfCorrectionRate;
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThanOrEqual(1);
      expect(state.skills['planning'].avgRemediationAttempts).toBe(2);

      state = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
        skill: 'planning', totalAttempts: 1,
      }, 6));

      const rate2 = state.skills['planning'].selfCorrectionRate;
      expect(rate2).toBeGreaterThan(rate);
      expect(state.skills['planning'].avgRemediationAttempts).toBe(1.5);
    });
  });

  // ─── Property-based tests for remediation.succeeded ─────────────────────

  describe('apply - remediation.succeeded (property-based)', () => {
    fcTest.prop([
      fc.integer({ min: 1, max: 50 }),
      fc.integer({ min: 1, max: 10 }),
    ])('selfCorrectionRate is always between 0 and 1', (failCount, totalAttempts) => {
      let state = codeQualityProjection.init();
      for (let i = 1; i <= failCount; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck', layer: 'build', passed: false, duration: 500,
          details: { skill: 'prop-skill' },
        }, i));
      }
      state = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
        skill: 'prop-skill', totalAttempts,
      }, failCount + 1));

      expect(state.skills['prop-skill'].selfCorrectionRate).toBeGreaterThanOrEqual(0);
      expect(state.skills['prop-skill'].selfCorrectionRate).toBeLessThanOrEqual(1);
    });

    fcTest.prop([
      fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 20 }),
    ])('avgRemediationAttempts >= 1 when any remediations exist', (attemptsList) => {
      let state = codeQualityProjection.init();
      for (let i = 1; i <= attemptsList.length * 2; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck', layer: 'build', passed: false, duration: 500,
          details: { skill: 'prop-skill' },
        }, i));
      }
      let seq = attemptsList.length * 2 + 1;
      for (const attempts of attemptsList) {
        state = codeQualityProjection.apply(state, makeEvent('remediation.succeeded', {
          skill: 'prop-skill', totalAttempts: attempts,
        }, seq++));
      }

      expect(state.skills['prop-skill'].avgRemediationAttempts).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── T16: Unrelated events ────────────────────────────────────────────────

  describe('apply - unrelated events', () => {
    it('Apply_UnrelatedEvent_ReturnsViewUnchanged', () => {
      const state = codeQualityProjection.init();
      const event = makeEvent('task.assigned', {
        taskId: 'task-1',
        title: 'Implement auth',
      });

      const next = codeQualityProjection.apply(state, event);
      expect(next).toBe(state);
    });

    it('Apply_NullData_ReturnsViewUnchanged', () => {
      const state = codeQualityProjection.init();
      const event: WorkflowEvent = {
        streamId: 'test',
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'gate.executed',
        data: undefined,
        schemaVersion: '1.0',
      };

      const next = codeQualityProjection.apply(state, event);
      expect(next).toBe(state);
    });
  });
});

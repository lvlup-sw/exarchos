import { describe, it, expect } from 'vitest';
import { fc, test as fcTest } from '@fast-check/vitest';
import {
  codeQualityProjection,
  CODE_QUALITY_VIEW,
} from '../../../../src/projections/views/code-quality-view.js';
import type { CodeQualityViewState } from '../../../../src/projections/views/code-quality-view.js';
import { EventTypes, type WorkflowEvent } from '../../../../src/events/schemas.js';

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

  // ─── The `gate.executed` split (#1898 item 8) ────────────────────────────
  //
  // These rows arrived as `gate.executed` keyed by the CI check's name, so every
  // GitHub check landed in `state.gates` beside the gates this repository runs
  // itself. The discriminant between the two populations was `layer: 'ci'`, a
  // string nothing validated and nothing read.
  describe('apply - ci.check_observed', () => {
    const observed = (check: string, passed: boolean, seq = 1): WorkflowEvent =>
      makeEvent('ci.check_observed', { pr: 42, check, passed, skill: 'shepherd' }, seq);

    it('CodeQuality_CiCheckObserved_NeverEntersTheGateNamespace', () => {
      const state = codeQualityProjection.apply(
        codeQualityProjection.init(),
        observed('static-analysis', false),
      );

      // The check name here is deliberately one of OUR gate names. Before the
      // split this fold would have written `gates['static-analysis']` with a 0%
      // pass rate from a GitHub job, and nothing would have reported it.
      expect(state.gates).toEqual({});
      expect(state.models).toEqual({});
      expect(state.regressions).toEqual([]);
    });

    it('CodeQuality_CiCheckObserved_KeepsThePerSkillOutcome', () => {
      const fold = (events: readonly WorkflowEvent[]): CodeQualityViewState =>
        events.reduce(
          (view, event) => codeQualityProjection.apply(view, event),
          codeQualityProjection.init(),
        );

      const state = fold([
        observed('ci/build', true, 1),
        observed('ci/test', false, 2),
        observed('ci/lint', true, 3),
      ]);

      const shepherd = state.skills['shepherd'];
      expect(shepherd?.totalExecutions).toBe(3);
      expect(shepherd?.gatePassRate).toBeCloseTo(2 / 3);
      // A failing check is categorized by its own name — there is no `reason`
      // on this record and inventing one would be worse than naming the check.
      expect(shepherd?.topFailureCategories).toEqual([{ category: 'ci/test', count: 1 }]);
    });

    it('CodeQuality_CiCheckObservedWithoutASkill_IsIdentity', () => {
      const before = codeQualityProjection.init();
      const after = codeQualityProjection.apply(
        before,
        makeEvent('ci.check_observed', { pr: 42, check: 'ci/build', passed: true }),
      );
      expect(after).toEqual(before);
    });
  });

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

// ─── W2-6 (#1525): per-skill mutation-score trend ───────────────────────────

describe('CodeQualityView - mutation-score trend (W2-6, #1525)', () => {
  const mutationGate = (
    skill: string,
    mutationScore: number,
    seq: number,
    commit?: string,
  ): WorkflowEvent =>
    makeEvent(
      'gate.executed',
      {
        gateName: 'mutation-adequacy',
        layer: 'verification',
        passed: true,
        details: { skill, mutationScore, ...(commit ? { commit } : {}) },
      },
      seq,
    );

  it('CodeQuality_FoldsMutationScore_ExposesPerSkillTrend', () => {
    let state: CodeQualityViewState = codeQualityProjection.init();
    const scores = [0.5, 0.6, 0.72];
    scores.forEach((score, i) => {
      state = codeQualityProjection.apply(state, mutationGate('delegation', score, i + 1, `c${i}`));
    });

    const skill = state.skills['delegation'];
    expect(skill).toBeDefined();
    // Ordered samples folded as a left-fold trend (mirrors BenchmarkTrend; INV-1, no side table).
    expect(skill.mutationScoreTrend).toBeDefined();
    expect(skill.mutationScoreTrend!.values.map((v) => v.value)).toEqual([0.5, 0.6, 0.72]);
    // Rising mutation score = improving (higher-is-better — inverse of the latency trend).
    expect(skill.mutationScoreTrend!.trend).toBe('improving');
  });

  it('CodeQuality_MutationScore_AttributesPerSkillIndependently', () => {
    let state: CodeQualityViewState = codeQualityProjection.init();
    state = codeQualityProjection.apply(state, mutationGate('delegation', 0.4, 1));
    state = codeQualityProjection.apply(state, mutationGate('review', 0.9, 2));

    expect(state.skills['delegation'].mutationScoreTrend!.values.map((v) => v.value)).toEqual([0.4]);
    expect(state.skills['review'].mutationScoreTrend!.values.map((v) => v.value)).toEqual([0.9]);
  });

  it('CodeQuality_GateWithoutMutationScore_LeavesTrendUntouched', () => {
    let state: CodeQualityViewState = codeQualityProjection.init();
    // A non-mutation gate for the same skill must not create or append a mutation trend.
    state = codeQualityProjection.apply(
      state,
      makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        details: { skill: 'delegation' },
      }, 1),
    );

    expect(state.skills['delegation']).toBeDefined();
    expect(state.skills['delegation'].mutationScoreTrend).toBeUndefined();
  });

  it('CodeQuality_NonMutationGateWithNumericMutationScore_IsIgnored', () => {
    // Defensive (#1560): only the mutation-adequacy gate may feed the trend.
    // Even if another gate ever carries a numeric `mutationScore` in details,
    // the fold is gated on gateName — not the mere presence of a numeric field —
    // so it must not contaminate the per-skill trend.
    let state: CodeQualityViewState = codeQualityProjection.init();
    state = codeQualityProjection.apply(
      state,
      makeEvent('gate.executed', {
        gateName: 'check_static_analysis',
        layer: 'build',
        passed: true,
        details: { skill: 'delegation', mutationScore: 0.95 },
      }, 1),
    );

    expect(state.skills['delegation']).toBeDefined();
    expect(state.skills['delegation'].mutationScoreTrend).toBeUndefined();
  });
});

// ─── The internal trackers must survive every fold step ──────────────────────
//
// `_failureTrackers` and `_remediationCounts` are stored NON-ENUMERABLE, so they
// stay out of `toEqual` and `JSON.stringify` while still riding the apply()
// chain. That also puts them out of reach of the ordinary spread a handler
// reaches for first, and losing them is silent: the counters restart mid-stream,
// the public shape does not change, and every later verdict is computed from a
// history that was truncated without saying so.
//
// These cover the property directly. Finding it by symptom costs a regression
// that is never reported.

describe('CodeQualityView - internal trackers survive the fold', () => {
  const fold = (events: readonly WorkflowEvent[]): CodeQualityViewState =>
    events.reduce(
      (view, event) => codeQualityProjection.apply(view, event),
      codeQualityProjection.init(),
    );

  const failure = (seq: number): WorkflowEvent =>
    makeEvent(
      'gate.executed',
      {
        gateName: 'review',
        layer: 'verification-ladder',
        passed: false,
        duration: 1,
        details: { skill: 'shepherd', commit: `c${seq}` },
      },
      seq,
    );

  const observation = (seq: number): WorkflowEvent =>
    makeEvent('ci.check_observed', { pr: 7, check: 'CI Gate', passed: false, skill: 'shepherd' }, seq);

  const remediation = (seq: number): WorkflowEvent =>
    makeEvent('remediation.succeeded', { skill: 'shepherd', totalAttempts: 4 }, seq);

  const hidden = (view: CodeQualityViewState, key: string): unknown =>
    Object.getOwnPropertyDescriptor(view, key)?.value;

  // Regression detection fires on the THIRD consecutive failure of one
  // gate+skill. An observation folded between the second and the third reset the
  // counter, so the third failure counted as the first and the regression was
  // never raised at all.
  it('CodeQuality_ObservationBetweenFailures_StillDetectsTheRegression', () => {
    const uninterrupted = fold([failure(1), failure(2), failure(3)]);
    const interleaved = fold([failure(1), failure(2), observation(3), failure(4)]);

    expect(uninterrupted.regressions).toHaveLength(1);
    expect(interleaved.regressions).toHaveLength(1);
    expect(interleaved.regressions[0]?.consecutiveFailures).toBe(3);
  });

  // The same mechanism on the other tracker. This counter is the denominator of
  // `selfCorrectionRate` and the weight of the running average behind
  // `avgRemediationAttempts`, so resetting it inflates both.
  it('CodeQuality_ObservationBetweenRemediations_KeepsTheCounter', () => {
    const interleaved = fold([remediation(1), remediation(2), observation(3), remediation(4)]);
    expect(hidden(interleaved, '_remediationCounts')).toEqual({ shepherd: 3 });
  });

  // One payload per handled type that actually reaches the handler's BODY. A
  // payload the handler rejects only exercises its early return, which is the
  // cheap half of the path and not where a spread lives.
  const VALID_PAYLOAD: Readonly<Record<string, Record<string, unknown>>> = {
    'gate.executed': {
      gateName: 'review',
      layer: 'verification-ladder',
      passed: false,
      duration: 1,
      details: { skill: 'shepherd', commit: 'c9' },
    },
    'ci.check_observed': { pr: 7, check: 'CI Gate', passed: false, skill: 'shepherd' },
    'benchmark.completed': {
      results: [{ name: 'fold', value: 1, unit: 'ms' }],
      skill: 'shepherd',
    },
    'remediation.succeeded': { skill: 'shepherd', totalAttempts: 4 },
  };

  // The property itself, over a MEASURED denominator. An event type this view
  // ignores comes back as the same object reference, so the handled set is
  // discovered rather than transcribed. The pin then makes a new handler a
  // visible edit, and the payload table makes it an edit that cannot be made
  // without saying what the new event carries.
  it('CodeQuality_EveryHandledEventType_KeepsBothTrackers', () => {
    const seeded = fold([failure(1), remediation(2)]);
    const handled = EventTypes.filter(
      (type) => codeQualityProjection.apply(seeded, makeEvent(type, { skill: 'shepherd' }, 9)) !== seeded,
    );

    expect([...handled].sort()).toEqual([
      'benchmark.completed',
      'ci.check_observed',
      'gate.executed',
      'remediation.succeeded',
    ]);

    for (const type of handled) {
      const payload = VALID_PAYLOAD[type];
      expect(payload, `no exercising payload declared for ${type}`).toBeDefined();
      const next = codeQualityProjection.apply(seeded, makeEvent(type, payload ?? {}, 9));
      expect(next, type).not.toBe(seeded);
      expect(hidden(next, '_failureTrackers'), type).toBeDefined();
      expect(hidden(next, '_remediationCounts'), type).toBeDefined();
    }
  });
});

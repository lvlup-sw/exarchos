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

  /**
   * A CI check is its own event type, not a `gate.executed` row. A check name can
   * match the name of a repository gate, so the fold must keep checks out of
   * `state.gates`.
   */
  describe('apply - ci.check_observed', () => {
    const observed = (check: string, passed: boolean, seq = 1): WorkflowEvent =>
      makeEvent('ci.check_observed', { pr: 42, check, passed, skill: 'shepherd' }, seq);

    /** The check name equals a gate name of this repository, which is the collision that `state.gates` must not receive. */
    it('CodeQuality_CiCheckObserved_NeverEntersTheGateNamespace', () => {
      const state = codeQualityProjection.apply(
        codeQualityProjection.init(),
        observed('static-analysis', false),
      );

      expect(state.gates).toEqual({});
      expect(state.models).toEqual({});
      expect(state.regressions).toEqual([]);
    });

    /** The record has no `reason`, so a failed check is a failure category under its own name. */
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

    /** Lower latency is better, so three falling values give `improving`. */
    it('Apply_BenchmarkCompleted_UpdatesTrendDirection', () => {
      let state = codeQualityProjection.init();

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

    /** The test folds two failures, one pass, then two failures. No run of three failures occurs, so there is no regression. */
    it('Apply_GatePass_ResetsFailureCounter', () => {
      let state = codeQualityProjection.init();

      for (let i = 1; i <= 2; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', commit: `commit-${i}` },
        }, i));
      }

      state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 500,
        details: { skill: 'delegation' },
      }, 3));

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

      for (let i = 1; i <= 2; i++) {
        state = codeQualityProjection.apply(state, makeEvent('gate.executed', {
          gateName: 'typecheck',
          layer: 'build',
          passed: false,
          duration: 500,
          details: { skill: 'delegation', reason: 'TS2345' },
        }, i));
      }

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

  /** A higher mutation score is better, so a rising series gives `improving`. This is the inverse of the latency trend. */
  it('CodeQuality_FoldsMutationScore_ExposesPerSkillTrend', () => {
    let state: CodeQualityViewState = codeQualityProjection.init();
    const scores = [0.5, 0.6, 0.72];
    scores.forEach((score, i) => {
      state = codeQualityProjection.apply(state, mutationGate('delegation', score, i + 1, `c${i}`));
    });

    const skill = state.skills['delegation'];
    expect(skill).toBeDefined();
    expect(skill.mutationScoreTrend).toBeDefined();
    expect(skill.mutationScoreTrend!.values.map((v) => v.value)).toEqual([0.5, 0.6, 0.72]);
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

  /**
   * Only the `mutation-adequacy` gate feeds the trend. The fold checks `gateName`,
   * so a numeric `mutationScore` from another gate has no effect.
   */
  it('CodeQuality_NonMutationGateWithNumericMutationScore_IsIgnored', () => {
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

/**
 * `_failureTrackers` and `_remediationCounts` are non-enumerable, so `toEqual` and
 * `JSON.stringify` do not see them. An object spread in a handler also drops them,
 * with no error: the counters restart and the public shape stays the same. These
 * tests check directly that both trackers survive each fold step.
 */
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

  /**
   * Regression detection needs three consecutive failures of one gate and skill
   * pair. An observation between the second and the third failure must not reset
   * the count.
   */
  it('CodeQuality_ObservationBetweenFailures_StillDetectsTheRegression', () => {
    const uninterrupted = fold([failure(1), failure(2), failure(3)]);
    const interleaved = fold([failure(1), failure(2), observation(3), failure(4)]);

    expect(uninterrupted.regressions).toHaveLength(1);
    expect(interleaved.regressions).toHaveLength(1);
    expect(interleaved.regressions[0]?.consecutiveFailures).toBe(3);
  });

  /**
   * The same property for `_remediationCounts`. The count is the numerator of
   * `selfCorrectionRate` and the weight of the `avgRemediationAttempts` average, so
   * a reset makes both wrong.
   */
  it('CodeQuality_ObservationBetweenRemediations_KeepsTheCounter', () => {
    const interleaved = fold([remediation(1), remediation(2), observation(3), remediation(4)]);
    expect(hidden(interleaved, '_remediationCounts')).toEqual({ shepherd: 3 });
  });

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

  /**
   * The test finds the handled event types by measurement: the view returns the
   * same object for a type that it ignores. The pinned list makes a new handler a
   * visible edit. For each handled type, `VALID_PAYLOAD` holds one payload that
   * reaches the handler body, because a rejected payload exercises only the early return.
   */
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

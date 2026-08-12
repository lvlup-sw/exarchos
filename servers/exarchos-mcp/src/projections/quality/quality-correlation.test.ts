import { describe, it, expect } from 'vitest';
import { fc, test as fcTest } from '@fast-check/vitest';
import { correlateQualityAndEvals } from './quality-correlation.js';
import type { CodeQualityViewState, SkillQualityMetrics } from '../views/code-quality-view.js';
import type { EvalResultsViewState, SkillEvalMetrics } from '../views/eval-results-view.js';

describe('correlateQualityAndEvals', () => {
  it('CorrelateQualityAndEvals_MatchingSkills_ReturnsJoinedMetrics', () => {
    // Arrange
    const codeQualityState: CodeQualityViewState = {
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 10,
          gatePassRate: 0.9,
          selfCorrectionRate: 0.2,
          avgRemediationAttempts: 1.5,
          topFailureCategories: [],
        },
      },
      models: {},
      gates: {},
      regressions: [],
      benchmarks: [],
    };

    const evalResultsState: EvalResultsViewState = {
      skills: {
        delegation: {
          skill: 'delegation',
          latestScore: 0.85,
          trend: 'stable',
          lastRunId: 'run-1',
          lastRunTimestamp: '2026-01-01T00:00:00Z',
          totalRuns: 5,
          regressionCount: 0,
          capabilityPassRate: 0.9,
        },
      },
      runs: [],
      regressions: [],
      calibrations: [],
    };

    // Act
    const result = correlateQualityAndEvals(codeQualityState, evalResultsState);

    // Assert
    expect(result.skills).toBeDefined();
    expect(result.skills['delegation']).toBeDefined();
    expect(result.skills['delegation'].gatePassRate).toBe(0.9);
    expect(result.skills['delegation'].evalScore).toBe(0.85);
    expect(result.skills['delegation'].evalTrend).toBe('stable');
    expect(result.skills['delegation'].regressionCount).toBe(0);
  });

  it('CorrelateQualityAndEvals_NoOverlappingSkills_ReturnsEmptySkills', () => {
    // Arrange: codeQuality has 'delegation', evalResults has 'brainstorming'
    const codeQualityState: CodeQualityViewState = {
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 10,
          gatePassRate: 0.9,
          selfCorrectionRate: 0.2,
          avgRemediationAttempts: 1.5,
          topFailureCategories: [],
        },
      },
      models: {},
      gates: {},
      regressions: [],
      benchmarks: [],
    };

    const evalResultsState: EvalResultsViewState = {
      skills: {
        brainstorming: {
          skill: 'brainstorming',
          latestScore: 0.75,
          trend: 'improving',
          lastRunId: 'run-2',
          lastRunTimestamp: '2026-01-01T00:00:00Z',
          totalRuns: 3,
          regressionCount: 1,
          capabilityPassRate: 0.8,
        },
      },
      runs: [],
      regressions: [],
      calibrations: [],
    };

    // Act
    const result = correlateQualityAndEvals(codeQualityState, evalResultsState);

    // Assert
    expect(result.skills).toEqual({});
  });

  it('CorrelateQualityAndEvals_EmptyViews_ReturnsEmptySkills', () => {
    // Arrange: both views have empty skills
    const codeQualityState: CodeQualityViewState = {
      skills: {},
      models: {},
      gates: {},
      regressions: [],
      benchmarks: [],
    };

    const evalResultsState: EvalResultsViewState = {
      skills: {},
      runs: [],
      regressions: [],
      calibrations: [],
    };

    // Act
    const result = correlateQualityAndEvals(codeQualityState, evalResultsState);

    // Assert
    expect(result.skills).toEqual({});
  });

  it('CorrelateQualityAndEvals_OneViewEmpty_ReturnsEmptySkills', () => {
    // Arrange: one view has skills, other is empty
    const codeQualityState: CodeQualityViewState = {
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 10,
          gatePassRate: 0.9,
          selfCorrectionRate: 0.2,
          avgRemediationAttempts: 1.5,
          topFailureCategories: [],
        },
      },
      models: {},
      gates: {},
      regressions: [],
      benchmarks: [],
    };

    const evalResultsState: EvalResultsViewState = {
      skills: {},
      runs: [],
      regressions: [],
      calibrations: [],
    };

    // Act
    const result = correlateQualityAndEvals(codeQualityState, evalResultsState);

    // Assert
    expect(result.skills).toEqual({});
  });

  it('CorrelateQualityAndEvals_MultipleSkills_OnlySomeOverlap_ReturnsIntersection', () => {
    // Arrange: codeQuality has delegation + synthesis, evalResults has delegation + planning
    const codeQualityState: CodeQualityViewState = {
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 10,
          gatePassRate: 0.9,
          selfCorrectionRate: 0.2,
          avgRemediationAttempts: 1.5,
          topFailureCategories: [],
        },
        synthesis: {
          skill: 'synthesis',
          totalExecutions: 5,
          gatePassRate: 0.8,
          selfCorrectionRate: 0.1,
          avgRemediationAttempts: 1.0,
          topFailureCategories: [],
        },
      },
      models: {},
      gates: {},
      regressions: [],
      benchmarks: [],
    };

    const evalResultsState: EvalResultsViewState = {
      skills: {
        delegation: {
          skill: 'delegation',
          latestScore: 0.85,
          trend: 'stable',
          lastRunId: 'run-1',
          lastRunTimestamp: '2026-01-01T00:00:00Z',
          totalRuns: 5,
          regressionCount: 0,
          capabilityPassRate: 0.9,
        },
        planning: {
          skill: 'planning',
          latestScore: 0.7,
          trend: 'degrading',
          lastRunId: 'run-3',
          lastRunTimestamp: '2026-01-01T00:00:00Z',
          totalRuns: 2,
          regressionCount: 1,
          capabilityPassRate: 0.6,
        },
      },
      runs: [],
      regressions: [],
      calibrations: [],
    };

    // Act
    const result = correlateQualityAndEvals(codeQualityState, evalResultsState);

    // Assert: only 'delegation' is in both
    expect(Object.keys(result.skills)).toEqual(['delegation']);
    expect(result.skills['delegation'].gatePassRate).toBe(0.9);
    expect(result.skills['delegation'].evalScore).toBe(0.85);
  });
});

// ─── Property Tests ───────────────────────────────────────────────────────────

const skillNameArb = fc.string({ minLength: 1, maxLength: 20 });

const skillQualityMetricsArb: fc.Arbitrary<SkillQualityMetrics> = fc.record({
  skill: skillNameArb,
  totalExecutions: fc.nat(),
  gatePassRate: fc.double({ min: 0, max: 1, noNaN: true }),
  selfCorrectionRate: fc.double({ min: 0, max: 1, noNaN: true }),
  avgRemediationAttempts: fc.double({ min: 0, max: 10, noNaN: true }),
  topFailureCategories: fc.constant([] as ReadonlyArray<{ readonly category: string; readonly count: number }>),
});

const skillEvalMetricsArb: fc.Arbitrary<SkillEvalMetrics> = fc.record({
  skill: skillNameArb,
  latestScore: fc.double({ min: 0, max: 1, noNaN: true }),
  trend: fc.constantFrom('improving' as const, 'stable' as const, 'degrading' as const),
  lastRunId: fc.string({ minLength: 1, maxLength: 10 }),
  lastRunTimestamp: fc.constant('2026-01-01T00:00:00Z'),
  totalRuns: fc.nat(),
  regressionCount: fc.nat(),
  capabilityPassRate: fc.double({ min: 0, max: 1, noNaN: true }),
});

const codeQualityArb: fc.Arbitrary<CodeQualityViewState> = fc
  .array(fc.tuple(skillNameArb, skillQualityMetricsArb), { maxLength: 5 })
  .map((entries) => ({
    skills: Object.fromEntries(entries.map(([name, m]) => [name, { ...m, skill: name }])),
    models: {},
    gates: {},
    regressions: [],
    benchmarks: [],
  }));

const evalResultsArb: fc.Arbitrary<EvalResultsViewState> = fc
  .array(fc.tuple(skillNameArb, skillEvalMetricsArb), { maxLength: 5 })
  .map((entries) => ({
    skills: Object.fromEntries(entries.map(([name, m]) => [name, { ...m, skill: name }])),
    runs: [],
    regressions: [],
    calibrations: [],
  }));

describe('correlateQualityAndEvals (property tests)', () => {
  fcTest.prop([codeQualityArb, evalResultsArb])(
    'Correlation_SkillsSubsetOfBothViews',
    (cq, er) => {
      const result = correlateQualityAndEvals(cq, er);
      const resultSkills = new Set(Object.keys(result.skills));
      const cqSkills = new Set(Object.keys(cq.skills));
      const erSkills = new Set(Object.keys(er.skills));

      for (const skill of resultSkills) {
        expect(cqSkills.has(skill)).toBe(true);
        expect(erSkills.has(skill)).toBe(true);
      }
    },
  );

  fcTest.prop([codeQualityArb, evalResultsArb])(
    'Correlation_Idempotent',
    (cq, er) => {
      const result1 = correlateQualityAndEvals(cq, er);
      const result2 = correlateQualityAndEvals(cq, er);
      expect(result1).toEqual(result2);
    },
  );

  fcTest.prop([codeQualityArb, evalResultsArb])(
    'Correlation_EvalScorePreserved',
    (cq, er) => {
      const result = correlateQualityAndEvals(cq, er);
      for (const [skillName, correlation] of Object.entries(result.skills)) {
        expect(correlation.evalScore).toBe(er.skills[skillName].latestScore);
        expect(correlation.gatePassRate).toBe(cq.skills[skillName].gatePassRate);
      }
    },
  );
});

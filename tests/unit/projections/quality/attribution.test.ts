import { describe, it, expect } from 'vitest';
import { fc, test as fcTest } from '@fast-check/vitest';
import { computeAttribution } from '../../../../src/projections/quality/attribution.js';
import type { AttributionQuery, AttributionResult } from '../../../../src/projections/quality/attribution.js';
import type { CodeQualityViewState } from '../../../../src/projections/views/code-quality-view.js';
import type { EvalResultsViewState } from '../../../../src/projections/views/eval-results-view.js';

function makeCodeQuality(overrides?: Partial<CodeQualityViewState>): CodeQualityViewState {
  return {
    skills: {},
    models: {},
    gates: {},
    regressions: [],
    benchmarks: [],
    ...overrides,
  };
}

function makeEvalResults(overrides?: Partial<EvalResultsViewState>): EvalResultsViewState {
  return {
    skills: {},
    runs: [],
    regressions: [],
    calibrations: [],
    ...overrides,
  };
}

describe('computeAttribution', () => {
  /** `regressionCount` counts the code-quality regressions of the skill. The `regressionCount` of the eval results has no effect. */
  it('ComputeAttribution_BySkill_ReturnsPerSkillMetrics', () => {
    const codeQuality = makeCodeQuality({
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 20,
          gatePassRate: 0.85,
          selfCorrectionRate: 0.15,
          avgRemediationAttempts: 1.2,
          topFailureCategories: [],
        },
        synthesis: {
          skill: 'synthesis',
          totalExecutions: 10,
          gatePassRate: 0.7,
          selfCorrectionRate: 0.3,
          avgRemediationAttempts: 2.0,
          topFailureCategories: [],
        },
      },
      regressions: [
        {
          skill: 'synthesis',
          gate: 'typecheck',
          consecutiveFailures: 4,
          firstFailureCommit: 'abc',
          lastFailureCommit: 'def',
          detectedAt: '2026-02-20T00:00:00Z',
        },
      ],
    });

    const evalResults = makeEvalResults({
      skills: {
        delegation: {
          skill: 'delegation',
          latestScore: 0.9,
          trend: 'improving',
          lastRunId: 'run-1',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 5,
          regressionCount: 0,
          capabilityPassRate: 0.88,
        },
        synthesis: {
          skill: 'synthesis',
          latestScore: 0.6,
          trend: 'degrading',
          lastRunId: 'run-2',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 3,
          regressionCount: 2,
          capabilityPassRate: 0.55,
        },
      },
    });

    const query: AttributionQuery = { dimension: 'skill' };

    const result = computeAttribution(query, codeQuality, evalResults);

    expect(result.dimension).toBe('skill');
    expect(result.entries).toHaveLength(2);

    const delegationEntry = result.entries.find(e => e.key === 'delegation');
    expect(delegationEntry).toBeDefined();
    expect(delegationEntry!.gatePassRate).toBe(0.85);
    expect(delegationEntry!.evalScore).toBe(0.9);
    expect(delegationEntry!.selfCorrectionRate).toBe(0.15);
    expect(delegationEntry!.regressionCount).toBe(0);
    expect(delegationEntry!.sampleSize).toBe(20);

    const synthesisEntry = result.entries.find(e => e.key === 'synthesis');
    expect(synthesisEntry).toBeDefined();
    expect(synthesisEntry!.gatePassRate).toBe(0.7);
    expect(synthesisEntry!.evalScore).toBe(0.6);
    expect(synthesisEntry!.selfCorrectionRate).toBe(0.3);
    expect(synthesisEntry!.regressionCount).toBe(1);
    expect(synthesisEntry!.sampleSize).toBe(10);
  });

  it('ComputeAttribution_ByModel_ReturnsPerModelMetrics', () => {
    const codeQuality = makeCodeQuality({
      models: {
        'claude-opus-4': {
          model: 'claude-opus-4',
          totalExecutions: 30,
          gatePassRate: 0.92,
        },
        'claude-sonnet-4': {
          model: 'claude-sonnet-4',
          totalExecutions: 15,
          gatePassRate: 0.78,
        },
      },
    });

    const evalResults = makeEvalResults();
    const query: AttributionQuery = { dimension: 'model' };

    const result = computeAttribution(query, codeQuality, evalResults);

    expect(result.dimension).toBe('model');
    expect(result.entries).toHaveLength(2);

    const opusEntry = result.entries.find(e => e.key === 'claude-opus-4');
    expect(opusEntry).toBeDefined();
    expect(opusEntry!.gatePassRate).toBe(0.92);
    expect(opusEntry!.sampleSize).toBe(30);

    const sonnetEntry = result.entries.find(e => e.key === 'claude-sonnet-4');
    expect(sonnetEntry).toBeDefined();
    expect(sonnetEntry!.gatePassRate).toBe(0.78);
    expect(sonnetEntry!.sampleSize).toBe(15);
  });

  it('ComputeAttribution_ByGate_ReturnsPerGateMetrics', () => {
    const codeQuality = makeCodeQuality({
      gates: {
        typecheck: {
          gate: 'typecheck',
          executionCount: 25,
          passRate: 0.88,
          avgDuration: 5.2,
          failureReasons: [{ reason: 'type-error', count: 3 }],
        },
        lint: {
          gate: 'lint',
          executionCount: 25,
          passRate: 0.96,
          avgDuration: 2.1,
          failureReasons: [],
        },
      },
      regressions: [
        {
          skill: 'delegation',
          gate: 'typecheck',
          consecutiveFailures: 3,
          firstFailureCommit: 'a1',
          lastFailureCommit: 'a3',
          detectedAt: '2026-02-19T00:00:00Z',
        },
      ],
    });

    const evalResults = makeEvalResults();
    const query: AttributionQuery = { dimension: 'gate' };

    const result = computeAttribution(query, codeQuality, evalResults);

    expect(result.dimension).toBe('gate');
    expect(result.entries).toHaveLength(2);

    const typecheckEntry = result.entries.find(e => e.key === 'typecheck');
    expect(typecheckEntry).toBeDefined();
    expect(typecheckEntry!.gatePassRate).toBe(0.88);
    expect(typecheckEntry!.sampleSize).toBe(25);
    expect(typecheckEntry!.regressionCount).toBe(1);

    const lintEntry = result.entries.find(e => e.key === 'lint');
    expect(lintEntry).toBeDefined();
    expect(lintEntry!.gatePassRate).toBe(0.96);
    expect(lintEntry!.sampleSize).toBe(25);
    expect(lintEntry!.regressionCount).toBe(0);
  });

  /** The `suiteId` of an eval run stands for the prompt version. The score of a version is the mean of its runs, here 0.7 and 0.8. */
  it('ComputeAttribution_ByPromptVersion_ReturnsPerVersionMetrics', () => {
    const evalResults = makeEvalResults({
      runs: [
        {
          runId: 'run-1',
          suiteId: 'delegation-v1',
          trigger: 'ci',
          total: 10,
          passed: 9,
          failed: 1,
          avgScore: 0.9,
          duration: 120,
          timestamp: '2026-02-18T00:00:00Z',
        },
        {
          runId: 'run-2',
          suiteId: 'delegation-v2',
          trigger: 'ci',
          total: 10,
          passed: 7,
          failed: 3,
          avgScore: 0.7,
          duration: 130,
          timestamp: '2026-02-20T00:00:00Z',
        },
        {
          runId: 'run-3',
          suiteId: 'delegation-v2',
          trigger: 'ci',
          total: 10,
          passed: 8,
          failed: 2,
          avgScore: 0.8,
          duration: 125,
          timestamp: '2026-02-21T00:00:00Z',
        },
      ],
    });

    const codeQuality = makeCodeQuality();
    const query: AttributionQuery = { dimension: 'prompt-version' };

    const result = computeAttribution(query, codeQuality, evalResults);

    expect(result.dimension).toBe('prompt-version');
    expect(result.entries).toHaveLength(2);

    const v1Entry = result.entries.find(e => e.key === 'delegation-v1');
    expect(v1Entry).toBeDefined();
    expect(v1Entry!.evalScore).toBe(0.9);
    expect(v1Entry!.sampleSize).toBe(1);

    const v2Entry = result.entries.find(e => e.key === 'delegation-v2');
    expect(v2Entry).toBeDefined();
    expect(v2Entry!.evalScore).toBeCloseTo(0.75, 5);
    expect(v2Entry!.sampleSize).toBe(2);
  });

  /** The reference time is 2026-02-25, so `P7D` keeps the run of 2026-02-24 and drops the run of 2026-01-01. */
  it('ComputeAttribution_WithTimeRange_FiltersEvents', () => {
    const evalResults = makeEvalResults({
      runs: [
        {
          runId: 'run-old',
          suiteId: 'delegation',
          trigger: 'ci',
          total: 10,
          passed: 5,
          failed: 5,
          avgScore: 0.5,
          duration: 100,
          timestamp: '2026-01-01T00:00:00Z',
        },
        {
          runId: 'run-recent',
          suiteId: 'delegation',
          trigger: 'ci',
          total: 10,
          passed: 9,
          failed: 1,
          avgScore: 0.9,
          duration: 110,
          timestamp: '2026-02-24T00:00:00Z',
        },
      ],
    });

    const codeQuality = makeCodeQuality();
    const query: AttributionQuery = {
      dimension: 'prompt-version',
      timeRange: 'P7D',
    };

    const result = computeAttribution(query, codeQuality, evalResults, new Date('2026-02-25T00:00:00Z'));

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe('delegation');
    expect(result.entries[0].evalScore).toBe(0.9);
    expect(result.entries[0].sampleSize).toBe(1);
  });

  it('ComputeAttribution_EmptyData_ReturnsEmptyEntries', () => {
    const codeQuality = makeCodeQuality();
    const evalResults = makeEvalResults();

    const result = computeAttribution({ dimension: 'skill' }, codeQuality, evalResults);

    expect(result.dimension).toBe('skill');
    expect(result.entries).toEqual([]);
    expect(result.correlations).toEqual([]);
  });

  /** `sampleSize` is `totalExecutions` from the code-quality view, not `totalRuns` from the eval results. */
  it('ComputeAttribution_IncludesSampleSize', () => {
    const codeQuality = makeCodeQuality({
      skills: {
        review: {
          skill: 'review',
          totalExecutions: 42,
          gatePassRate: 0.95,
          selfCorrectionRate: 0.05,
          avgRemediationAttempts: 1.0,
          topFailureCategories: [],
        },
      },
    });

    const evalResults = makeEvalResults({
      skills: {
        review: {
          skill: 'review',
          latestScore: 0.88,
          trend: 'stable',
          lastRunId: 'run-1',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 8,
          regressionCount: 0,
          capabilityPassRate: 0.92,
        },
      },
    });

    const query: AttributionQuery = { dimension: 'skill' };

    const result = computeAttribution(query, codeQuality, evalResults);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].sampleSize).toBe(42);
  });

  it('ComputeAttribution_BySkill_FiltersBySkillName', () => {
    const codeQuality = makeCodeQuality({
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 20,
          gatePassRate: 0.85,
          selfCorrectionRate: 0.15,
          avgRemediationAttempts: 1.2,
          topFailureCategories: [],
        },
        synthesis: {
          skill: 'synthesis',
          totalExecutions: 10,
          gatePassRate: 0.7,
          selfCorrectionRate: 0.3,
          avgRemediationAttempts: 2.0,
          topFailureCategories: [],
        },
      },
    });

    const evalResults = makeEvalResults({
      skills: {
        delegation: {
          skill: 'delegation',
          latestScore: 0.9,
          trend: 'stable',
          lastRunId: 'run-1',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 5,
          regressionCount: 0,
          capabilityPassRate: 0.88,
        },
        synthesis: {
          skill: 'synthesis',
          latestScore: 0.6,
          trend: 'degrading',
          lastRunId: 'run-2',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 3,
          regressionCount: 1,
          capabilityPassRate: 0.55,
        },
      },
    });

    const query: AttributionQuery = { dimension: 'skill', skill: 'delegation' };

    const result = computeAttribution(query, codeQuality, evalResults);

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].key).toBe('delegation');
  });

  /** A skill with a high gate pass rate also has a high eval score here, so the correlation is positive. */
  it('ComputeCorrelations_TwoFactors_ReturnsStrength', () => {
    const codeQuality = makeCodeQuality({
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 20,
          gatePassRate: 0.9,
          selfCorrectionRate: 0.1,
          avgRemediationAttempts: 1.0,
          topFailureCategories: [],
        },
        synthesis: {
          skill: 'synthesis',
          totalExecutions: 15,
          gatePassRate: 0.7,
          selfCorrectionRate: 0.3,
          avgRemediationAttempts: 2.0,
          topFailureCategories: [],
        },
        planning: {
          skill: 'planning',
          totalExecutions: 25,
          gatePassRate: 0.95,
          selfCorrectionRate: 0.05,
          avgRemediationAttempts: 1.1,
          topFailureCategories: [],
        },
      },
    });

    const evalResults = makeEvalResults({
      skills: {
        delegation: {
          skill: 'delegation',
          latestScore: 0.88,
          trend: 'stable',
          lastRunId: 'run-1',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 5,
          regressionCount: 0,
          capabilityPassRate: 0.9,
        },
        synthesis: {
          skill: 'synthesis',
          latestScore: 0.55,
          trend: 'degrading',
          lastRunId: 'run-2',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 3,
          regressionCount: 2,
          capabilityPassRate: 0.6,
        },
        planning: {
          skill: 'planning',
          latestScore: 0.92,
          trend: 'improving',
          lastRunId: 'run-3',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 8,
          regressionCount: 0,
          capabilityPassRate: 0.95,
        },
      },
    });

    const query: AttributionQuery = { dimension: 'skill' };

    const result = computeAttribution(query, codeQuality, evalResults);

    expect(result.correlations.length).toBeGreaterThan(0);

    const gateEvalCorrelation = result.correlations.find(
      c => c.factor1 === 'gatePassRate' && c.factor2 === 'evalScore',
    );
    expect(gateEvalCorrelation).toBeDefined();
    expect(gateEvalCorrelation!.strength).toBeGreaterThanOrEqual(0);
    expect(gateEvalCorrelation!.strength).toBeLessThanOrEqual(1);
    expect(gateEvalCorrelation!.direction).toBe('positive');
  });

  /** The trend of an entry comes from the trend of the eval results. */
  it('ComputeAttribution_BySkill_TrendDetection', () => {
    const codeQuality = makeCodeQuality({
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 20,
          gatePassRate: 0.85,
          selfCorrectionRate: 0.15,
          avgRemediationAttempts: 1.2,
          topFailureCategories: [],
        },
      },
    });

    const evalResults = makeEvalResults({
      skills: {
        delegation: {
          skill: 'delegation',
          latestScore: 0.9,
          trend: 'improving',
          lastRunId: 'run-1',
          lastRunTimestamp: '2026-02-20T00:00:00Z',
          totalRuns: 5,
          regressionCount: 0,
          capabilityPassRate: 0.88,
        },
      },
    });

    const query: AttributionQuery = { dimension: 'skill' };

    const result = computeAttribution(query, codeQuality, evalResults);

    const entry = result.entries.find(e => e.key === 'delegation');
    expect(entry).toBeDefined();
    expect(entry!.trend).toBe('improving');
  });

  /** A skill with no eval data still gets an entry, with an `evalScore` of 0. */
  it('ComputeAttribution_BySkill_NoEvalData_UsesCodeQualityOnly', () => {
    const codeQuality = makeCodeQuality({
      skills: {
        delegation: {
          skill: 'delegation',
          totalExecutions: 20,
          gatePassRate: 0.85,
          selfCorrectionRate: 0.15,
          avgRemediationAttempts: 1.2,
          topFailureCategories: [],
        },
      },
    });

    const evalResults = makeEvalResults();
    const query: AttributionQuery = { dimension: 'skill' };

    const result = computeAttribution(query, codeQuality, evalResults);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.key).toBe('delegation');
    expect(entry.gatePassRate).toBe(0.85);
    expect(entry.evalScore).toBe(0);
    expect(entry.sampleSize).toBe(20);
  });
});

const dimensionArb = fc.constantFrom(
  'skill' as const,
  'model' as const,
  'gate' as const,
  'prompt-version' as const,
);

const skillQualityArb = fc.record({
  skill: fc.string({ minLength: 1, maxLength: 20 }),
  totalExecutions: fc.integer({ min: 1, max: 1000 }),
  gatePassRate: fc.double({ min: 0, max: 1, noNaN: true }),
  selfCorrectionRate: fc.double({ min: 0, max: 1, noNaN: true }),
  avgRemediationAttempts: fc.double({ min: 0, max: 10, noNaN: true }),
  topFailureCategories: fc.constant([] as ReadonlyArray<{ readonly category: string; readonly count: number }>),
});

const modelQualityArb = fc.record({
  model: fc.string({ minLength: 1, maxLength: 20 }),
  totalExecutions: fc.integer({ min: 1, max: 1000 }),
  gatePassRate: fc.double({ min: 0, max: 1, noNaN: true }),
});

const gateMetricsArb = fc.record({
  gate: fc.string({ minLength: 1, maxLength: 20 }),
  executionCount: fc.integer({ min: 1, max: 1000 }),
  passRate: fc.double({ min: 0, max: 1, noNaN: true }),
  avgDuration: fc.double({ min: 0, max: 100, noNaN: true }),
  failureReasons: fc.constant([] as ReadonlyArray<{ readonly reason: string; readonly count: number }>),
});

const codeQualityArb: fc.Arbitrary<CodeQualityViewState> = fc
  .tuple(
    fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 10 }), skillQualityArb), { maxLength: 5 }),
    fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 10 }), modelQualityArb), { maxLength: 3 }),
    fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 10 }), gateMetricsArb), { maxLength: 3 }),
  )
  .map(([skills, models, gates]) => ({
    skills: Object.fromEntries(skills.map(([name, m]) => [name, { ...m, skill: name }])),
    models: Object.fromEntries(models.map(([name, m]) => [name, { ...m, model: name }])),
    gates: Object.fromEntries(gates.map(([name, m]) => [name, { ...m, gate: name }])),
    regressions: [],
    benchmarks: [],
  }));

const evalResultsArb: fc.Arbitrary<EvalResultsViewState> = fc
  .array(
    fc.tuple(
      fc.string({ minLength: 1, maxLength: 10 }),
      fc.record({
        skill: fc.string({ minLength: 1, maxLength: 10 }),
        latestScore: fc.double({ min: 0, max: 1, noNaN: true }),
        trend: fc.constantFrom('improving' as const, 'stable' as const, 'degrading' as const),
        lastRunId: fc.string({ minLength: 1, maxLength: 10 }),
        lastRunTimestamp: fc.constant('2026-01-01T00:00:00Z'),
        totalRuns: fc.integer({ min: 1, max: 100 }),
        regressionCount: fc.nat({ max: 10 }),
        capabilityPassRate: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
    ),
    { maxLength: 5 },
  )
  .map((entries) => ({
    skills: Object.fromEntries(entries.map(([name, m]) => [name, { ...m, skill: name }])),
    runs: [],
    regressions: [],
  }));

describe('computeAttribution (property tests)', () => {
  fcTest.prop([codeQualityArb, evalResultsArb])(
    'CorrelationStrength_AlwaysBetween0And1',
    (cq, er) => {
      const result = computeAttribution({ dimension: 'skill' }, cq, er);
      for (const c of result.correlations) {
        expect(c.strength).toBeGreaterThanOrEqual(0);
        expect(c.strength).toBeLessThanOrEqual(1);
      }
    },
  );

  fcTest.prop([codeQualityArb, evalResultsArb])(
    'SampleSize_AtLeast1ForNonEmptyEntries',
    (cq, er) => {
      for (const dim of ['skill', 'model', 'gate'] as const) {
        const result = computeAttribution({ dimension: dim }, cq, er);
        for (const entry of result.entries) {
          expect(entry.sampleSize).toBeGreaterThanOrEqual(1);
        }
      }
    },
  );

  fcTest.prop([dimensionArb])(
    'EmptyInputs_AlwaysReturnsEmptyEntries',
    (dimension) => {
      const result = computeAttribution(
        { dimension },
        makeCodeQuality(),
        makeEvalResults(),
      );
      expect(result.entries).toEqual([]);
      expect(result.correlations).toEqual([]);
    },
  );
});

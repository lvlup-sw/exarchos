import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverSuites, runSuite, runAll, type DiscoveredSuite } from './harness.js';
import { createDefaultRegistry, GraderRegistry } from './graders/index.js';
import type { EvalSuiteConfig, EvalCase } from './types.js';
import { JudgeCalibratedDataSchema } from '../../../src/events/schemas.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The `tests/evals` directory at the repo root. */
const REPO_EVALS_DIR = path.resolve(__dirname, '../../../tests/evals');

let tmpDir: string;
let registry: GraderRegistry;

function makeValidSuiteConfig(overrides?: Partial<EvalSuiteConfig>): EvalSuiteConfig {
  return {
    description: 'Test suite',
    metadata: {
      skill: 'delegate',
      phaseAffinity: 'delegate',
      version: '1.0.0',
    },
    assertions: [
      {
        type: 'exact-match',
        name: 'check-output',
        threshold: 1.0,
      },
    ],
    datasets: {
      main: {
        path: './datasets/main.jsonl',
        description: 'Main dataset',
      },
    },
    ...overrides,
  };
}

function makeEvalCase(id: string, overrides?: Partial<EvalCase>): EvalCase {
  return {
    id,
    type: 'single',
    description: `Case ${id}`,
    input: { value: 'hello' },
    expected: { value: 'hello' },
    tags: [],
    ...overrides,
  };
}

function toJsonl(cases: EvalCase[]): string {
  return cases.map((c) => JSON.stringify(c)).join('\n');
}

async function createSuite(
  suiteName: string,
  config: EvalSuiteConfig,
  datasets: Record<string, EvalCase[]>,
): Promise<string> {
  const suiteDir = path.join(tmpDir, suiteName);
  await fs.mkdir(suiteDir, { recursive: true });
  await fs.writeFile(path.join(suiteDir, 'suite.json'), JSON.stringify(config));

  for (const [dsName, cases] of Object.entries(datasets)) {
    const dsDir = path.join(suiteDir, 'datasets');
    await fs.mkdir(dsDir, { recursive: true });
    await fs.writeFile(path.join(dsDir, `${dsName}.jsonl`), toJsonl(cases));
  }

  return suiteDir;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-harness-'));
  registry = createDefaultRegistry();
});

afterEach(async () => {
  await rmrfAsync(tmpDir);
});

describe('discoverSuites', () => {
  it('DiscoverSuites_FindsSuiteJsonFiles', async () => {
    await createSuite('suite-a', makeValidSuiteConfig(), {
      main: [makeEvalCase('c-1')],
    });
    await createSuite('suite-b', makeValidSuiteConfig({ description: 'Suite B' }), {
      main: [makeEvalCase('c-2')],
    });

    const suites = await discoverSuites(tmpDir);

    expect(suites).toHaveLength(2);
  });

  it('DiscoverSuites_FilterBySkill_ReturnsOnlyMatching', async () => {
    await createSuite(
      'delegate',
      makeValidSuiteConfig({ metadata: { skill: 'delegate', phaseAffinity: 'delegate', version: '1.0.0' } }),
      { main: [makeEvalCase('c-1')] },
    );
    await createSuite(
      'quality-review',
      makeValidSuiteConfig({ metadata: { skill: 'quality-review', phaseAffinity: 'review', version: '1.0.0' } }),
      { main: [makeEvalCase('c-2')] },
    );

    const suites = await discoverSuites(tmpDir, { skill: 'delegate' });

    expect(suites).toHaveLength(1);
    expect(suites[0].config.metadata.skill).toBe('delegate');
  });

  it('DiscoverSuites_InvalidSuiteConfig_ThrowsWithPath', async () => {
    const suiteDir = path.join(tmpDir, 'bad-suite');
    await fs.mkdir(suiteDir, { recursive: true });
    await fs.writeFile(path.join(suiteDir, 'suite.json'), JSON.stringify({ description: 'bad' }));

    await expect(discoverSuites(tmpDir)).rejects.toThrow(/bad-suite/);
  });

  it('DiscoverSuites_EmptyDir_ReturnsEmptyArray', async () => {
    const suites = await discoverSuites(tmpDir);

    expect(suites).toEqual([]);
  });
});

describe('runSuite', () => {
  it('RunSuite_AllCasesPass_ReturnsSummaryWithAllPassed', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('pass-suite', config, { main: cases });

    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('RunSuite_MixedResults_ReturnsSummaryWithCorrectCounts', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('mixed-suite', config, { main: cases });

    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  /** `c-1` scores 1.0. `c-2` scores 0.5, because one of its two fields matches. The average is 0.75. */
  it('RunSuite_ComputesAvgScore_Correctly', async () => {
    const cases = [
      makeEvalCase('c-1', {
        input: { a: 1, b: 2 },
        expected: { a: 1, b: 2 },
      }),
      makeEvalCase('c-2', {
        input: { a: 1, b: 'wrong' },
        expected: { a: 1, b: 2 },
      }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('avg-suite', config, { main: cases });

    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    expect(summary.avgScore).toBe(0.75);
  });

  it('RunSuite_MultipleDatasetsInSuite_RunsAllCases', async () => {
    const config = makeValidSuiteConfig({
      datasets: {
        regression: {
          path: './datasets/regression.jsonl',
          description: 'Regression tests',
        },
        golden: {
          path: './datasets/golden.jsonl',
          description: 'Golden tests',
        },
      },
    });
    const suiteDir = path.join(tmpDir, 'multi-ds');
    await fs.mkdir(path.join(suiteDir, 'datasets'), { recursive: true });
    await fs.writeFile(
      path.join(suiteDir, 'datasets', 'regression.jsonl'),
      toJsonl([makeEvalCase('r-1'), makeEvalCase('r-2')]),
    );
    await fs.writeFile(
      path.join(suiteDir, 'datasets', 'golden.jsonl'),
      toJsonl([makeEvalCase('g-1')]),
    );
    await fs.writeFile(path.join(suiteDir, 'suite.json'), JSON.stringify(config));

    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    expect(summary.total).toBe(3);
  });

  it('RunSuite_GeneratesUniqueRunId', async () => {
    const cases = [makeEvalCase('c-1')];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('id-suite', config, { main: cases });

    const summary1 = await runSuite(config, tmpDir, suiteDir, registry);
    const summary2 = await runSuite(config, tmpDir, suiteDir, registry);

    expect(summary1.runId).toBeTruthy();
    expect(summary2.runId).toBeTruthy();
    expect(summary1.runId).not.toBe(summary2.runId);
  });
});

describe('runAll', () => {
  it('RunAll_MultipleSuites_ReturnsAllSummaries', async () => {
    await createSuite('suite-a', makeValidSuiteConfig(), {
      main: [makeEvalCase('a-1')],
    });
    await createSuite(
      'suite-b',
      makeValidSuiteConfig({ metadata: { skill: 'other', phaseAffinity: 'plan', version: '1.0.0' } }),
      { main: [makeEvalCase('b-1')] },
    );

    const summaries = await runAll(tmpDir);

    expect(summaries).toHaveLength(2);
  });

  it('RunAll_FilterBySkill_RunsOnlyMatchingSuites', async () => {
    await createSuite(
      'delegate',
      makeValidSuiteConfig({ metadata: { skill: 'delegate', phaseAffinity: 'delegate', version: '1.0.0' } }),
      { main: [makeEvalCase('d-1')] },
    );
    await createSuite(
      'quality-review',
      makeValidSuiteConfig({ metadata: { skill: 'quality-review', phaseAffinity: 'review', version: '1.0.0' } }),
      { main: [makeEvalCase('q-1')] },
    );

    const summaries = await runAll(tmpDir, { skill: 'delegate' });

    expect(summaries).toHaveLength(1);
    expect(summaries[0].suiteId).toContain('delegate');
  });
});

describe('Integration — Real Eval Suites', () => {
  it('Integration_DelegationSuite_LoadsAndValidates', async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR, { skill: 'delegate' });

    expect(suites).toHaveLength(1);
    expect(suites[0].config.metadata.skill).toBe('delegate');
    expect(suites[0].config.description).toBe('Delegation skill evaluation suite');
    expect(Object.keys(suites[0].config.datasets)).toContain('regression');
    expect(Object.keys(suites[0].config.datasets)).toContain('capability');
    expect(suites[0].suiteDir).toContain('delegate');
  });

  it.skipIf(!process.env.RUN_EVALS)('Integration_DelegationSuite_RunsWithoutError', { timeout: 120_000 }, async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR, { skill: 'delegate' });
    const { config, suiteDir } = suites[0];
    const reg = createDefaultRegistry();

    const summary = await runSuite(config, REPO_EVALS_DIR, suiteDir, reg);

    expect(summary.total).toBeGreaterThan(0);
    expect(summary.suiteId).toBe('delegate');
    expect(summary.runId).toBeTruthy();
    expect(summary.passed + summary.failed).toBe(summary.total);
  });

  it('Integration_QualityReviewSuite_LoadsAndValidates', async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR, { skill: 'quality-review' });

    expect(suites).toHaveLength(1);
    expect(suites[0].config.metadata.skill).toBe('quality-review');
    expect(suites[0].config.description).toBe('Quality review skill evaluation suite');
    expect(Object.keys(suites[0].config.datasets)).toContain('regression');
    expect(Object.keys(suites[0].config.datasets)).toContain('defect-detection');
    expect(suites[0].suiteDir).toContain('quality-review');
  });

  it.skipIf(!process.env.RUN_EVALS)('Integration_QualityReviewSuite_RunsWithoutError', { timeout: 120_000 }, async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR, { skill: 'quality-review' });
    const { config, suiteDir } = suites[0];
    const reg = createDefaultRegistry();

    const summary = await runSuite(config, REPO_EVALS_DIR, suiteDir, reg);

    expect(summary.total).toBeGreaterThan(0);
    expect(summary.suiteId).toBe('quality-review');
    expect(summary.runId).toBeTruthy();
    expect(summary.passed + summary.failed).toBe(summary.total);
  });
});

const createMockEventStore = () => ({
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
});

describe('runSuite — event emission', () => {
  it('runSuite_WithEventStore_EmitsRunStartedEvent', async () => {
    const cases = [makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } })];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('event-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
      trigger: 'local',
    });

    const startedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.started',
    );
    expect(startedCalls).toHaveLength(1);
    const startedEvent = startedCalls[0][1] as Record<string, unknown>;
    const data = startedEvent.data as Record<string, unknown>;
    expect(data.suiteId).toBe('delegate');
    expect(data.caseCount).toBe(1);
    expect(data.trigger).toBe('local');
  });

  it('runSuite_WithEventStore_EmitsCaseCompletedPerCase', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
      makeEvalCase('c-3', { input: { value: 'c' }, expected: { value: 'c' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('case-events', config, { main: cases });
    const mockStore = createMockEventStore();

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const caseCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.case.completed',
    );
    expect(caseCalls).toHaveLength(3);
  });

  it('runSuite_WithEventStore_EmitsRunCompletedWithSummary', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('completed-events', config, { main: cases });
    const mockStore = createMockEventStore();

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    expect(completedCalls).toHaveLength(1);
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.total).toBe(2);
    expect(data.passed).toBe(1);
    expect(data.failed).toBe(1);
  });

  it('runSuite_WithEventStore_EventsInCorrectOrder', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('order-events', config, { main: cases });
    const mockStore = createMockEventStore();

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const types = mockStore.append.mock.calls.map(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type,
    );
    expect(types[0]).toBe('eval.run.started');
    expect(types[types.length - 1]).toBe('eval.run.completed');
    const middleTypes = types.slice(1, -1);
    const allowedMiddle = new Set(['eval.case.completed', 'eval.judge.calibrated']);
    expect(middleTypes.every((t: unknown) => allowedMiddle.has(t as string))).toBe(true);
  });

  it('runSuite_WithoutEventStore_NoEventsEmitted', async () => {
    const cases = [makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } })];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('no-events', config, { main: cases });

    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  /** Both cases passed in the previous run, so the failure of `c-2` is a regression. */
  it('runSuite_PreviouslyPassingCaseNowFails_PopulatesRegressionsArray', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('regression-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    const previousRunId = 'prev-run-001';
    mockStore.query.mockResolvedValue([
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-1', suiteId: 'delegate', passed: true, score: 1.0 },
        streamId: 'eval-stream',
        sequence: 1,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-2', suiteId: 'delegate', passed: true, score: 1.0 },
        streamId: 'eval-stream',
        sequence: 2,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.run.completed',
        data: { runId: previousRunId, suiteId: 'delegate', total: 2, passed: 2, failed: 0, avgScore: 1.0, duration: 100, regressions: [] },
        streamId: 'eval-stream',
        sequence: 3,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.regressions).toContain('c-2');
    expect(data.regressions).not.toContain('c-1');
  });

  it('runSuite_NoPreviousRun_RegressionsArrayEmpty', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('no-prev-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    mockStore.query.mockResolvedValue([]);

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.regressions).toEqual([]);
  });

  it('runSuite_AllCasesStillPassing_RegressionsArrayEmpty', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('still-passing-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    const previousRunId = 'prev-run-002';
    mockStore.query.mockResolvedValue([
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-1', suiteId: 'delegate', passed: true, score: 1.0 },
        streamId: 'eval-stream',
        sequence: 1,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-2', suiteId: 'delegate', passed: true, score: 1.0 },
        streamId: 'eval-stream',
        sequence: 2,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.run.completed',
        data: { runId: previousRunId, suiteId: 'delegate', total: 2, passed: 2, failed: 0, avgScore: 1.0, duration: 100, regressions: [] },
        streamId: 'eval-stream',
        sequence: 3,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.regressions).toEqual([]);
  });

  it('runSuite_PreviouslyFailingCaseStillFails_NotARegression', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('still-failing-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    const previousRunId = 'prev-run-003';
    mockStore.query.mockResolvedValue([
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-1', suiteId: 'delegate', passed: false, score: 0.0 },
        streamId: 'eval-stream',
        sequence: 1,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.run.completed',
        data: { runId: previousRunId, suiteId: 'delegate', total: 1, passed: 0, failed: 1, avgScore: 0.0, duration: 100, regressions: [] },
        streamId: 'eval-stream',
        sequence: 2,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.regressions).toEqual([]);
  });

  it('runSuite_WithTriggerOption_PassesTriggerInStartedEvent', async () => {
    const cases = [makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } })];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('trigger-events', config, { main: cases });
    const mockStore = createMockEventStore();

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
      trigger: 'ci',
    });

    const startedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.started',
    );
    const data = (startedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.trigger).toBe('ci');
  });
});

describe('discoverSuites_RealEvalSuites', () => {
  it('DiscoverSuites_FindsIdeateSuite', async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const ideate = suites.find(s => s.config.metadata.skill === 'ideate');

    expect(ideate).toBeDefined();
    expect(ideate!.config.assertions).toHaveLength(4);
  });

  it('DiscoverSuites_FindsPlanSuite', async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const planning = suites.find(s => s.config.metadata.skill === 'plan');

    expect(planning).toBeDefined();
    expect(planning!.config.assertions).toHaveLength(4);
  });

  it('DiscoverSuites_FindsRefactorSuite', async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const refactor = suites.find(s => s.config.metadata.skill === 'refactor');

    expect(refactor).toBeDefined();
  });

  it('DiscoverSuites_FindsDebugSuite', async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const debug = suites.find(s => s.config.metadata.skill === 'debug');

    expect(debug).toBeDefined();
  });

  it('DiscoverSuites_TotalSuiteCount_IncludesNewSuites', async () => {
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const skills = suites.map(s => s.config.metadata.skill);

    expect(suites.length).toBeGreaterThanOrEqual(7);
    expect(skills).toEqual(
      expect.arrayContaining(['ideate', 'plan', 'refactor', 'debug']),
    );
  });
});

describe('runSuite — eval.judge.calibrated emission', () => {
  /** A mix of passing and failing cases produces the calibration metrics. */
  it('runSuite_WithEventStore_EmitsJudgeCalibratedEvent', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
      makeEvalCase('c-3', { input: { value: 'c' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('calibration-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const calibratedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.judge.calibrated',
    );
    expect(calibratedCalls.length).toBeGreaterThanOrEqual(1);

    const data = (calibratedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data).toHaveProperty('skill');
    expect(data).toHaveProperty('rubricName');
    expect(data).toHaveProperty('split');
    expect(data).toHaveProperty('tpr');
    expect(data).toHaveProperty('tnr');
    expect(data).toHaveProperty('accuracy');
    expect(data).toHaveProperty('f1');
    expect(data).toHaveProperty('tp');
    expect(data).toHaveProperty('fp');
    expect(data).toHaveProperty('tn');
    expect(data).toHaveProperty('fn');
    expect(data).toHaveProperty('goldStandardVersion');
    expect(data).toHaveProperty('rubricVersion');

    expect(Number.isInteger(data.tp)).toBe(true);
    expect(Number.isInteger(data.fp)).toBe(true);
    expect(Number.isInteger(data.tn)).toBe(true);
    expect(Number.isInteger(data.fn)).toBe(true);
    expect(data.tp as number).toBeGreaterThanOrEqual(0);
    expect(data.fp as number).toBeGreaterThanOrEqual(0);
    expect(data.tn as number).toBeGreaterThanOrEqual(0);
    expect(data.fn as number).toBeGreaterThanOrEqual(0);

    expect(data.tpr).toBeGreaterThanOrEqual(0);
    expect(data.tpr).toBeLessThanOrEqual(1);
    expect(data.tnr).toBeGreaterThanOrEqual(0);
    expect(data.tnr).toBeLessThanOrEqual(1);
    expect(data.accuracy).toBeGreaterThanOrEqual(0);
    expect(data.accuracy).toBeLessThanOrEqual(1);
    expect(data.f1).toBeGreaterThanOrEqual(0);
    expect(data.f1).toBeLessThanOrEqual(1);

    const parseResult = JudgeCalibratedDataSchema.safeParse(data);
    expect(parseResult.success).toBe(true);
  });

  it('runSuite_WithoutEventStore_NoJudgeCalibratedEmitted', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('no-calibration', config, { main: cases });

    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    expect(summary.total).toBe(1);
  });

  it('runSuite_CalibratedEvent_EmittedBeforeRunCompleted', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('order-calibration', config, { main: cases });
    const mockStore = createMockEventStore();

    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    const types = mockStore.append.mock.calls.map(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type,
    );
    const calibratedIndex = types.indexOf('eval.judge.calibrated');
    const completedIndex = types.indexOf('eval.run.completed');
    expect(calibratedIndex).toBeGreaterThan(-1);
    expect(completedIndex).toBeGreaterThan(-1);
    expect(calibratedIndex).toBeLessThan(completedIndex);
  });
});

describe('runSuite — layer filtering', () => {
  it('runSuite_LayerFilter_OnlyRunsMatchingCases', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' }, layer: 'regression' }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' }, layer: 'capability' }),
      makeEvalCase('c-3', { input: { value: 'c' }, expected: { value: 'c' }, layer: 'regression' }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('layer-filter', config, { main: cases });

    const summary = await runSuite(config, tmpDir, suiteDir, registry, { layer: 'regression' });

    expect(summary.total).toBe(2);
    expect(summary.results.map((r) => r.caseId).sort()).toEqual(['c-1', 'c-3']);
  });

  it('runSuite_NoLayerFilter_RunsAllCases', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' }, layer: 'regression' }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' }, layer: 'capability' }),
      makeEvalCase('c-3', { input: { value: 'c' }, expected: { value: 'c' }, layer: 'reliability' }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('no-layer-filter', config, { main: cases });

    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    expect(summary.total).toBe(3);
    expect(summary.results.map((r) => r.caseId).sort()).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('runSuite_LayerMissing_DefaultsToRegression', async () => {
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' }, layer: 'capability' }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('layer-default', config, { main: cases });

    const summary = await runSuite(config, tmpDir, suiteDir, registry, { layer: 'regression' });

    expect(summary.total).toBe(1);
    expect(summary.results[0].caseId).toBe('c-1');
  });
});

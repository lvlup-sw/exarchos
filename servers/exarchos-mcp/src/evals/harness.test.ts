import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { discoverSuites, runSuite, runAll, type DiscoveredSuite } from './harness.js';
import { createDefaultRegistry, GraderRegistry } from './graders/index.js';
import type { EvalSuiteConfig, EvalCase } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve the repo-root evals/ directory (servers/exarchos-mcp/src/evals -> ../../../../evals)
const REPO_EVALS_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'evals');

// ─── Helpers ────────────────────────────────────────────────────────────────

let tmpDir: string;
let registry: GraderRegistry;

function makeValidSuiteConfig(overrides?: Partial<EvalSuiteConfig>): EvalSuiteConfig {
  return {
    description: 'Test suite',
    metadata: {
      skill: 'delegation',
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

// ─── Setup/Teardown ─────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-harness-'));
  registry = createDefaultRegistry();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── discoverSuites ─────────────────────────────────────────────────────────

describe('discoverSuites', () => {
  it('DiscoverSuites_FindsSuiteJsonFiles', async () => {
    // Arrange
    await createSuite('suite-a', makeValidSuiteConfig(), {
      main: [makeEvalCase('c-1')],
    });
    await createSuite('suite-b', makeValidSuiteConfig({ description: 'Suite B' }), {
      main: [makeEvalCase('c-2')],
    });

    // Act
    const suites = await discoverSuites(tmpDir);

    // Assert
    expect(suites).toHaveLength(2);
  });

  it('DiscoverSuites_FilterBySkill_ReturnsOnlyMatching', async () => {
    // Arrange
    await createSuite(
      'delegation',
      makeValidSuiteConfig({ metadata: { skill: 'delegation', phaseAffinity: 'delegate', version: '1.0.0' } }),
      { main: [makeEvalCase('c-1')] },
    );
    await createSuite(
      'quality-review',
      makeValidSuiteConfig({ metadata: { skill: 'quality-review', phaseAffinity: 'review', version: '1.0.0' } }),
      { main: [makeEvalCase('c-2')] },
    );

    // Act
    const suites = await discoverSuites(tmpDir, { skill: 'delegation' });

    // Assert
    expect(suites).toHaveLength(1);
    expect(suites[0].config.metadata.skill).toBe('delegation');
  });

  it('DiscoverSuites_InvalidSuiteConfig_ThrowsWithPath', async () => {
    // Arrange — missing required fields
    const suiteDir = path.join(tmpDir, 'bad-suite');
    await fs.mkdir(suiteDir, { recursive: true });
    await fs.writeFile(path.join(suiteDir, 'suite.json'), JSON.stringify({ description: 'bad' }));

    // Act & Assert
    await expect(discoverSuites(tmpDir)).rejects.toThrow(/bad-suite/);
  });

  it('DiscoverSuites_EmptyDir_ReturnsEmptyArray', async () => {
    // Act
    const suites = await discoverSuites(tmpDir);

    // Assert
    expect(suites).toEqual([]);
  });
});

// ─── runSuite ───────────────────────────────────────────────────────────────

describe('runSuite', () => {
  it('RunSuite_AllCasesPass_ReturnsSummaryWithAllPassed', async () => {
    // Arrange
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('pass-suite', config, { main: cases });

    // Act
    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    // Assert
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('RunSuite_MixedResults_ReturnsSummaryWithCorrectCounts', async () => {
    // Arrange — one match, one mismatch
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('mixed-suite', config, { main: cases });

    // Act
    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    // Assert
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('RunSuite_ComputesAvgScore_Correctly', async () => {
    // Arrange — two cases: one perfect (1.0) and one partial (0.5)
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

    // Act
    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    // Assert — c-1: 1.0, c-2: 0.5 (1/2 fields match) -> avg 0.75
    expect(summary.avgScore).toBe(0.75);
  });

  it('RunSuite_MultipleDatasetsInSuite_RunsAllCases', async () => {
    // Arrange
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

    // Act
    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    // Assert
    expect(summary.total).toBe(3);
  });

  it('RunSuite_GeneratesUniqueRunId', async () => {
    // Arrange
    const cases = [makeEvalCase('c-1')];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('id-suite', config, { main: cases });

    // Act
    const summary1 = await runSuite(config, tmpDir, suiteDir, registry);
    const summary2 = await runSuite(config, tmpDir, suiteDir, registry);

    // Assert
    expect(summary1.runId).toBeTruthy();
    expect(summary2.runId).toBeTruthy();
    expect(summary1.runId).not.toBe(summary2.runId);
  });
});

// ─── runAll ─────────────────────────────────────────────────────────────────

describe('runAll', () => {
  it('RunAll_MultipleSuites_ReturnsAllSummaries', async () => {
    // Arrange
    await createSuite('suite-a', makeValidSuiteConfig(), {
      main: [makeEvalCase('a-1')],
    });
    await createSuite(
      'suite-b',
      makeValidSuiteConfig({ metadata: { skill: 'other', phaseAffinity: 'plan', version: '1.0.0' } }),
      { main: [makeEvalCase('b-1')] },
    );

    // Act
    const summaries = await runAll(tmpDir);

    // Assert
    expect(summaries).toHaveLength(2);
  });

  it('RunAll_FilterBySkill_RunsOnlyMatchingSuites', async () => {
    // Arrange
    await createSuite(
      'delegation',
      makeValidSuiteConfig({ metadata: { skill: 'delegation', phaseAffinity: 'delegate', version: '1.0.0' } }),
      { main: [makeEvalCase('d-1')] },
    );
    await createSuite(
      'quality-review',
      makeValidSuiteConfig({ metadata: { skill: 'quality-review', phaseAffinity: 'review', version: '1.0.0' } }),
      { main: [makeEvalCase('q-1')] },
    );

    // Act
    const summaries = await runAll(tmpDir, { skill: 'delegation' });

    // Assert
    expect(summaries).toHaveLength(1);
    expect(summaries[0].suiteId).toContain('delegation');
  });
});

// ─── Integration Tests ──────────────────────────────────────────────────────

describe('Integration — Real Eval Suites', () => {
  it('Integration_DelegationSuite_LoadsAndValidates', async () => {
    // Act
    const suites = await discoverSuites(REPO_EVALS_DIR, { skill: 'delegation' });

    // Assert
    expect(suites).toHaveLength(1);
    expect(suites[0].config.metadata.skill).toBe('delegation');
    expect(suites[0].config.description).toBe('Delegation skill evaluation suite');
    expect(Object.keys(suites[0].config.datasets)).toContain('regression');
    expect(Object.keys(suites[0].config.datasets)).toContain('capability');
    expect(suites[0].suiteDir).toContain('delegation');
  });

  it.skipIf(!process.env.RUN_EVALS)('Integration_DelegationSuite_RunsWithoutError', async () => {
    // Arrange
    const suites = await discoverSuites(REPO_EVALS_DIR, { skill: 'delegation' });
    const { config, suiteDir } = suites[0];
    const reg = createDefaultRegistry();

    // Act
    const summary = await runSuite(config, REPO_EVALS_DIR, suiteDir, reg);

    // Assert
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.suiteId).toBe('delegation');
    expect(summary.runId).toBeTruthy();
    expect(summary.passed + summary.failed).toBe(summary.total);
  });

  it('Integration_QualityReviewSuite_LoadsAndValidates', async () => {
    // Act
    const suites = await discoverSuites(REPO_EVALS_DIR, { skill: 'quality-review' });

    // Assert
    expect(suites).toHaveLength(1);
    expect(suites[0].config.metadata.skill).toBe('quality-review');
    expect(suites[0].config.description).toBe('Quality review skill evaluation suite');
    expect(Object.keys(suites[0].config.datasets)).toContain('regression');
    expect(Object.keys(suites[0].config.datasets)).toContain('defect-detection');
    expect(suites[0].suiteDir).toContain('quality-review');
  });

  it.skipIf(!process.env.RUN_EVALS)('Integration_QualityReviewSuite_RunsWithoutError', async () => {
    // Arrange
    const suites = await discoverSuites(REPO_EVALS_DIR, { skill: 'quality-review' });
    const { config, suiteDir } = suites[0];
    const reg = createDefaultRegistry();

    // Act
    const summary = await runSuite(config, REPO_EVALS_DIR, suiteDir, reg);

    // Assert
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.suiteId).toBe('quality-review');
    expect(summary.runId).toBeTruthy();
    expect(summary.passed + summary.failed).toBe(summary.total);
  });
});

// ─── T08: Event Emission Tests ───────────────────────────────────────────────

const createMockEventStore = () => ({
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
});

describe('runSuite — event emission', () => {
  it('runSuite_WithEventStore_EmitsRunStartedEvent', async () => {
    // Arrange
    const cases = [makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } })];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('event-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
      trigger: 'local',
    });

    // Assert
    const startedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.started',
    );
    expect(startedCalls).toHaveLength(1);
    const startedEvent = startedCalls[0][1] as Record<string, unknown>;
    const data = startedEvent.data as Record<string, unknown>;
    expect(data.suiteId).toBe('delegation');
    expect(data.caseCount).toBe(1);
    expect(data.trigger).toBe('local');
  });

  it('runSuite_WithEventStore_EmitsCaseCompletedPerCase', async () => {
    // Arrange
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
      makeEvalCase('c-3', { input: { value: 'c' }, expected: { value: 'c' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('case-events', config, { main: cases });
    const mockStore = createMockEventStore();

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert
    const caseCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.case.completed',
    );
    expect(caseCalls).toHaveLength(3);
  });

  it('runSuite_WithEventStore_EmitsRunCompletedWithSummary', async () => {
    // Arrange
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('completed-events', config, { main: cases });
    const mockStore = createMockEventStore();

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert
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
    // Arrange
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('order-events', config, { main: cases });
    const mockStore = createMockEventStore();

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert
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
    // Arrange
    const cases = [makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } })];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('no-events', config, { main: cases });

    // Act — no eventStore in options
    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    // Assert — should still work and return a valid summary
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('runSuite_PreviouslyPassingCaseNowFails_PopulatesRegressionsArray', async () => {
    // Arrange — c-1 passes, c-2 fails
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('regression-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    // Simulate a previous run where both cases passed
    const previousRunId = 'prev-run-001';
    mockStore.query.mockResolvedValue([
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-1', suiteId: 'delegation', passed: true, score: 1.0 },
        streamId: 'eval-stream',
        sequence: 1,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-2', suiteId: 'delegation', passed: true, score: 1.0 },
        streamId: 'eval-stream',
        sequence: 2,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.run.completed',
        data: { runId: previousRunId, suiteId: 'delegation', total: 2, passed: 2, failed: 0, avgScore: 1.0, duration: 100, regressions: [] },
        streamId: 'eval-stream',
        sequence: 3,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert — c-2 should be a regression (was passing, now fails)
    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.regressions).toContain('c-2');
    expect(data.regressions).not.toContain('c-1');
  });

  it('runSuite_NoPreviousRun_RegressionsArrayEmpty', async () => {
    // Arrange — no previous run exists
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('no-prev-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    // query returns empty — no previous run
    mockStore.query.mockResolvedValue([]);

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert — regressions should be empty
    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.regressions).toEqual([]);
  });

  it('runSuite_AllCasesStillPassing_RegressionsArrayEmpty', async () => {
    // Arrange — all cases pass
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('still-passing-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    // Simulate a previous run where both cases also passed
    const previousRunId = 'prev-run-002';
    mockStore.query.mockResolvedValue([
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-1', suiteId: 'delegation', passed: true, score: 1.0 },
        streamId: 'eval-stream',
        sequence: 1,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-2', suiteId: 'delegation', passed: true, score: 1.0 },
        streamId: 'eval-stream',
        sequence: 2,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.run.completed',
        data: { runId: previousRunId, suiteId: 'delegation', total: 2, passed: 2, failed: 0, avgScore: 1.0, duration: 100, regressions: [] },
        streamId: 'eval-stream',
        sequence: 3,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert — no regressions
    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.regressions).toEqual([]);
  });

  it('runSuite_PreviouslyFailingCaseStillFails_NotARegression', async () => {
    // Arrange — c-1 fails
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('still-failing-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    // Simulate a previous run where c-1 also failed
    const previousRunId = 'prev-run-003';
    mockStore.query.mockResolvedValue([
      {
        type: 'eval.case.completed',
        data: { runId: previousRunId, caseId: 'c-1', suiteId: 'delegation', passed: false, score: 0.0 },
        streamId: 'eval-stream',
        sequence: 1,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
      {
        type: 'eval.run.completed',
        data: { runId: previousRunId, suiteId: 'delegation', total: 1, passed: 0, failed: 1, avgScore: 0.0, duration: 100, regressions: [] },
        streamId: 'eval-stream',
        sequence: 2,
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert — c-1 was already failing, so not a regression
    const completedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.completed',
    );
    const data = (completedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.regressions).toEqual([]);
  });

  it('runSuite_WithTriggerOption_PassesTriggerInStartedEvent', async () => {
    // Arrange
    const cases = [makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } })];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('trigger-events', config, { main: cases });
    const mockStore = createMockEventStore();

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
      trigger: 'ci',
    });

    // Assert
    const startedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.run.started',
    );
    const data = (startedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.trigger).toBe('ci');
  });
});

// ─── Discovery Tests for New Eval Suites ──────────────────────────────────────

describe('discoverSuites_RealEvalSuites', () => {
  it('DiscoverSuites_FindsBrainstormingSuite', async () => {
    // Arrange — no setup required

    // Act
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const brainstorming = suites.find(s => s.config.metadata.skill === 'brainstorming');

    // Assert
    expect(brainstorming).toBeDefined();
    expect(brainstorming!.config.assertions).toHaveLength(4);
  });

  it('DiscoverSuites_FindsImplementationPlanningSuite', async () => {
    // Arrange — no setup required

    // Act
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const planning = suites.find(s => s.config.metadata.skill === 'implementation-planning');

    // Assert
    expect(planning).toBeDefined();
    expect(planning!.config.assertions).toHaveLength(4);
  });

  it('DiscoverSuites_FindsRefactorSuite', async () => {
    // Arrange — no setup required

    // Act
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const refactor = suites.find(s => s.config.metadata.skill === 'refactor');

    // Assert
    expect(refactor).toBeDefined();
  });

  it('DiscoverSuites_FindsDebugSuite', async () => {
    // Arrange — no setup required

    // Act
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const debug = suites.find(s => s.config.metadata.skill === 'debug');

    // Assert
    expect(debug).toBeDefined();
  });

  it('DiscoverSuites_TotalSuiteCount_IncludesNewSuites', async () => {
    // Arrange — no setup required

    // Act
    const suites = await discoverSuites(REPO_EVALS_DIR);
    const skills = suites.map(s => s.config.metadata.skill);

    // Assert
    expect(suites.length).toBeGreaterThanOrEqual(7);
    expect(skills).toEqual(
      expect.arrayContaining(['brainstorming', 'implementation-planning', 'refactor', 'debug']),
    );
  });
});

// ─── T7: eval.judge.calibrated emission ──────────────────────────────────────

describe('runSuite — eval.judge.calibrated emission', () => {
  it('runSuite_WithEventStore_EmitsJudgeCalibratedEvent', async () => {
    // Arrange: cases with a mix of pass/fail to produce calibration metrics
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' } }),
      makeEvalCase('c-3', { input: { value: 'c' }, expected: { value: 'different' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('calibration-suite', config, { main: cases });
    const mockStore = createMockEventStore();

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert — should emit eval.judge.calibrated after grading
    const calibratedCalls = mockStore.append.mock.calls.filter(
      (call: unknown[]) => (call[1] as Record<string, unknown>).type === 'eval.judge.calibrated',
    );
    expect(calibratedCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the event data shape matches the schema
    const data = (calibratedCalls[0][1] as Record<string, unknown>).data as Record<string, unknown>;
    expect(data).toHaveProperty('skill');
    expect(data).toHaveProperty('rubricName');
    expect(data).toHaveProperty('split');
    expect(data).toHaveProperty('tpr');
    expect(data).toHaveProperty('tnr');
    expect(data).toHaveProperty('accuracy');
    expect(data).toHaveProperty('f1');
    expect(data).toHaveProperty('goldStandardVersion');
    expect(data).toHaveProperty('rubricVersion');

    // Verify metrics are numbers in [0, 1]
    expect(data.tpr).toBeGreaterThanOrEqual(0);
    expect(data.tpr).toBeLessThanOrEqual(1);
    expect(data.tnr).toBeGreaterThanOrEqual(0);
    expect(data.tnr).toBeLessThanOrEqual(1);
    expect(data.accuracy).toBeGreaterThanOrEqual(0);
    expect(data.accuracy).toBeLessThanOrEqual(1);
    expect(data.f1).toBeGreaterThanOrEqual(0);
    expect(data.f1).toBeLessThanOrEqual(1);
  });

  it('runSuite_WithoutEventStore_NoJudgeCalibratedEmitted', async () => {
    // Arrange
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('no-calibration', config, { main: cases });

    // Act — no eventStore, should not throw
    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    // Assert
    expect(summary.total).toBe(1);
  });

  it('runSuite_CalibratedEvent_EmittedBeforeRunCompleted', async () => {
    // Arrange
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('order-calibration', config, { main: cases });
    const mockStore = createMockEventStore();

    // Act
    await runSuite(config, tmpDir, suiteDir, registry, {
      eventStore: mockStore,
      streamId: 'eval-stream',
    });

    // Assert — calibrated events come before run.completed
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

// ─── Layer Filtering Tests ────────────────────────────────────────────────────

describe('runSuite — layer filtering', () => {
  it('runSuite_LayerFilter_OnlyRunsMatchingCases', async () => {
    // Arrange: 3 cases — 2 regression, 1 capability
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' }, layer: 'regression' }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' }, layer: 'capability' }),
      makeEvalCase('c-3', { input: { value: 'c' }, expected: { value: 'c' }, layer: 'regression' }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('layer-filter', config, { main: cases });

    // Act
    const summary = await runSuite(config, tmpDir, suiteDir, registry, { layer: 'regression' });

    // Assert: only the 2 regression cases should run
    expect(summary.total).toBe(2);
    expect(summary.results.map((r) => r.caseId).sort()).toEqual(['c-1', 'c-3']);
  });

  it('runSuite_NoLayerFilter_RunsAllCases', async () => {
    // Arrange: 3 cases with mixed layers
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' }, layer: 'regression' }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' }, layer: 'capability' }),
      makeEvalCase('c-3', { input: { value: 'c' }, expected: { value: 'c' }, layer: 'reliability' }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('no-layer-filter', config, { main: cases });

    // Act: no layer filter
    const summary = await runSuite(config, tmpDir, suiteDir, registry);

    // Assert: all 3 cases should run
    expect(summary.total).toBe(3);
    expect(summary.results.map((r) => r.caseId).sort()).toEqual(['c-1', 'c-2', 'c-3']);
  });

  it('runSuite_LayerMissing_DefaultsToRegression', async () => {
    // Arrange: cases without explicit layer field should default to 'regression'
    const cases = [
      makeEvalCase('c-1', { input: { value: 'a' }, expected: { value: 'a' } }),
      makeEvalCase('c-2', { input: { value: 'b' }, expected: { value: 'b' }, layer: 'capability' }),
    ];
    const config = makeValidSuiteConfig();
    const suiteDir = await createSuite('layer-default', config, { main: cases });

    // Act
    const summary = await runSuite(config, tmpDir, suiteDir, registry, { layer: 'regression' });

    // Assert: c-1 (defaults to regression) should be included, c-2 (capability) excluded
    expect(summary.total).toBe(1);
    expect(summary.results[0].caseId).toBe('c-1');
  });
});

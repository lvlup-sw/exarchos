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

  it('Integration_DelegationSuite_RunsWithoutError', async () => {
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

  it('Integration_QualityReviewSuite_RunsWithoutError', async () => {
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
    expect(middleTypes.every((t: unknown) => t === 'eval.case.completed')).toBe(true);
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

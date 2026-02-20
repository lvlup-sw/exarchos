import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { discoverSuites, runSuite, runAll, type DiscoveredSuite } from './harness.js';
import { createDefaultRegistry, GraderRegistry } from './graders/index.js';
import type { EvalSuiteConfig, EvalCase } from './types.js';

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

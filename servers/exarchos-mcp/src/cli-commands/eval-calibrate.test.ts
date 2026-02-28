import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HumanGradedCase } from '../evals/calibration-types.js';
import type { GradeResult } from '../evals/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../evals/calibration-types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../evals/calibration-types.js')>();
  return {
    ...actual,
    loadGoldStandard: vi.fn(),
  };
});

vi.mock('../evals/calibration-split.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../evals/calibration-split.js')>();
  return {
    ...actual,
    filterBySplit: vi.fn(),
  };
});

vi.mock('../evals/graders/index.js', () => ({
  createDefaultRegistry: vi.fn(),
  GraderRegistry: vi.fn(),
}));

vi.mock('../evals/harness.js', () => ({
  discoverSuites: vi.fn(),
}));

import { handleCalibrate, buildRubricConfigMap } from './eval-calibrate.js';
import { loadGoldStandard } from '../evals/calibration-types.js';
import { filterBySplit } from '../evals/calibration-split.js';
import { createDefaultRegistry } from '../evals/graders/index.js';
import { discoverSuites } from '../evals/harness.js';

const mockLoadGoldStandard = vi.mocked(loadGoldStandard);
const mockFilterBySplit = vi.mocked(filterBySplit);
const mockCreateDefaultRegistry = vi.mocked(createDefaultRegistry);
const mockDiscoverSuites = vi.mocked(discoverSuites);

// ─── Helpers ────────────────────────────────────────────────────────────────

const TEST_RUBRIC_NAME = 'task-decomposition-quality';
const TEST_RUBRIC_TEXT = 'Evaluate whether the delegation trace shows a comprehensive task decomposition.';
const TEST_EVALS_DIR = '/fake/evals';

function makeCase(overrides: Partial<HumanGradedCase> = {}): HumanGradedCase {
  return {
    caseId: 'case-1',
    skill: 'delegation',
    rubricName: TEST_RUBRIC_NAME,
    humanVerdict: true,
    humanScore: 1.0,
    humanRationale: 'Looks correct.',
    ...overrides,
  };
}

function makeGraderResult(passed: boolean, reason = 'test reason'): GradeResult {
  return {
    passed,
    score: passed ? 1.0 : 0.0,
    reason,
  };
}

function makeMockGrader(gradeImpl: (...args: unknown[]) => Promise<GradeResult>) {
  return {
    resolve: vi.fn().mockReturnValue({
      name: 'llm-rubric',
      type: 'llm-rubric',
      grade: vi.fn().mockImplementation(gradeImpl),
    }),
  };
}

function makeMockSuites(
  overrides: { skill?: string; rubricName?: string; rubricText?: string; outputPath?: string }[] = [{}],
) {
  return overrides.map((o) => ({
    config: {
      description: 'Test suite',
      metadata: {
        skill: o.skill ?? 'delegation',
        phaseAffinity: 'delegate',
        version: '1.0.0',
      },
      assertions: [
        {
          type: 'llm-rubric' as const,
          name: o.rubricName ?? TEST_RUBRIC_NAME,
          threshold: 0.7,
          config: {
            rubric: o.rubricText ?? TEST_RUBRIC_TEXT,
            ...(o.outputPath ? { outputPath: o.outputPath } : {}),
          },
        },
      ],
      datasets: {},
    },
    suiteDir: `/fake/evals/${o.skill ?? 'delegation'}`,
  }));
}

/** Set up standard mocks for tests that reach the grading loop. */
function setupStandardMocks(
  cases: HumanGradedCase[],
  filteredCases?: HumanGradedCase[],
  suiteOverrides?: Parameters<typeof makeMockSuites>[0],
) {
  mockLoadGoldStandard.mockResolvedValue(cases);
  mockFilterBySplit.mockReturnValue(filteredCases ?? cases);
  mockDiscoverSuites.mockResolvedValue(makeMockSuites(suiteOverrides) as Awaited<ReturnType<typeof discoverSuites>>);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildRubricConfigMap', () => {
  it('BuildRubricConfigMap_LlmRubricAssertions_MapsSkillAndName', () => {
    const suites = makeMockSuites([
      { skill: 'delegation', rubricName: 'task-decomposition-quality', rubricText: 'Rubric A' },
      { skill: 'brainstorming', rubricName: 'ideation-quality', rubricText: 'Rubric B' },
    ]);

    const map = buildRubricConfigMap(suites as Awaited<ReturnType<typeof discoverSuites>>);

    expect(map.size).toBe(2);
    expect(map.get('delegation:task-decomposition-quality')).toEqual({ rubric: 'Rubric A' });
    expect(map.get('brainstorming:ideation-quality')).toEqual({ rubric: 'Rubric B' });
  });

  it('BuildRubricConfigMap_NonLlmRubricAssertions_AreExcluded', () => {
    const suites = [
      {
        config: {
          description: 'Test',
          metadata: { skill: 'delegation', phaseAffinity: 'delegate', version: '1.0.0' },
          assertions: [
            { type: 'exact-match' as const, name: 'some-check', threshold: 1.0, config: {} },
            { type: 'llm-rubric' as const, name: 'td-quality', threshold: 0.7, config: { rubric: 'Text' } },
          ],
          datasets: {},
        },
        suiteDir: '/fake/evals/delegation',
      },
    ];

    const map = buildRubricConfigMap(suites as Awaited<ReturnType<typeof discoverSuites>>);

    expect(map.size).toBe(1);
    expect(map.has('delegation:td-quality')).toBe(true);
    expect(map.has('delegation:some-check')).toBe(false);
  });

  it('BuildRubricConfigMap_IncludesOutputPath_WhenPresent', () => {
    const suites = makeMockSuites([
      { skill: 'delegation', rubricName: 'td-quality', rubricText: 'Rubric', outputPath: 'tasks' },
    ]);

    const map = buildRubricConfigMap(suites as Awaited<ReturnType<typeof discoverSuites>>);

    expect(map.get('delegation:td-quality')).toEqual({ rubric: 'Rubric', outputPath: 'tasks' });
  });
});

describe('handleCalibrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('EvalCalibrate_ValidInput_ReturnsCalibrationReport', async () => {
    // Arrange — one pass, one fail
    const cases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1', humanVerdict: true }),
      makeCase({ caseId: 'case-2', humanVerdict: false, humanScore: 0 }),
    ];
    setupStandardMocks(cases);

    // Grader agrees with both human verdicts
    let callCount = 0;
    const mockRegistry = makeMockGrader(async () => {
      callCount++;
      return callCount === 1
        ? makeGraderResult(true, 'Looks good')
        : makeGraderResult(false, 'Looks bad');
    });
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'validation' },
      TEST_EVALS_DIR,
    );

    // Assert
    expect(result.error).toBeUndefined();
    expect(result.report).toBeDefined();
    const report = result.report as Record<string, unknown>;
    expect(report.split).toBe('validation');
    expect(report.totalCases).toBe(2);
    expect(report.truePositives).toBe(1);
    expect(report.trueNegatives).toBe(1);
    expect(report.disagreements).toEqual([]);
    expect(result.gradedCases).toBe(2);
    expect(result.skippedCases).toBe(0);
  });

  it('EvalCalibrate_ResolvesRubricConfig_PassesFullConfigToGrader', async () => {
    // Arrange
    const cases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1', graderOutput: { tasks: ['T1', 'T2'] } }),
    ];
    setupStandardMocks(cases, undefined, [
      { skill: 'delegation', rubricName: TEST_RUBRIC_NAME, rubricText: TEST_RUBRIC_TEXT, outputPath: 'tasks' },
    ]);

    const gradeFn = vi.fn().mockResolvedValue(makeGraderResult(true));
    const mockRegistry = {
      resolve: vi.fn().mockReturnValue({
        name: 'llm-rubric',
        type: 'llm-rubric',
        grade: gradeFn,
      }),
    };
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'validation' },
      TEST_EVALS_DIR,
    );

    // Assert — grader receives skill output directly (no wrapping) + full rubric config
    expect(gradeFn).toHaveBeenCalledWith(
      { tasks: ['T1', 'T2'] },
      { tasks: ['T1', 'T2'] },
      {},
      { rubric: TEST_RUBRIC_TEXT, outputPath: 'tasks' },
    );
  });

  it('EvalCalibrate_FilterBySkill_OnlyGradesMatchingCases', async () => {
    // Arrange
    const cases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1', skill: 'delegation' }),
      makeCase({ caseId: 'case-2', skill: 'planning', rubricName: 'plan-decomposition-quality' }),
      makeCase({ caseId: 'case-3', skill: 'delegation' }),
    ];

    mockLoadGoldStandard.mockResolvedValue(cases);
    mockFilterBySplit.mockReturnValue(cases);
    mockDiscoverSuites.mockResolvedValue(makeMockSuites() as Awaited<ReturnType<typeof discoverSuites>>);

    const mockRegistry = makeMockGrader(async () => makeGraderResult(true));
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'validation', skill: 'delegation' },
      TEST_EVALS_DIR,
    );

    // Assert — only delegation cases graded (2 out of 3)
    expect(result.error).toBeUndefined();
    expect(result.gradedCases).toBe(2);
  });

  it('EvalCalibrate_ValidationSplit_UsesCorrectSubset', async () => {
    // Arrange
    const allCases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1' }),
      makeCase({ caseId: 'case-2' }),
      makeCase({ caseId: 'case-3' }),
    ];
    const validationCases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1' }),
      makeCase({ caseId: 'case-3' }),
    ];
    setupStandardMocks(allCases, validationCases);

    const mockRegistry = makeMockGrader(async () => makeGraderResult(true));
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'validation' },
      TEST_EVALS_DIR,
    );

    // Assert
    expect(mockFilterBySplit).toHaveBeenCalledWith(allCases, 'validation');
    const report = result.report as Record<string, unknown>;
    expect(report.split).toBe('validation');
    expect(report.totalCases).toBe(2);
  });

  it('EvalCalibrate_TestSplit_UsesCorrectSubset', async () => {
    // Arrange
    const allCases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1' }),
      makeCase({ caseId: 'case-2' }),
    ];
    const testCases: HumanGradedCase[] = [makeCase({ caseId: 'case-2' })];
    setupStandardMocks(allCases, testCases);

    const mockRegistry = makeMockGrader(async () => makeGraderResult(true));
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'test' },
      TEST_EVALS_DIR,
    );

    // Assert
    expect(mockFilterBySplit).toHaveBeenCalledWith(allCases, 'test');
    const report = result.report as Record<string, unknown>;
    expect(report.split).toBe('test');
    expect(report.totalCases).toBe(1);
  });

  it('EvalCalibrate_MissingGoldStandard_ReturnsError', async () => {
    // Arrange
    mockLoadGoldStandard.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/nonexistent/gold.jsonl', split: 'validation' },
      TEST_EVALS_DIR,
    );

    // Assert
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('LOAD_FAILED');
    expect(result.error?.message).toContain('ENOENT');
  });

  it('EvalCalibrate_GraderSkipped_MarksAsSkipped', async () => {
    // Arrange
    const cases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1', humanVerdict: true }),
      makeCase({ caseId: 'case-2', humanVerdict: false, humanScore: 0 }),
    ];
    setupStandardMocks(cases);

    const skippedResult: GradeResult = {
      passed: true,
      score: 0,
      reason: 'Skipped: API key not configured',
      details: { skipped: true },
    };

    const mockRegistry = {
      resolve: vi.fn().mockReturnValue({
        name: 'llm-rubric',
        type: 'llm-rubric',
        grade: vi.fn().mockResolvedValue(skippedResult),
      }),
    };
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'validation' },
      TEST_EVALS_DIR,
    );

    // Assert
    expect(result.error).toBeUndefined();
    expect(result.skippedCases).toBe(2);
    expect(result.gradedCases).toBe(0);
  });

  it('EvalCalibrate_EmptySplit_ReturnsEmptyReport', async () => {
    // Arrange
    mockLoadGoldStandard.mockResolvedValue([makeCase({ caseId: 'case-1' })]);
    mockFilterBySplit.mockReturnValue([]);

    mockCreateDefaultRegistry.mockReturnValue(
      makeMockGrader(async () => makeGraderResult(true)) as unknown as ReturnType<typeof createDefaultRegistry>,
    );

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'test' },
      TEST_EVALS_DIR,
    );

    // Assert — empty split returns before suite discovery
    expect(result.error).toBeUndefined();
    const report = result.report as Record<string, unknown>;
    expect(report.totalCases).toBe(0);
    expect(report.truePositives).toBe(0);
    expect(report.falsePositives).toBe(0);
    expect(report.trueNegatives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.disagreements).toEqual([]);
  });

  it('EvalCalibrate_MissingRubric_ReturnsError', async () => {
    // Arrange — case references a rubric that doesn't exist in any suite
    const cases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1', rubricName: 'nonexistent-rubric' }),
    ];
    setupStandardMocks(cases);

    const mockRegistry = makeMockGrader(async () => makeGraderResult(true));
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'validation' },
      TEST_EVALS_DIR,
    );

    // Assert
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('RUBRIC_NOT_FOUND');
    expect(result.error?.message).toContain('nonexistent-rubric');
    expect(result.error?.message).toContain('delegation');
  });

  it('EvalCalibrate_SuiteDiscoveryFails_ReturnsError', async () => {
    // Arrange
    const cases: HumanGradedCase[] = [makeCase({ caseId: 'case-1' })];
    mockLoadGoldStandard.mockResolvedValue(cases);
    mockFilterBySplit.mockReturnValue(cases);
    mockDiscoverSuites.mockRejectedValue(new Error('Invalid JSON in suite config'));

    const mockRegistry = makeMockGrader(async () => makeGraderResult(true));
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate(
      { goldStandardPath: '/fake/gold.jsonl', split: 'validation' },
      TEST_EVALS_DIR,
    );

    // Assert
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('SUITE_DISCOVERY_FAILED');
    expect(result.error?.message).toContain('Invalid JSON');
  });
});

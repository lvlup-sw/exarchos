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

import { handleCalibrate } from './eval-calibrate.js';
import { loadGoldStandard } from '../evals/calibration-types.js';
import { filterBySplit } from '../evals/calibration-split.js';
import { createDefaultRegistry } from '../evals/graders/index.js';

const mockLoadGoldStandard = vi.mocked(loadGoldStandard);
const mockFilterBySplit = vi.mocked(filterBySplit);
const mockCreateDefaultRegistry = vi.mocked(createDefaultRegistry);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeCase(overrides: Partial<HumanGradedCase> = {}): HumanGradedCase {
  return {
    caseId: 'case-1',
    skill: 'delegation',
    rubricName: 'Is the output complete?',
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

// ─── Tests ──────────────────────────────────────────────────────────────────

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

    mockLoadGoldStandard.mockResolvedValue(cases);
    mockFilterBySplit.mockReturnValue(cases);

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
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'validation',
    });

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

  it('EvalCalibrate_FilterBySkill_OnlyGradesMatchingCases', async () => {
    // Arrange
    const cases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-1', skill: 'delegation' }),
      makeCase({ caseId: 'case-2', skill: 'planning' }),
      makeCase({ caseId: 'case-3', skill: 'delegation' }),
    ];

    mockLoadGoldStandard.mockResolvedValue(cases);
    mockFilterBySplit.mockReturnValue(cases);

    const mockRegistry = makeMockGrader(async () => makeGraderResult(true));
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'validation',
      skill: 'delegation',
    });

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

    mockLoadGoldStandard.mockResolvedValue(allCases);
    mockFilterBySplit.mockReturnValue(validationCases);

    const mockRegistry = makeMockGrader(async () => makeGraderResult(true));
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'validation',
    });

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

    const testCases: HumanGradedCase[] = [
      makeCase({ caseId: 'case-2' }),
    ];

    mockLoadGoldStandard.mockResolvedValue(allCases);
    mockFilterBySplit.mockReturnValue(testCases);

    const mockRegistry = makeMockGrader(async () => makeGraderResult(true));
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'test',
    });

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
    const result = await handleCalibrate({
      goldStandardPath: '/nonexistent/gold.jsonl',
      split: 'validation',
    });

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

    mockLoadGoldStandard.mockResolvedValue(cases);
    mockFilterBySplit.mockReturnValue(cases);

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
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'validation',
    });

    // Assert
    expect(result.error).toBeUndefined();
    expect(result.skippedCases).toBe(2);
    expect(result.gradedCases).toBe(0);
  });

  it('EvalCalibrate_EmptySplit_ReturnsEmptyReport', async () => {
    // Arrange
    mockLoadGoldStandard.mockResolvedValue([makeCase({ caseId: 'case-1' })]);
    mockFilterBySplit.mockReturnValue([]);

    mockCreateDefaultRegistry.mockReturnValue(makeMockGrader(async () => makeGraderResult(true)) as unknown as ReturnType<typeof createDefaultRegistry>);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'test',
    });

    // Assert
    expect(result.error).toBeUndefined();
    const report = result.report as Record<string, unknown>;
    expect(report.totalCases).toBe(0);
    expect(report.truePositives).toBe(0);
    expect(report.falsePositives).toBe(0);
    expect(report.trueNegatives).toBe(0);
    expect(report.falseNegatives).toBe(0);
    expect(report.disagreements).toEqual([]);
  });
});

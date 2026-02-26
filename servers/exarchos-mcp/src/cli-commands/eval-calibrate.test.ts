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

function makeCase(overrides: Partial<HumanGradedCase> & { id: string }): HumanGradedCase {
  return {
    skill: 'delegation',
    rubric: 'Is the output complete?',
    output: 'The delegation plan covers all tasks.',
    humanVerdict: 'pass',
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

function makeMockRegistry(gradeResults: Map<string, GradeResult>) {
  return {
    resolve: vi.fn().mockReturnValue({
      name: 'llm-rubric',
      type: 'llm-rubric',
      grade: vi.fn().mockImplementation(
        async (_input: Record<string, unknown>, _output: Record<string, unknown>, _expected: Record<string, unknown>, _config?: Record<string, unknown>): Promise<GradeResult> => {
          // Use the output text to determine which result to return
          const outputText = _output['output'] as string ?? '';
          return gradeResults.get(outputText) ?? makeGraderResult(true);
        },
      ),
    }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleCalibrate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('EvalCalibrate_ValidInput_ReturnsCalibrationReport', async () => {
    // Arrange
    const cases: HumanGradedCase[] = [
      makeCase({ id: 'case-1', humanVerdict: 'pass', output: 'good output' }),
      makeCase({ id: 'case-2', humanVerdict: 'fail', output: 'bad output' }),
    ];

    mockLoadGoldStandard.mockReturnValue(cases);
    mockFilterBySplit.mockReturnValue(cases);

    const gradeResults = new Map<string, GradeResult>();
    gradeResults.set('good output', makeGraderResult(true, 'Looks good'));
    gradeResults.set('bad output', makeGraderResult(false, 'Looks bad'));

    mockCreateDefaultRegistry.mockReturnValue(makeMockRegistry(gradeResults) as any);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'validation',
    });

    // Assert
    expect(result.error).toBeUndefined();
    expect(result.report).toBeDefined();
    const report = result.report as any;
    expect(report.split).toBe('validation');
    expect(report.totalCases).toBe(2);
    expect(report.gradedCases).toBe(2);
    expect(report.skippedCases).toBe(0);
    expect(report.confusionMatrix).toBeDefined();
    expect(report.confusionMatrix.truePositives).toBe(1);
    expect(report.confusionMatrix.trueNegatives).toBe(1);
    expect(report.disagreements).toEqual([]);
  });

  it('EvalCalibrate_FilterBySkill_OnlyGradesMatchingCases', async () => {
    // Arrange
    const cases: HumanGradedCase[] = [
      makeCase({ id: 'case-1', skill: 'delegation', output: 'del output' }),
      makeCase({ id: 'case-2', skill: 'planning', output: 'plan output' }),
      makeCase({ id: 'case-3', skill: 'delegation', output: 'del output 2' }),
    ];

    mockLoadGoldStandard.mockReturnValue(cases);
    // filterBySplit returns all cases (mock)
    mockFilterBySplit.mockReturnValue(cases);

    const gradeResults = new Map<string, GradeResult>();
    gradeResults.set('del output', makeGraderResult(true));
    gradeResults.set('del output 2', makeGraderResult(true));

    mockCreateDefaultRegistry.mockReturnValue(makeMockRegistry(gradeResults) as any);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'validation',
      skill: 'delegation',
    });

    // Assert
    expect(result.error).toBeUndefined();
    const report = result.report as any;
    // Only delegation cases should be graded (2 out of 3)
    expect(report.totalCases).toBe(2);
    expect(report.gradedCases).toBe(2);
    expect(report.skill).toBe('delegation');
  });

  it('EvalCalibrate_ValidationSplit_UsesCorrectSubset', async () => {
    // Arrange
    const allCases: HumanGradedCase[] = [
      makeCase({ id: 'case-1', output: 'out-1' }),
      makeCase({ id: 'case-2', output: 'out-2' }),
      makeCase({ id: 'case-3', output: 'out-3' }),
    ];

    const validationCases: HumanGradedCase[] = [
      makeCase({ id: 'case-1', output: 'out-1' }),
      makeCase({ id: 'case-3', output: 'out-3' }),
    ];

    mockLoadGoldStandard.mockReturnValue(allCases);
    mockFilterBySplit.mockReturnValue(validationCases);

    const gradeResults = new Map<string, GradeResult>();
    gradeResults.set('out-1', makeGraderResult(true));
    gradeResults.set('out-3', makeGraderResult(true));

    mockCreateDefaultRegistry.mockReturnValue(makeMockRegistry(gradeResults) as any);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'validation',
    });

    // Assert
    expect(mockFilterBySplit).toHaveBeenCalledWith(allCases, 'validation');
    const report = result.report as any;
    expect(report.split).toBe('validation');
    expect(report.totalCases).toBe(2);
  });

  it('EvalCalibrate_TestSplit_UsesCorrectSubset', async () => {
    // Arrange
    const allCases: HumanGradedCase[] = [
      makeCase({ id: 'case-1', output: 'out-1' }),
      makeCase({ id: 'case-2', output: 'out-2' }),
    ];

    const testCases: HumanGradedCase[] = [
      makeCase({ id: 'case-2', output: 'out-2' }),
    ];

    mockLoadGoldStandard.mockReturnValue(allCases);
    mockFilterBySplit.mockReturnValue(testCases);

    const gradeResults = new Map<string, GradeResult>();
    gradeResults.set('out-2', makeGraderResult(true));

    mockCreateDefaultRegistry.mockReturnValue(makeMockRegistry(gradeResults) as any);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'test',
    });

    // Assert
    expect(mockFilterBySplit).toHaveBeenCalledWith(allCases, 'test');
    const report = result.report as any;
    expect(report.split).toBe('test');
    expect(report.totalCases).toBe(1);
  });

  it('EvalCalibrate_MissingGoldStandard_ReturnsError', async () => {
    // Arrange
    mockLoadGoldStandard.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

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
      makeCase({ id: 'case-1', humanVerdict: 'pass', output: 'output-1' }),
      makeCase({ id: 'case-2', humanVerdict: 'fail', output: 'output-2' }),
    ];

    mockLoadGoldStandard.mockReturnValue(cases);
    mockFilterBySplit.mockReturnValue(cases);

    // Simulate grader returning skipped results (no API key scenario)
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
    mockCreateDefaultRegistry.mockReturnValue(mockRegistry as any);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'validation',
    });

    // Assert
    expect(result.error).toBeUndefined();
    const report = result.report as any;
    expect(report.skippedCases).toBe(2);
    expect(report.gradedCases).toBe(0);
  });

  it('EvalCalibrate_EmptySplit_ReturnsEmptyReport', async () => {
    // Arrange
    const allCases: HumanGradedCase[] = [
      makeCase({ id: 'case-1', output: 'out-1' }),
    ];

    mockLoadGoldStandard.mockReturnValue(allCases);
    // No cases in this split
    mockFilterBySplit.mockReturnValue([]);

    mockCreateDefaultRegistry.mockReturnValue(makeMockRegistry(new Map()) as any);

    // Act
    const result = await handleCalibrate({
      goldStandardPath: '/fake/gold.jsonl',
      split: 'test',
    });

    // Assert
    expect(result.error).toBeUndefined();
    const report = result.report as any;
    expect(report.totalCases).toBe(0);
    expect(report.gradedCases).toBe(0);
    expect(report.skippedCases).toBe(0);
    expect(report.confusionMatrix.truePositives).toBe(0);
    expect(report.confusionMatrix.falsePositives).toBe(0);
    expect(report.confusionMatrix.trueNegatives).toBe(0);
    expect(report.confusionMatrix.falseNegatives).toBe(0);
    expect(report.disagreements).toEqual([]);
  });
});

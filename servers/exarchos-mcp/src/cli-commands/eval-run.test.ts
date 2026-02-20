import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import type { RunSummary } from '../evals/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../evals/harness.js', () => ({
  runAll: vi.fn(),
}));

vi.mock('../evals/reporters/cli-reporter.js', () => ({
  formatMultiSuiteReport: vi.fn().mockReturnValue('mock report'),
}));

vi.mock('../evals/reporters/ci-reporter.js', () => ({
  formatCIReport: vi.fn().mockReturnValue('::notice title=Eval: mock::1/1 passed (100.0%)'),
}));

import { handleEvalRun, resolveEvalsDir } from './eval-run.js';
import { runAll } from '../evals/harness.js';
import { formatMultiSuiteReport } from '../evals/reporters/cli-reporter.js';
import { formatCIReport } from '../evals/reporters/ci-reporter.js';

const mockRunAll = vi.mocked(runAll);
const mockFormatMultiSuiteReport = vi.mocked(formatMultiSuiteReport);
const mockFormatCIReport = vi.mocked(formatCIReport);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<RunSummary> & { suiteId: string }): RunSummary {
  return {
    runId: 'run-001',
    total: 2,
    passed: 2,
    failed: 0,
    avgScore: 1.0,
    duration: 100,
    results: [],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleEvalRun', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('HandleEvalRun_NoArgs_RunsAllSuites', async () => {
    // Arrange
    const summaries = [makeSummary({ suiteId: 'delegation' })];
    mockRunAll.mockResolvedValue(summaries);

    // Act
    const result = await handleEvalRun({}, '/fake/evals');

    // Assert
    expect(mockRunAll).toHaveBeenCalledWith('/fake/evals', {});
    expect(result).toHaveProperty('summaries');
    expect(result).toHaveProperty('passed', true);
  });

  it('HandleEvalRun_SkillFilter_PassesToHarness', async () => {
    // Arrange
    mockRunAll.mockResolvedValue([makeSummary({ suiteId: 'delegation' })]);

    // Act
    await handleEvalRun({ skill: 'delegation' }, '/fake/evals');

    // Assert
    expect(mockRunAll).toHaveBeenCalledWith('/fake/evals', { skill: 'delegation' });
  });

  it('HandleEvalRun_NoSuitesFound_ReturnsError', async () => {
    // Arrange
    mockRunAll.mockResolvedValue([]);

    // Act
    const result = await handleEvalRun({}, '/fake/evals');

    // Assert
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('NO_SUITES');
  });

  it('HandleEvalRun_AllPass_ReturnsSuccessResult', async () => {
    // Arrange
    const summaries = [
      makeSummary({ suiteId: 'suite-a', total: 3, passed: 3, failed: 0 }),
    ];
    mockRunAll.mockResolvedValue(summaries);

    // Act
    const result = await handleEvalRun({}, '/fake/evals');

    // Assert
    expect(result.passed).toBe(true);
    expect(result.total).toBe(3);
    expect(result.failures).toBe(0);
  });

  it('HandleEvalRun_HasFailures_ReturnsResultWithFailures', async () => {
    // Arrange
    const summaries = [
      makeSummary({ suiteId: 'suite-a', total: 5, passed: 3, failed: 2 }),
    ];
    mockRunAll.mockResolvedValue(summaries);

    // Act
    const result = await handleEvalRun({}, '/fake/evals');

    // Assert
    expect(result.passed).toBe(false);
    expect(result.total).toBe(5);
    expect(result.failures).toBe(2);
  });

  it('HandleEvalRun_RunAllThrows_ReturnsRunFailedError', async () => {
    // Arrange
    mockRunAll.mockRejectedValue(new Error('disk full'));

    // Act
    const result = await handleEvalRun({}, '/fake/evals');

    // Assert
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('RUN_FAILED');
    expect(result.error?.message).toContain('disk full');
  });
});

// ─── CI Flag ─────────────────────────────────────────────────────────────────

describe('handleEvalRun CI mode', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('HandleEvalRun_CiFlag_UsesFormatCIReport', async () => {
    // Arrange
    const summaries = [makeSummary({ suiteId: 'delegation' })];
    mockRunAll.mockResolvedValue(summaries);

    // Act
    await handleEvalRun({ ci: true }, '/fake/evals');

    // Assert
    expect(mockFormatCIReport).toHaveBeenCalledWith(summaries);
    expect(mockFormatMultiSuiteReport).not.toHaveBeenCalled();
  });

  it('HandleEvalRun_CiFlag_AllPass_ReturnsPassedTrue', async () => {
    // Arrange
    const summaries = [makeSummary({ suiteId: 'suite-a', total: 3, passed: 3, failed: 0 })];
    mockRunAll.mockResolvedValue(summaries);

    // Act
    const result = await handleEvalRun({ ci: true }, '/fake/evals');

    // Assert
    expect(result.passed).toBe(true);
  });

  it('HandleEvalRun_CiFlag_Failures_ReturnsPassedFalse', async () => {
    // Arrange
    const summaries = [makeSummary({ suiteId: 'suite-a', total: 5, passed: 3, failed: 2 })];
    mockRunAll.mockResolvedValue(summaries);

    // Act
    const result = await handleEvalRun({ ci: true }, '/fake/evals');

    // Assert
    expect(result.passed).toBe(false);
  });

  it('HandleEvalRun_NoCiFlag_UsesCliReporter', async () => {
    // Arrange
    const summaries = [makeSummary({ suiteId: 'delegation' })];
    mockRunAll.mockResolvedValue(summaries);

    // Act
    await handleEvalRun({}, '/fake/evals');

    // Assert
    expect(mockFormatMultiSuiteReport).toHaveBeenCalledWith(summaries);
    expect(mockFormatCIReport).not.toHaveBeenCalled();
  });
});

// ─── resolveEvalsDir ────────────────────────────────────────────────────────

describe('resolveEvalsDir', () => {
  const originalEnv = process.env['EVALS_DIR'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['EVALS_DIR'] = originalEnv;
    } else {
      delete process.env['EVALS_DIR'];
    }
  });

  it('ResolveEvalsDir_EnvVar_UsesEnvValue', () => {
    // Arrange — use a real directory that exists
    process.env['EVALS_DIR'] = os.tmpdir();

    // Act
    const result = resolveEvalsDir();

    // Assert
    expect(result).toBe(os.tmpdir());
  });

  it('ResolveEvalsDir_EnvVarInvalidPath_ThrowsError', () => {
    // Arrange
    process.env['EVALS_DIR'] = '/nonexistent/evals/path';

    // Act & Assert
    expect(() => resolveEvalsDir()).toThrow(/does not exist or is not a directory/);
  });

  it('ResolveEvalsDir_NoEnvVar_FindsRepoRoot', () => {
    // Arrange
    delete process.env['EVALS_DIR'];

    // Act
    const result = resolveEvalsDir();

    // Assert
    // Should find the evals/ directory relative to the repo root
    expect(result).toMatch(/evals$/);
  });
});

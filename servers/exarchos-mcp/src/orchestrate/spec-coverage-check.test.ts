// ─── Spec Coverage Check Tests ──────────────────────────────────────────────
//
// Tests for the TypeScript port of scripts/spec-coverage-check.sh.
// Verifies test coverage for spec compliance by checking plan references
// against on-disk test files and optional vitest execution.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handleSpecCoverageCheck } from './spec-coverage-check.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExecFileSync = vi.mocked(execFileSync);

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makePlanWithTests(testFiles: readonly string[]): string {
  const lines = ['# Implementation Plan', ''];
  for (const f of testFiles) {
    lines.push(`### Task: implement ${f}`);
    lines.push('');
    lines.push(`**Test file:** \`${f}\``);
    lines.push('');
  }
  return lines.join('\n');
}

const PLAN_WITH_TWO_TESTS = makePlanWithTests([
  'src/widget.test.ts',
  'src/utils.test.ts',
]);

const PLAN_WITHOUT_TESTS = [
  '# Implementation Plan',
  '',
  '## Task 1',
  '',
  'Implement the widget.',
].join('\n');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleSpecCoverageCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── 1. All test files exist and pass ───────────────────────────────────

  it('allTestFilesExistAndPass_returnsPassed', () => {
    // Plan file exists, repo root exists
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      if (path === '/repo/src/widget.test.ts') return true;
      if (path === '/repo/src/utils.test.ts') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);
    mockedExecFileSync.mockReturnValue(Buffer.from(''));

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      totalTests: number;
      found: number;
      missing: readonly string[];
      report: string;
    };
    expect(data.passed).toBe(true);
    expect(data.totalTests).toBe(2);
    expect(data.found).toBe(2);
    expect(data.missing).toEqual([]);
    expect(data.report).toContain('PASS');
  });

  // ─── 2. Missing test file ──────────────────────────────────────────────

  it('missingTestFile_returnsFailedWithMissingList', () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      if (path === '/repo/src/widget.test.ts') return true;
      if (path === '/repo/src/utils.test.ts') return false;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      missing: readonly string[];
      found: number;
    };
    expect(data.passed).toBe(false);
    expect(data.missing).toContain('src/utils.test.ts');
    expect(data.found).toBe(1);
  });

  // ─── 3. No test files in plan ─────────────────────────────────────────

  it('noTestFilesInPlan_returnsFailedWithZeroTests', () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITHOUT_TESTS);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      totalTests: number;
      report: string;
    };
    expect(data.passed).toBe(false);
    expect(data.totalTests).toBe(0);
    expect(data.report).toContain('FAIL');
  });

  // ─── 4. Test execution fails ──────────────────────────────────────────

  it('testExecutionFails_returnsFailedWithReport', () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      if (path === '/repo/src/widget.test.ts') return true;
      if (path === '/repo/src/utils.test.ts') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);
    mockedExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
      const argsArr = args as readonly string[];
      // First test passes, second fails
      if (argsArr && argsArr.some((a: string) => a.includes('utils.test.ts'))) {
        throw new Error('Test failed');
      }
      return Buffer.from('');
    });

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      report: string;
    };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('FAIL');
  });

  // ─── 5. skipRun skips execution ───────────────────────────────────────

  it('skipRunTrue_skipsExecutionOnlyChecksExistence', () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      if (path === '/repo/src/widget.test.ts') return true;
      if (path === '/repo/src/utils.test.ts') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      skipRun: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      totalTests: number;
      found: number;
    };
    expect(data.passed).toBe(true);
    expect(data.totalTests).toBe(2);
    expect(data.found).toBe(2);
    // execFileSync should NOT have been called
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  // ─── 6. Plan file not found ───────────────────────────────────────────

  it('planFileNotFound_returnsError', () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return false;
      if (path === '/repo') return true;
      return false;
    });

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('Plan file not found');
  });

  // ─── 7. Multiple test files, some missing ─────────────────────────────

  it('multipleTestFilesSomeMissing_partialReport', () => {
    const planContent = makePlanWithTests([
      'src/a.test.ts',
      'src/b.test.ts',
      'src/c.test.ts',
    ]);
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      if (path === '/repo/src/a.test.ts') return true;
      if (path === '/repo/src/b.test.ts') return false;
      if (path === '/repo/src/c.test.ts') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(planContent);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      totalTests: number;
      found: number;
      missing: readonly string[];
      report: string;
    };
    expect(data.passed).toBe(false);
    expect(data.totalTests).toBe(3);
    expect(data.found).toBe(2);
    expect(data.missing).toEqual(['src/b.test.ts']);
    expect(data.report).toContain('src/b.test.ts');
    expect(data.report).toContain('FAIL');
  });

  // ─── 8. Repo root not found ───────────────────────────────────────────

  it('repoRootNotFound_returnsError', () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return false;
      return false;
    });

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('Repo root');
  });

  // ─── 9. Report contains markdown structure ────────────────────────────

  it('report_containsMarkdownStructure', () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      if (path === '/repo/src/widget.test.ts') return true;
      if (path === '/repo/src/utils.test.ts') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);
    mockedExecFileSync.mockReturnValue(Buffer.from(''));

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { report: string };
    expect(data.report).toContain('## Spec Coverage Report');
    expect(data.report).toContain('### Coverage Summary');
    expect(data.report).toContain('### Check Results');
  });
});

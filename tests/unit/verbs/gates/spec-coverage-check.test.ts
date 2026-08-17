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
import {
  handleSpecCoverageCheck,
  extractTestFiles,
  testPathWellFormednessError,
} from '../../../../src/verbs/gates/spec-coverage-check.js';

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

// ─── extractTestFiles — declaration forms ────────────────────────────────────

describe('extractTestFiles', () => {
  it('extractsLegacyTestFileDeclarations', () => {
    const plan = [
      '### Task: build widget',
      '**Test file:** `src/widget.test.ts`',
    ].join('\n');
    expect(extractTestFiles(plan)).toEqual(['src/widget.test.ts']);
  });

  it('extractsTestPathsFromUnifiedFilesList', () => {
    // Canonical unified spec: test files appear as backticked paths in the
    // per-task `**Files:**` list, alongside implementation files. Only the
    // test paths are collected.
    const spec = [
      '### Task 001: Render widgets',
      '**Files:**',
      '- `src/widget.ts`',
      '- `src/widget.test.ts` (medium/high tiers)',
      '- `src/cache.ts`',
      '- `src/cache.spec.tsx`',
    ].join('\n');
    expect(extractTestFiles(spec)).toEqual([
      'src/widget.test.ts',
      'src/cache.spec.tsx',
    ]);
  });

  it('deduplicatesRepeatedTestPaths', () => {
    const plan = [
      '- `src/widget.test.ts`',
      '**Test file:** `src/widget.test.ts`',
    ].join('\n');
    expect(extractTestFiles(plan)).toEqual(['src/widget.test.ts']);
  });
});

// ─── testPathWellFormednessError — plan-time syntax ──────────────────────────

describe('testPathWellFormednessError', () => {
  it('acceptsRepoRelativeTestPath', () => {
    expect(testPathWellFormednessError('src/widget.test.ts')).toBeNull();
    expect(testPathWellFormednessError('packages/a/foo.spec.tsx')).toBeNull();
  });

  it('rejectsNonTestFile', () => {
    expect(testPathWellFormednessError('src/widget.ts')).not.toBeNull();
  });

  it('rejectsAbsolutePath', () => {
    expect(testPathWellFormednessError('/repo/src/widget.test.ts')).not.toBeNull();
    expect(testPathWellFormednessError('C:\\repo\\widget.test.ts')).not.toBeNull();
  });

  it('rejectsParentEscape', () => {
    expect(testPathWellFormednessError('../outside/widget.test.ts')).not.toBeNull();
  });

  it('rejectsEmptyPath', () => {
    expect(testPathWellFormednessError('   ')).not.toBeNull();
  });
});

// ─── Plan vs post-implementation lifecycle split (WFQ-010) ───────────────────

describe('handleSpecCoverageCheck — plan-syntax phase (WFQ-010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('planPhase_NotYetCreatedTestPaths_Passes', () => {
    // Exit proof (a): a plan declaring test files that do NOT yet exist on disk
    // is a valid forward declaration and PASSES the plan-time check.
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true; // plan file itself
      // repo root and every declared test path are absent on disk.
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'plan',
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      phase: string;
      passed: boolean;
      totalTests: number;
      found: number;
      missing: readonly string[];
      malformed: readonly string[];
    };
    expect(data.phase).toBe('plan');
    expect(data.passed).toBe(true);
    expect(data.totalTests).toBe(2);
    expect(data.found).toBe(2); // both well-formed
    expect(data.missing).toEqual([]); // existence not checked at plan time
    expect(data.malformed).toEqual([]);
    // Plan-time validation never runs tests.
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('planPhase_DoesNotProbeTestPathsOnDisk', () => {
    // Discriminating: plan-time must not stat the declared test paths. Track
    // every path existsSync is asked about; only the plan file may be probed.
    const probed: string[] = [];
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      probed.push(path);
      return path === '/repo/plan.md';
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'plan',
    });

    expect(probed).toContain('/repo/plan.md');
    expect(probed.some((p) => p.includes('widget.test.ts'))).toBe(false);
    expect(probed.some((p) => p.includes('utils.test.ts'))).toBe(false);
  });

  it('planPhase_RepoRootNeedNotExist', () => {
    // Plan-time validation runs before the worktree is laid down, so a missing
    // repo root must NOT error the way the post-implementation phase does.
    mockedExistsSync.mockImplementation((p: unknown) => String(p) === '/repo/plan.md');
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/does/not/exist',
      coveragePhase: 'plan',
    });

    expect(result.success).toBe(true);
    expect((result.data as { passed: boolean }).passed).toBe(true);
  });

  it('planPhase_MalformedTestPath_Fails', () => {
    // Exit proof: a plan-time syntax gap (a declared path that is not a valid
    // test path) is still rejected.
    mockedExistsSync.mockImplementation((p: unknown) => String(p) === '/repo/plan.md');
    mockedReadFileSync.mockReturnValue(
      ['### Task: build widget', '**Test file:** `src/widget.ts`'].join('\n'),
    );

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'plan',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; malformed: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.malformed).toContain('src/widget.ts');
  });

  it('planPhase_NoTestFilesDeclared_Fails', () => {
    mockedExistsSync.mockImplementation((p: unknown) => String(p) === '/repo/plan.md');
    mockedReadFileSync.mockReturnValue(PLAN_WITHOUT_TESTS);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'plan',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; totalTests: number; report: string };
    expect(data.passed).toBe(false);
    expect(data.totalTests).toBe(0);
    expect(data.report).toContain('FAIL');
  });
});

describe('handleSpecCoverageCheck — post-implementation phase (WFQ-010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('postImplementationPhase_SamePathsMissing_Fails', () => {
    // Exit proof (b): the SAME plan that passed plan-syntax fails the
    // post-implementation phase while the declared files are still missing.
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      return false; // declared test files absent
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'post-implementation',
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      phase: string;
      passed: boolean;
      missing: readonly string[];
    };
    expect(data.phase).toBe('post-implementation');
    expect(data.passed).toBe(false);
    expect(data.missing).toEqual(['src/widget.test.ts', 'src/utils.test.ts']);
    // Existence failed for both, so execution is short-circuited.
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('postImplementationPhase_FilesExistAndPass_Passes', () => {
    // Exit proof (b, positive): once the files exist and their tests really
    // run and pass, the post-implementation phase passes.
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
      coveragePhase: 'post-implementation',
    });

    expect(result.success).toBe(true);
    expect((result.data as { passed: boolean }).passed).toBe(true);
    // Real execution happened for both declared tests.
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('postImplementationPhase_FilesExistButTestsFail_Fails', () => {
    // Post-implementation stays honest: present files whose tests do NOT pass
    // still fail.
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
      if (argsArr && argsArr.some((a: string) => a.includes('utils.test.ts'))) {
        throw new Error('Test failed');
      }
      return Buffer.from('');
    });

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'post-implementation',
    });

    expect(result.success).toBe(true);
    expect((result.data as { passed: boolean }).passed).toBe(false);
  });

  it('defaultsToPostImplementationPhase', () => {
    // Backward compatibility: no explicit phase behaves as post-implementation
    // (checks existence + execution).
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      return false; // declared test files absent
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = handleSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { phase: string; passed: boolean };
    expect(data.phase).toBe('post-implementation');
    expect(data.passed).toBe(false);
  });
});

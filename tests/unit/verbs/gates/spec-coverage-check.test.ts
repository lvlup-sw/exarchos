// Tests for `handleSpecCoverageCheck`, which compares the test files that a plan declares
// with the files on disk, and can run them.
// These cases test the provider verdict, so the gate-runner stub calls only the provider.
// `gate-runner.test.ts` proves the runner against a real store.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../../../../src/verbs/gates/gate-runner.js', () => ({
  runPhaseGateWithEvidence: vi.fn(async (request) => {
    try {
      return await request.executeProvider(
        {
          gateClass: request.gateClass,
          providerRef: 'test-provider',
          actionName: 'test-provider',
        },
        request.providerInput,
      );
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'GATE_PROVIDER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }),
}));

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  handleSpecCoverageCheck,
  extractTestFiles,
  testPathWellFormednessError,
} from '../../../../src/verbs/gates/spec-coverage-check.js';
import type { SpecCoverageCheckArgs } from '../../../../src/verbs/gates/spec-coverage-check.js';
import type { ToolResult } from '../../../../src/format.js';
import type { EventStore } from '../../../../src/events/store.js';

const STATE_DIR = '/tmp/test-spec-coverage-check';

/** The evidence runner needs a store. The stubbed runner never reaches it. */
const stubStore = {
  append: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
} as unknown as EventStore;

async function runSpecCoverageCheck(
  args: Omit<SpecCoverageCheckArgs, 'featureId'> & { featureId?: string },
): Promise<ToolResult> {
  return handleSpecCoverageCheck(
    { featureId: 'feature-under-test', ...args },
    STATE_DIR,
    stubStore,
  );
}

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExecFileSync = vi.mocked(execFileSync);

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

describe('handleSpecCoverageCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allTestFilesExistAndPass_returnsPassed', async () => {
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

    const result = await runSpecCoverageCheck({
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

  it('missingTestFile_returnsFailedWithMissingList', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      if (path === '/repo/src/widget.test.ts') return true;
      if (path === '/repo/src/utils.test.ts') return false;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = await runSpecCoverageCheck({
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

  it('noTestFilesInPlan_returnsFailedWithZeroTests', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITHOUT_TESTS);

    const result = await runSpecCoverageCheck({
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

  it('testExecutionFails_returnsFailedWithReport', async () => {
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

    const result = await runSpecCoverageCheck({
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

  it('skipRunTrue_skipsExecutionOnlyChecksExistence', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      if (path === '/repo/src/widget.test.ts') return true;
      if (path === '/repo/src/utils.test.ts') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = await runSpecCoverageCheck({
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
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('planFileNotFound_returnsError', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return false;
      if (path === '/repo') return true;
      return false;
    });

    const result = await runSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('Plan file not found');
  });

  it('multipleTestFilesSomeMissing_partialReport', async () => {
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

    const result = await runSpecCoverageCheck({
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

  it('repoRootNotFound_returnsError', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return false;
      return false;
    });

    const result = await runSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.message).toContain('Repo root');
  });

  it('report_containsMarkdownStructure', async () => {
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

    const result = await runSpecCoverageCheck({
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

describe('extractTestFiles', () => {
  it('extractsLegacyTestFileDeclarations', async () => {
    const plan = [
      '### Task: build widget',
      '**Test file:** `src/widget.test.ts`',
    ].join('\n');
    expect(extractTestFiles(plan)).toEqual(['src/widget.test.ts']);
  });

  /** In a unified spec, the per-task `**Files:**` list holds test and implementation paths. Only the test paths are collected. */
  it('extractsTestPathsFromUnifiedFilesList', async () => {
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

  it('deduplicatesRepeatedTestPaths', async () => {
    const plan = [
      '- `src/widget.test.ts`',
      '**Test file:** `src/widget.test.ts`',
    ].join('\n');
    expect(extractTestFiles(plan)).toEqual(['src/widget.test.ts']);
  });
});

describe('testPathWellFormednessError', () => {
  it('acceptsRepoRelativeTestPath', async () => {
    expect(testPathWellFormednessError('src/widget.test.ts')).toBeNull();
    expect(testPathWellFormednessError('packages/a/foo.spec.tsx')).toBeNull();
  });

  it('rejectsNonTestFile', async () => {
    expect(testPathWellFormednessError('src/widget.ts')).not.toBeNull();
  });

  it('rejectsAbsolutePath', async () => {
    expect(testPathWellFormednessError('/repo/src/widget.test.ts')).not.toBeNull();
    expect(testPathWellFormednessError('C:\\repo\\widget.test.ts')).not.toBeNull();
  });

  it('rejectsParentEscape', async () => {
    expect(testPathWellFormednessError('../outside/widget.test.ts')).not.toBeNull();
  });

  it('rejectsEmptyPath', async () => {
    expect(testPathWellFormednessError('   ')).not.toBeNull();
  });
});

describe('handleSpecCoverageCheck — plan-syntax phase (WFQ-010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * At plan time, a declared test file that does not exist yet is a valid forward declaration.
   * The check does not test existence and does not run tests.
   */
  it('planPhase_NotYetCreatedTestPaths_Passes', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = await runSpecCoverageCheck({
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
    expect(data.found).toBe(2);
    expect(data.missing).toEqual([]);
    expect(data.malformed).toEqual([]);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  /** The plan-time check must not probe the declared test paths. Only the plan file can be probed. */
  it('planPhase_DoesNotProbeTestPathsOnDisk', async () => {
    const probed: string[] = [];
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      probed.push(path);
      return path === '/repo/plan.md';
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    await runSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'plan',
    });

    expect(probed).toContain('/repo/plan.md');
    expect(probed.some((p) => p.includes('widget.test.ts'))).toBe(false);
    expect(probed.some((p) => p.includes('utils.test.ts'))).toBe(false);
  });

  /** The plan-time check runs before the worktree exists, so a missing repo root is not an error. */
  it('planPhase_RepoRootNeedNotExist', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => String(p) === '/repo/plan.md');
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = await runSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/does/not/exist',
      coveragePhase: 'plan',
    });

    expect(result.success).toBe(true);
    expect((result.data as { passed: boolean }).passed).toBe(true);
  });

  /** A declared path that is not a valid test path fails at plan time. */
  it('planPhase_MalformedTestPath_Fails', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => String(p) === '/repo/plan.md');
    mockedReadFileSync.mockReturnValue(
      ['### Task: build widget', '**Test file:** `src/widget.ts`'].join('\n'),
    );

    const result = await runSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'plan',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; malformed: readonly string[] };
    expect(data.passed).toBe(false);
    expect(data.malformed).toContain('src/widget.ts');
  });

  it('planPhase_NoTestFilesDeclared_Fails', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => String(p) === '/repo/plan.md');
    mockedReadFileSync.mockReturnValue(PLAN_WITHOUT_TESTS);

    const result = await runSpecCoverageCheck({
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

  /** The plan that passes at plan time fails here while the declared files are missing. The tests do not run. */
  it('postImplementationPhase_SamePathsMissing_Fails', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = await runSpecCoverageCheck({
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
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  /** When the files exist and their tests run and pass, the phase passes. */
  it('postImplementationPhase_FilesExistAndPass_Passes', async () => {
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

    const result = await runSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'post-implementation',
    });

    expect(result.success).toBe(true);
    expect((result.data as { passed: boolean }).passed).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('postImplementationPhase_FilesExistButTestsFail_Fails', async () => {
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

    const result = await runSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
      coveragePhase: 'post-implementation',
    });

    expect(result.success).toBe(true);
    expect((result.data as { passed: boolean }).passed).toBe(false);
  });

  it('defaultsToPostImplementationPhase', async () => {
    mockedExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/plan.md') return true;
      if (path === '/repo') return true;
      return false;
    });
    mockedReadFileSync.mockReturnValue(PLAN_WITH_TWO_TESTS);

    const result = await runSpecCoverageCheck({
      planFile: '/repo/plan.md',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { phase: string; passed: boolean };
    expect(data.phase).toBe('post-implementation');
    expect(data.passed).toBe(false);
  });
});

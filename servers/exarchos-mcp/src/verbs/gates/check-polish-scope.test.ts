import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckPolishScopeResult } from './check-polish-scope.js';

vi.mock('node:child_process');
vi.mock('node:fs');

const { execFileSync } = await import('node:child_process');
const { existsSync } = await import('node:fs');

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExistsSync = vi.mocked(existsSync);

function gitDiffOutput(files: readonly string[]): string {
  return files.join('\n') + (files.length > 0 ? '\n' : '');
}

describe('Check Polish Scope', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  it('under limits — 3 files, 1 module → scopeOk: true', async () => {
    mockedExecFileSync.mockReturnValue(
      gitDiffOutput(['src/foo.ts', 'src/bar.ts', 'src/baz.ts']),
    );

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    const result = handleCheckPolishScope({ repoRoot: '/repo' });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(true);
    expect(data.fileCount).toBe(3);
    expect(data.moduleCount).toBe(1);
    expect(data.triggers).toHaveLength(0);
    expect(data.checks.every((c) => c.passed)).toBe(true);
    expect(data.report).toContain('SCOPE OK');
  });

  it('file count exceeds 5 → scopeOk: false', async () => {
    mockedExecFileSync.mockReturnValue(
      gitDiffOutput([
        'src/a.ts',
        'src/b.ts',
        'src/c.ts',
        'src/d.ts',
        'src/e.ts',
        'src/f.ts',
      ]),
    );

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    const result = handleCheckPolishScope({ repoRoot: '/repo' });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.fileCount).toBe(6);
    expect(data.triggers).toContain('File count (6) exceeds limit of 5');
    expect(data.report).toContain('SCOPE EXPANDED');
  });

  it('module boundaries crossed (>2 dirs) → scopeOk: false', async () => {
    mockedExecFileSync.mockReturnValue(
      gitDiffOutput(['src/a.ts', 'lib/b.ts', 'tests/c.ts']),
    );

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    const result = handleCheckPolishScope({ repoRoot: '/repo' });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.moduleCount).toBe(3);
    expect(data.triggers.some((t) => t.includes('Module boundaries crossed'))).toBe(true);
  });

  it('missing test files → scopeOk: false', async () => {
    mockedExecFileSync.mockReturnValue(
      gitDiffOutput(['src/foo.ts', 'src/bar.ts']),
    );
    // foo.test.ts exists, bar.test.ts does not
    mockedExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.includes('foo.test.ts');
    });

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    const result = handleCheckPolishScope({ repoRoot: '/repo' });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.triggers.some((t) => t.includes('New test files needed'))).toBe(true);
  });

  it('architectural docs needed — structural files across >1 module → scopeOk: false', async () => {
    mockedExecFileSync.mockReturnValue(
      gitDiffOutput(['src/index.ts', 'lib/utils.ts']),
    );

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    const result = handleCheckPolishScope({ repoRoot: '/repo' });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.triggers.some((t) => t.includes('Architectural documentation needed'))).toBe(true);
  });

  it('multiple triggers fire together', async () => {
    mockedExecFileSync.mockReturnValue(
      gitDiffOutput([
        'src/a.ts',
        'src/b.ts',
        'lib/c.ts',
        'tests/d.ts',
        'pkg/e.ts',
        'pkg/index.ts',
      ]),
    );
    // No test files exist
    mockedExistsSync.mockReturnValue(false);

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    const result = handleCheckPolishScope({ repoRoot: '/repo' });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(false);
    expect(data.fileCount).toBe(6);
    expect(data.moduleCount).toBe(4);
    // File count, module boundaries, missing tests, and arch docs triggers
    expect(data.triggers.length).toBeGreaterThanOrEqual(3);
    expect(data.triggers.some((t) => t.includes('File count'))).toBe(true);
    expect(data.triggers.some((t) => t.includes('Module boundaries'))).toBe(true);
    expect(data.triggers.some((t) => t.includes('test files needed'))).toBe(true);
    expect(data.triggers.some((t) => t.includes('Architectural documentation'))).toBe(true);
  });

  it('empty diff → scopeOk: true', async () => {
    mockedExecFileSync.mockReturnValue('');

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    const result = handleCheckPolishScope({ repoRoot: '/repo' });

    expect(result.success).toBe(true);
    const data = result.data as CheckPolishScopeResult;
    expect(data.scopeOk).toBe(true);
    expect(data.fileCount).toBe(0);
    expect(data.moduleCount).toBe(0);
    expect(data.triggers).toHaveLength(0);
  });

  it('both git diff attempts fail → DIFF_FAILED error', async () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('git diff failed');
    });

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    const result = handleCheckPolishScope({ repoRoot: '/repo' });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIFF_FAILED');
    expect(result.error?.message).toContain('main');
    expect(result.error?.message).toContain('/repo');
    expect(result.data).toBeUndefined();
  });

  it('default baseBranch is "main"', async () => {
    mockedExecFileSync.mockReturnValue(gitDiffOutput(['src/foo.ts']));

    const { handleCheckPolishScope } = await import('./check-polish-scope.js');
    handleCheckPolishScope({ repoRoot: '/repo' });

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['diff', '--name-only', 'main...HEAD'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });
});

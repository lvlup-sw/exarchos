import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSetupWorktree } from './setup-worktree.js';

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Default valid package.json with test:run script (so the resolver picks the
// npm path with test:run available — keeps the install step at 'pass').
const VALID_PACKAGE_JSON = JSON.stringify({
  name: 'fixture',
  scripts: { 'test:run': 'vitest run', typecheck: 'tsc --noEmit' },
});

function defaultReadFileSync(p: unknown): string {
  const path = String(p);
  if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
  return '';
}

describe('handleSetupWorktree', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // readdirSync is used by the resolver for .csproj fallback — keep it safe.
    vi.mocked(readdirSync).mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockImplementation(defaultReadFileSync as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 9: Derived paths are correct ───────────────────────────────────

  it('DerivedPaths_AreCorrect', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) return '';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-001-user-model') return true;
      if (path === '/repo/.worktrees/task-001-user-model/package.json') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-001',
      taskName: 'user-model',
    });

    expect(result.success).toBe(true);
    const data = result.data as { worktreePath: string; branchName: string };
    expect(data.worktreePath).toBe('/repo/.worktrees/task-001-user-model');
    expect(data.branchName).toBe('feature/task-001-user-model');
  });

  // ── Test 1: Full setup succeeds ─────────────────────────────────────────

  it('FullSetup_AllStepsPass', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) {
        const error = new Error('not found') as Error & { status: number };
        error.status = 1;
        throw error;
      }
      if (cmdStr === 'git' && argsArr.includes('branch')) return '';
      if (cmdStr === 'git' && argsArr.includes('worktree')) return '';
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) return '';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-001-setup') return false;
      if (path === '/repo/.worktrees/task-001-setup/package.json') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-001',
      taskName: 'setup',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { pass: number; fail: number; skip: number } };
    expect(data.passed).toBe(true);
    expect(data.checks.fail).toBe(0);
    expect(data.checks.pass).toBe(5);
  });

  // ── Test 2: Branch already exists ───────────────────────────────────────

  it('BranchExists_SkipsCreation_StepPasses', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) return '';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-002-auth') return true;
      if (path === '/repo/.worktrees/task-002-auth/package.json') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-002',
      taskName: 'auth',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(true);
    expect(data.report).toContain('already exists');
  });

  // ── Test 3: Worktree already exists ─────────────────────────────────────

  it('WorktreeExists_SkipsCreation_StepPasses', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) return '';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-003-db') return true;
      if (path === '/repo/.worktrees/task-003-db/package.json') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-003',
      taskName: 'db',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(true);
    expect(data.report).toContain('already exists');
  });

  // ── Test 4: .worktrees not gitignored → adds to .gitignore ─────────────

  it('WorktreesNotGitignored_AddsToGitignore', () => {
    let gitignoreCheckCallCount = 0;
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) {
        gitignoreCheckCallCount++;
        if (gitignoreCheckCallCount === 1) {
          const error = new Error('not ignored') as Error & { status: number };
          error.status = 1;
          throw error;
        }
        return '';
      }
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) return '';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.gitignore') return true;
      if (path === '/repo/.worktrees/task-004-api') return true;
      if (path === '/repo/.worktrees/task-004-api/package.json') return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.gitignore') return 'node_modules/\n';
      if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
      return '';
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-004',
      taskName: 'api',
    });

    expect(result.success).toBe(true);
    expect(appendFileSync).toHaveBeenCalledWith(
      '/repo/.gitignore',
      '.worktrees/\n',
    );
  });

  // ── Test 5: install fails ───────────────────────────────────────────────

  it('NpmInstallFails_Step4Fails', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr.includes('install')) {
        const error = new Error('npm install failed') as Error & { status: number };
        error.status = 1;
        throw error;
      }
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-005-fail') return true;
      if (path === '/repo/.worktrees/task-005-fail/package.json') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-005',
      taskName: 'fail',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { fail: number } };
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
  });

  // ── Test 6: skipTests=true → step 5 skipped ────────────────────────────

  it('SkipTests_Step5Skipped', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) {
        throw new Error('should not be called');
      }
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-006-skip') return true;
      if (path === '/repo/.worktrees/task-006-skip/package.json') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-006',
      taskName: 'skip',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { skip: number } };
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
  });

  // ── Test 7: Tests fail → step 5 fails, overall passed=false ────────────

  it('TestsFail_Step5Fails_OverallFails', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) {
        const error = new Error('tests failed') as Error & { status: number };
        error.status = 1;
        throw error;
      }
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-007-tests') return true;
      if (path === '/repo/.worktrees/task-007-tests/package.json') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-007',
      taskName: 'tests',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { fail: number } };
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
  });

  // ── Test 8: Missing repoRoot → error ───────────────────────────────────

  it('MissingRepoRoot_ReturnsError', () => {
    const result = handleSetupWorktree({
      repoRoot: '',
      taskId: 'task-008',
      taskName: 'missing',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('MissingTaskId_ReturnsError', () => {
    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: '',
      taskName: 'missing',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('MissingTaskName_ReturnsError', () => {
    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-009',
      taskName: '',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  // ── T09 install-step tests (resolver-driven, lockfile-aware) ────────────

  it('runInstallStep_NoPackageJson_SkipsWithReason', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      // npm/pnpm/yarn/bun should NOT be invoked when package.json is absent.
      if (cmdStr === 'npm' || cmdStr === 'pnpm' || cmdStr === 'yarn' || cmdStr === 'bun') {
        throw new Error(`unexpected install invocation: ${cmdStr}`);
      }
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      // Worktree exists so step 4 runs; no package.json or lockfiles.
      if (path === '/repo/.worktrees/task-100-empty') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-100',
      taskName: 'empty',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { report: string; checks: { skip: number } };
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    // Step 4 surfaces the resolver's remediation in the report
    expect(data.report).toMatch(/SKIP.*install/);
  });

  it('runInstallStep_NpmProject_RunsNpmInstall', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-101-npm') return true;
      if (path === '/repo/.worktrees/task-101-npm/package.json') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-101',
      taskName: 'npm',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean };
    expect(data.passed).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['install'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-101-npm' }),
    );
  });

  it('runInstallStep_PnpmLockfilePresent_DoesNotRunNpmInstall_RunsPnpmInstall', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-102-pnpm') return true;
      if (path === '/repo/.worktrees/task-102-pnpm/package.json') return true;
      if (path === '/repo/.worktrees/task-102-pnpm/pnpm-lock.yaml') return true;
      return false;
    });
    // pnpm scripts: include "test" (resolver requires "test" for pnpm path).
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('package.json')) {
        return JSON.stringify({
          name: 'fixture-pnpm',
          scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
        });
      }
      return '';
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-102',
      taskName: 'pnpm',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'pnpm',
      ['install', '--frozen-lockfile'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-102-pnpm' }),
    );
    // Critical: the destructive npm-install path must NOT have been triggered.
    const npmInstallCalls = vi.mocked(execFileSync).mock.calls.filter(
      (call) => call[0] === 'npm' && Array.isArray(call[1]) && (call[1] as string[])[0] === 'install',
    );
    expect(npmInstallCalls).toHaveLength(0);
  });

  it('runInstallStep_YarnLockfilePresent_RunsYarnInstall', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-103-yarn') return true;
      if (path === '/repo/.worktrees/task-103-yarn/package.json') return true;
      if (path === '/repo/.worktrees/task-103-yarn/yarn.lock') return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('package.json')) {
        return JSON.stringify({
          name: 'fixture-yarn',
          scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
        });
      }
      return '';
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-103',
      taskName: 'yarn',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'yarn',
      ['install', '--immutable'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-103-yarn' }),
    );
  });

  it('runInstallStep_BunLockfilePresent_RunsBunInstall', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-104-bun') return true;
      if (path === '/repo/.worktrees/task-104-bun/package.json') return true;
      if (path === '/repo/.worktrees/task-104-bun/bun.lockb') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-104',
      taskName: 'bun',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'bun',
      ['install'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-104-bun' }),
    );
  });

  it('runInstallStep_BunPriorityOverPnpm_BunWins', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-105-priority') return true;
      if (path === '/repo/.worktrees/task-105-priority/package.json') return true;
      // Both lockfiles present — bun wins per resolver priority chain.
      if (path === '/repo/.worktrees/task-105-priority/bun.lockb') return true;
      if (path === '/repo/.worktrees/task-105-priority/pnpm-lock.yaml') return true;
      return false;
    });

    const result = handleSetupWorktree({
      repoRoot: '/repo',
      taskId: 'task-105',
      taskName: 'priority',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'bun',
      ['install'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-105-priority' }),
    );
    const pnpmCalls = vi.mocked(execFileSync).mock.calls.filter((c) => c[0] === 'pnpm');
    expect(pnpmCalls).toHaveLength(0);
  });
});

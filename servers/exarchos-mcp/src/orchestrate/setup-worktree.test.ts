import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSetupWorktree } from './setup-worktree.js';

// Mock node:fs
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

describe('handleSetupWorktree', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 9: Derived paths are correct ───────────────────────────────────

  it('DerivedPaths_AreCorrect', () => {
    // Set up: gitignore check passes, branch exists, worktree exists and valid, has package.json, tests pass
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
    // git check-ignore succeeds (already ignored)
    // git show-ref fails (branch does not exist) -> branch creation succeeds
    // worktree does not exist -> worktree add succeeds
    // package.json exists -> npm install succeeds
    // tests pass
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
      // worktree dir does not exist yet
      if (path === '/repo/.worktrees/task-001-setup') return false;
      // package.json exists after worktree creation
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
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return ''; // branch exists
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
    // Step 2 should pass (branch already exists)
    expect(data.report).toContain('already exists');
  });

  // ── Test 3: Worktree already exists ─────────────────────────────────────

  it('WorktreeExists_SkipsCreation_StepPasses', () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd);
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git'; // valid worktree
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) return '';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-003-db') return true; // worktree dir exists
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
          // First call: not ignored
          const error = new Error('not ignored') as Error & { status: number };
          error.status = 1;
          throw error;
        }
        // Second call: now ignored after we added it
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
      if (path === '/repo/.gitignore') return true; // .gitignore exists
      if (path === '/repo/.worktrees/task-004-api') return true;
      if (path === '/repo/.worktrees/task-004-api/package.json') return true;
      return false;
    });
    vi.mocked(readFileSync).mockReturnValue('node_modules/\n');

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

  // ── Test 5: npm install fails ───────────────────────────────────────────

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
});

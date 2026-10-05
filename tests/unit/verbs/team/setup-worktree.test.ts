import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSetupWorktree } from '../../../../src/verbs/team/setup-worktree.js';
import { BURST_STAGGER_MIN_MS, BURST_STAGGER_MAX_MS } from '../../../../src/verbs/worktree/git-retry.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type {
  WorktreeProvisioner,
  WorktreeProvisionRequest,
  WorktreeProvisionOutcome,
} from '../../../../src/vcs/worktree-provisioner.js';

/**
 * The result of the in-memory provisioner fake, which each test can set. The
 * fake replaces real git and the EventStore. `lastProvisionRequest` and
 * `provisionRequests` record the branch and base that the handler asks for.
 */
let provisionOutcome: WorktreeProvisionOutcome;
let lastProvisionRequest: WorktreeProvisionRequest | undefined;
const provisionRequests: WorktreeProvisionRequest[] = [];

const fakeProvisioner: WorktreeProvisioner = {
  provision(req: WorktreeProvisionRequest): Promise<WorktreeProvisionOutcome> {
    lastProvisionRequest = req;
    provisionRequests.push(req);
    return Promise.resolve(provisionOutcome);
  },
};

/**
 * Call the real `handleSetupWorktree` with the fake provisioner. A test can pass
 * other seams, such as `sleep` and `jitter`, and they merge over the default.
 */
function callSetup(
  args: Parameters<typeof handleSetupWorktree>[0],
  workflowState?: Parameters<typeof handleSetupWorktree>[1],
  seams?: Parameters<typeof handleSetupWorktree>[2],
): ReturnType<typeof handleSetupWorktree> {
  return handleSetupWorktree(args, workflowState, {
    provisioner: fakeProvisioner,
    ...(seams ?? {}),
  });
}

/** The default `package.json`. Its `test:run` script gives the npm path a test command. */
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
  /**
   * Toolchain detection calls `readdirSync` for an extension marker such as
   * `.csproj`, so the mock returns an empty list. The provisioner fake defaults to
   * a full success. Tests for an existing branch or worktree override it.
   */
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(readdirSync).mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);
    vi.mocked(readFileSync).mockImplementation(defaultReadFileSync as never);
    provisionOutcome = { ok: true, branchCreated: true, worktreeCreated: true };
    lastProvisionRequest = undefined;
    provisionRequests.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('DerivedPaths_AreCorrect', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-001',
      taskName: 'user-model',
    });

    expect(result.success).toBe(true);
    const data = result.data as { worktreePath: string; branchName: string };
    expect(data.worktreePath).toBe('/repo/.worktrees/task-001-user-model');
    expect(data.branchName).toBe('feature/task-001-user-model');
  });

  it('FullSetup_AllStepsPass', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
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

  /** The provisioner reports `branchCreated: false`, so the branch check says "already exists". */
  it('BranchExists_SkipsCreation_StepPasses', async () => {
    provisionOutcome = { ok: true, branchCreated: false, worktreeCreated: true };
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-002',
      taskName: 'auth',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(true);
    expect(data.report).toContain('already exists');
  });

  /** The provisioner reports `worktreeCreated: false`, so the worktree check says "already exists". */
  it('WorktreeExists_SkipsCreation_StepPasses', async () => {
    provisionOutcome = { ok: true, branchCreated: true, worktreeCreated: false };
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-003',
      taskName: 'db',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(true);
    expect(data.report).toContain('already exists');
  });

  it('WorktreesNotGitignored_AddsToGitignore', async () => {
    let gitignoreCheckCallCount = 0;
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
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

  /**
   * The `.gitignore` ends with `dist` and no newline. A bare append makes one line,
   * `dist.worktrees/`, which ignores neither path. So the payload starts with a newline.
   */
  it('WorktreesNotGitignored_ExistingGitignoreNoTrailingNewline_PrependsNewline', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr.includes('install')) return '';
      if (cmdStr === 'npm' && argsArr.includes('test:run')) return '';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.gitignore') return true;
      if (path === '/repo/.worktrees/task-004b-newline') return true;
      if (path === '/repo/.worktrees/task-004b-newline/package.json') return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.gitignore') return 'dist';
      if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
      return '';
    });

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-004b',
      taskName: 'newline',
    });

    expect(result.success).toBe(true);
    expect(appendFileSync).toHaveBeenCalledWith(
      '/repo/.gitignore',
      '\n.worktrees/\n',
    );
  });

  it('NpmInstallFails_Step4Fails', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-005',
      taskName: 'fail',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { fail: number } };
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
  });

  it('SkipTests_Step5Skipped', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
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

  it('TestsFail_Step5Fails_OverallFails', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-007',
      taskName: 'tests',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { fail: number } };
    expect(data.passed).toBe(false);
    expect(data.checks.fail).toBeGreaterThanOrEqual(1);
  });

  it('MissingRepoRoot_ReturnsError', async () => {
    const result = await callSetup({
      repoRoot: '',
      taskId: 'task-008',
      taskName: 'missing',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('MissingTaskId_ReturnsError', async () => {
    const result = await callSetup({
      repoRoot: '/repo',
      taskId: '',
      taskName: 'missing',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('MissingTaskName_ReturnsError', async () => {
    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-009',
      taskName: '',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  /**
   * The worktree exists, so the install step runs, but the worktree holds no
   * `package.json` and no lockfile.
   */
  it('runInstallStep_NoPackageJson_SkipsWithReason', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' || cmdStr === 'pnpm' || cmdStr === 'yarn' || cmdStr === 'bun') {
        throw new Error(`unexpected install invocation: ${cmdStr}`);
      }
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-100-empty') return true;
      return false;
    });

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-100',
      taskName: 'empty',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { report: string; checks: { skip: number } };
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toMatch(/SKIP.*install/);
  });

  it('runInstallStep_NpmProject_RunsNpmInstall', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
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

  it('runInstallStep_PnpmLockfilePresent_DoesNotRunNpmInstall_RunsPnpmInstall', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
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
    const npmInstallCalls = vi.mocked(execFileSync).mock.calls.filter(
      (call) => call[0] === 'npm' && Array.isArray(call[1]) && (call[1] as string[])[0] === 'install',
    );
    expect(npmInstallCalls).toHaveLength(0);
  });

  /** Without a Berry signal, the resolver picks Yarn Classic, which takes `--frozen-lockfile` and not `--immutable`. */
  it('runInstallStep_YarnClassicLockfilePresent_RunsYarnInstallFrozen', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-103',
      taskName: 'yarn',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'yarn',
      ['install', '--frozen-lockfile'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-103-yarn' }),
    );
  });

  it('runInstallStep_YarnBerryViaYarnrcYml_RunsYarnInstallImmutable', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-103-berry') return true;
      if (path === '/repo/.worktrees/task-103-berry/package.json') return true;
      if (path === '/repo/.worktrees/task-103-berry/yarn.lock') return true;
      if (path === '/repo/.worktrees/task-103-berry/.yarnrc.yml') return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('package.json')) {
        return JSON.stringify({
          name: 'fixture-berry',
          scripts: { test: 'vitest run' },
        });
      }
      return '';
    });

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-103',
      taskName: 'berry',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'yarn',
      ['install', '--immutable'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-103-berry' }),
    );
  });

  it('runInstallStep_BunLockfilePresent_RunsBunInstall', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
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

  it('runBaselineTests_PnpmProject_RunsPnpmTest', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-200-pnpm-test') return true;
      if (path === '/repo/.worktrees/task-200-pnpm-test/package.json') return true;
      if (path === '/repo/.worktrees/task-200-pnpm-test/pnpm-lock.yaml') return true;
      return false;
    });
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

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-200',
      taskName: 'pnpm-test',
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'pnpm',
      ['test'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-200-pnpm-test' }),
    );
  });

  it('runBaselineTests_BunProjectWithTestRunScript_RunsBunRunTestRun', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-201-bun-test') return true;
      if (path === '/repo/.worktrees/task-201-bun-test/package.json') return true;
      if (path === '/repo/.worktrees/task-201-bun-test/bun.lockb') return true;
      return false;
    });

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-201',
      taskName: 'bun-test',
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'bun',
      ['run', 'test:run'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-201-bun-test' }),
    );
  });

  it('runBaselineTests_BunProjectWithoutTestRunScript_FallsBackToBunTest', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(readFileSync).mockImplementation(((p: unknown) =>
      String(p).endsWith('package.json')
        ? JSON.stringify({ name: 'bun-native', scripts: {} })
        : '') as never);
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-201-bun-test') return true;
      if (path === '/repo/.worktrees/task-201-bun-test/package.json') return true;
      if (path === '/repo/.worktrees/task-201-bun-test/bun.lockb') return true;
      return false;
    });

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-201',
      taskName: 'bun-test',
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'bun',
      ['test'],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-201-bun-test' }),
    );
  });

  it('runBaselineTests_NpmMissingTestRunScript_SkipsWithRemediation', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' && argsArr[0] === 'run') {
        throw new Error(`unexpected npm run invocation: ${argsArr.join(' ')}`);
      }
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-202-no-testrun') return true;
      if (path === '/repo/.worktrees/task-202-no-testrun/package.json') return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith('package.json')) {
        return JSON.stringify({
          name: 'fixture-no-testrun',
          scripts: { build: 'tsc' },
        });
      }
      return '';
    });

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-202',
      taskName: 'no-testrun',
    });

    expect(result.success).toBe(true);
    const data = result.data as { report: string; checks: { skip: number } };
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toMatch(/Baseline tests pass.*(test:run|\.exarchos\.yml)/);
  });

  it('runBaselineTests_PythonProject_RunsPytest', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-203-python') return true;
      if (path === '/repo/.worktrees/task-203-python/pyproject.toml') return true;
      return false;
    });

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-203',
      taskName: 'python',
    });

    expect(result.success).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'pytest',
      [],
      expect.objectContaining({ cwd: '/repo/.worktrees/task-203-python' }),
    );
  });

  it('runBaselineTests_NoMarkers_SkipsWithRemediation', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
      const argsArr = args as string[];
      if (cmdStr === 'git' && argsArr.includes('check-ignore')) return '';
      if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
      if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
      if (cmdStr === 'npm' || cmdStr === 'pnpm' || cmdStr === 'yarn' || cmdStr === 'bun' || cmdStr === 'pytest' || cmdStr === 'cargo' || cmdStr === 'dotnet') {
        throw new Error(`unexpected test invocation: ${cmdStr}`);
      }
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/repo/.worktrees/task-204-bare') return true;
      return false;
    });

    const result = await callSetup({
      repoRoot: '/repo',
      taskId: 'task-204',
      taskName: 'bare',
    });

    expect(result.success).toBe(true);
    const data = result.data as { report: string; checks: { skip: number } };
    expect(data.checks.skip).toBeGreaterThanOrEqual(1);
    expect(data.report).toMatch(/SKIP.*Baseline tests pass/);
    expect(data.report).toMatch(/Baseline tests pass.*(\.exarchos\.yml|override|markers)/);
  });

  it('runInstallStep_BunPriorityOverPnpm_BunWins', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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
      if (path === '/repo/.worktrees/task-105-priority/bun.lockb') return true;
      if (path === '/repo/.worktrees/task-105-priority/pnpm-lock.yaml') return true;
      return false;
    });

    const result = await callSetup({
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

  /**
   * The gitignore step reads the repository `.gitignore` directly. Its PASS
   * detail states what it found or changed in that file.
   */
  describe('ensureGitignored direct-read behavior', () => {
    function setupBaseExecMocks() {
      vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
        const cmdStr = String(cmd).replace(/\.cmd$/, '');
        const argsArr = args as string[];
        if (cmdStr === 'git' && argsArr.includes('show-ref')) return '';
        if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
        if (cmdStr === 'npm') return '';
        if (cmdStr === 'pnpm') return '';
        if (cmdStr === 'yarn') return '';
        if (cmdStr === 'bun') return '';
        return '';
      });
    }

    it('ensureGitignored_AlreadyPresent_ReportsAlreadyPresent', async () => {
      setupBaseExecMocks();
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return true;
        if (path === '/repo/.worktrees/T-001-x') return true;
        if (path === '/repo/.worktrees/T-001-x/package.json') return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return 'node_modules/\n.worktrees/\n';
        if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
        return '';
      });

      const result = await callSetup({
        repoRoot: '/repo', taskId: 'T-001', taskName: 'x',
      });

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; report: string };
      expect(data.report).toMatch(/PASS.*\.worktrees is gitignored.*already present/i);
      expect(appendFileSync).not.toHaveBeenCalledWith('/repo/.gitignore', expect.anything());
    });

    it('ensureGitignored_NotPresent_AppendsAndReportsAdded', async () => {
      setupBaseExecMocks();
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return true;
        if (path === '/repo/.worktrees/T-002-y') return true;
        if (path === '/repo/.worktrees/T-002-y/package.json') return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return 'node_modules/\n';
        if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
        return '';
      });

      const result = await callSetup({
        repoRoot: '/repo', taskId: 'T-002', taskName: 'y',
      });

      expect(result.success).toBe(true);
      const data = result.data as { report: string };
      expect(data.report).toMatch(/PASS.*\.worktrees is gitignored.*added/i);
      expect(appendFileSync).toHaveBeenCalledWith('/repo/.gitignore', '.worktrees/\n');
    });

    it('ensureGitignored_FileMissing_CreatesWithEntry', async () => {
      setupBaseExecMocks();
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return false;
        if (path === '/repo/.worktrees/T-003-z') return true;
        if (path === '/repo/.worktrees/T-003-z/package.json') return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
        return '';
      });

      const result = await callSetup({
        repoRoot: '/repo', taskId: 'T-003', taskName: 'z',
      });

      expect(result.success).toBe(true);
      const data = result.data as { report: string };
      expect(data.report).toMatch(/PASS.*\.worktrees is gitignored.*created/i);
      expect(appendFileSync).toHaveBeenCalledWith('/repo/.gitignore', '.worktrees/\n');
    });

    /**
     * A global ignore file can make `git check-ignore` match a path that a fresh
     * clone does not ignore. The step must add the entry to the repository file,
     * report "added", and never call `git check-ignore`.
     */
    it('ensureGitignored_GlobalIgnoreOnlyMatch_StillReportsHonestlyAndUpdatesRepoGitignore', async () => {
      setupBaseExecMocks();
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return true;
        if (path === '/repo/.worktrees/T-004-a') return true;
        if (path === '/repo/.worktrees/T-004-a/package.json') return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return 'node_modules/\n';
        if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
        return '';
      });

      const result = await callSetup({
        repoRoot: '/repo', taskId: 'T-004', taskName: 'a',
      });

      expect(result.success).toBe(true);
      const data = result.data as { report: string };
      expect(data.report).toMatch(/added/i);
      expect(appendFileSync).toHaveBeenCalledWith('/repo/.gitignore', '.worktrees/\n');
      const checkIgnoreCalls = vi.mocked(execFileSync).mock.calls.filter(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('check-ignore'),
      );
      expect(checkIgnoreCalls).toHaveLength(0);
    });

    it('ensureGitignored_AppendThrows_ReportsFail', async () => {
      setupBaseExecMocks();
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return 'node_modules/\n';
        return '';
      });
      vi.mocked(appendFileSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = await callSetup({
        repoRoot: '/repo', taskId: 'T-005', taskName: 'b',
      });

      expect(result.success).toBe(true);
      const data = result.data as { passed: boolean; report: string };
      expect(data.report).toMatch(/FAIL.*\.worktrees is gitignored.*EACCES/i);
      expect(data.passed).toBe(false);
    });
  });

  /**
   * The branch name comes from `args.branch`, then the planned branch of the task
   * in workflow state, then `feature/<taskId>-<taskName>`. The "Branch created"
   * check names the source.
   */
  describe('branch-override resolution (DR-3)', () => {
    function setupHappyPathMocks() {
      vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
        const cmdStr = String(cmd).replace(/\.cmd$/, '');
        const argsArr = args as string[];
        if (cmdStr === 'git' && argsArr.includes('show-ref')) {
          const error = new Error('not found') as Error & { status: number };
          error.status = 1;
          throw error;
        }
        if (cmdStr === 'git' && argsArr.includes('branch')) return '';
        if (cmdStr === 'git' && argsArr.includes('worktree')) return '';
        if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '.git';
        if (cmdStr === 'npm' || cmdStr === 'pnpm' || cmdStr === 'yarn' || cmdStr === 'bun') return '';
        return '';
      });
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return true;
        if (path.endsWith('/package.json')) return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return '.worktrees/\n';
        if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
        return '';
      });
    }

    it('setupWorktree_WorkflowTasksHasBranch_UsesItOverDefault', async () => {
      setupHappyPathMocks();
      const workflowState = {
        tasks: [
          { id: 'T-001', title: 't', status: 'pending', branch: 'feature/foo/t001' },
        ],
      };

      const result = await callSetup(
        {
          repoRoot: '/repo',
          taskId: 'T-001',
          taskName: 'user-model',
          skipTests: true,
        },
        workflowState,
      );

      expect(result.success).toBe(true);
      const data = result.data as { branchName: string; report: string };
      expect(data.branchName).toBe('feature/foo/t001');
      expect(data.report).toMatch(/Branch created.*from workflow state/i);
      expect(lastProvisionRequest?.branch).toBe('feature/foo/t001');
    });

    it('setupWorktree_ArgBranchOverridesWorkflowState', async () => {
      setupHappyPathMocks();
      const workflowState = {
        tasks: [
          { id: 'T-002', title: 't', status: 'pending', branch: 'feature/state/branch' },
        ],
      };

      const result = await callSetup(
        {
          repoRoot: '/repo',
          taskId: 'T-002',
          taskName: 'auth',
          skipTests: true,
          branch: 'feature/arg/branch',
        },
        workflowState,
      );

      expect(result.success).toBe(true);
      const data = result.data as { branchName: string; report: string };
      expect(data.branchName).toBe('feature/arg/branch');
      expect(data.report).toMatch(/Branch created.*from arg/i);
    });

    it('setupWorktree_NoBranchAnywhere_UsesLegacyDefault', async () => {
      setupHappyPathMocks();

      const result = await callSetup({
        repoRoot: '/repo',
        taskId: 'T-003',
        taskName: 'db',
        skipTests: true,
      });

      expect(result.success).toBe(true);
      const data = result.data as { branchName: string; report: string };
      expect(data.branchName).toBe('feature/T-003-db');
      expect(data.report).toMatch(/Branch created.*default/i);
    });
  });

  /**
   * The base comes from `args.baseBranch`, then `synthesis.integrationBranch`,
   * then the current HEAD, then `main`. The orchestrator runs setup from the
   * integration checkout, so HEAD is the integration tip.
   */
  describe('base-branch resolution (#1509/#1501)', () => {
    function setupBaseResolutionMocks(currentBranch: string) {
      vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
        const cmdStr = String(cmd).replace(/\.cmd$/, '');
        const argsArr = args as string[];
        if (cmdStr === 'git' && argsArr.includes('show-ref')) {
          const error = new Error('not found') as Error & { status: number };
          error.status = 1;
          throw error;
        }
        if (cmdStr === 'git' && argsArr.includes('rev-parse') && argsArr.includes('--abbrev-ref')) {
          return currentBranch;
        }
        if (cmdStr === 'git' && argsArr.includes('rev-parse')) return '';
        if (cmdStr === 'git' && argsArr.includes('branch')) return '';
        if (cmdStr === 'git' && argsArr.includes('worktree')) return '';
        return '';
      });
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return true;
        if (path.endsWith('/package.json')) return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return '.worktrees/\n';
        if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
        return '';
      });
    }

    function createdBranchBase(): string | undefined {
      return lastProvisionRequest?.base;
    }

    it('BaseBranch_ExplicitArg_Wins', async () => {
      setupBaseResolutionMocks('feat/head');
      await callSetup(
        { repoRoot: '/repo', taskId: 'T1', taskName: 'x', skipTests: true, baseBranch: 'release/x' },
        { synthesis: { integrationBranch: 'feat/int' } },
      );
      expect(createdBranchBase()).toBe('release/x');
    });

    it('BaseBranch_SynthesisIntegrationBranch_WhenNoArg', async () => {
      setupBaseResolutionMocks('feat/head');
      await callSetup(
        { repoRoot: '/repo', taskId: 'T1', taskName: 'x', skipTests: true },
        { synthesis: { integrationBranch: 'feat/int' } },
      );
      expect(createdBranchBase()).toBe('feat/int');
    });

    /** With no argument and no synthesis state, a stacked branch at HEAD is the base, not `main`. */
    it('BaseBranch_CurrentHead_WhenNoArgOrSynthesis', async () => {
      setupBaseResolutionMocks('feat/stacked');
      await callSetup(
        { repoRoot: '/repo', taskId: 'T1', taskName: 'x', skipTests: true },
        undefined,
      );
      expect(createdBranchBase()).toBe('feat/stacked');
      expect(createdBranchBase()).not.toBe('main');
    });

    /** When HEAD resolves to neither a branch nor a SHA, the base is `main`. */
    it('BaseBranch_FallsBackToMain_WhenHeadUnresolvable', async () => {
      setupBaseResolutionMocks('HEAD');
      await callSetup(
        { repoRoot: '/repo', taskId: 'T1', taskName: 'x', skipTests: true },
        undefined,
      );
      expect(createdBranchBase()).toBe('main');
    });
  });

  /**
   * When workflow state lists more than one task, each creation first waits a
   * jittered delay from `burstStagger`. This keeps parallel creations off the git
   * index at the same time. The tests inject `sleep` and `jitter` and do not wait.
   */
  describe('DR-1 burst-creation stagger', () => {
    function setupCreationMocks() {
      vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
        const cmdStr = String(cmd).replace(/\.cmd$/, '');
        const argsArr = args as string[];
        if (cmdStr === 'git' && argsArr.includes('show-ref')) {
          const error = new Error('not found') as Error & { status: number };
          error.status = 1;
          throw error;
        }
        return '';
      });
      vi.mocked(existsSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return true;
        if (path.endsWith('/package.json')) return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p: unknown) => {
        const path = String(p);
        if (path === '/repo/.gitignore') return '.worktrees/\n';
        if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
        return '';
      });
    }

    /** The jitter source sweeps from -1 to 1, so the recorded delays reach both bounds of the window. */
    it('SetupWorktree_BurstCreation_StaggersWithinConfiguredJitterWindow', async () => {
      setupCreationMocks();

      const recorded: number[] = [];
      const sleep = (ms: number): Promise<void> => {
        recorded.push(ms);
        return Promise.resolve();
      };

      const jitterSweep = [-1, -0.5, 0, 0.5, 1];
      let jitterCall = 0;
      const jitter = (): number => jitterSweep[jitterCall++ % jitterSweep.length];

      const workflowState = {
        tasks: jitterSweep.map((_, i) => ({ id: `T-00${i + 1}` })),
      };

      for (const task of workflowState.tasks) {
        const result = await callSetup(
          { repoRoot: '/repo', taskId: task.id, taskName: 'x', skipTests: true },
          workflowState,
          { sleep, jitter },
        );
        expect(result.success).toBe(true);
      }

      expect(recorded.length).toBe(workflowState.tasks.length);
      for (const delay of recorded) {
        expect(delay).toBeGreaterThanOrEqual(BURST_STAGGER_MIN_MS);
        expect(delay).toBeLessThanOrEqual(BURST_STAGGER_MAX_MS);
      }
      expect(recorded).toEqual([
        BURST_STAGGER_MIN_MS,
        200,
        300,
        400,
        BURST_STAGGER_MAX_MS,
      ]);
    });

    /** A single-task workflow is not a burst, so the handler calls neither `sleep` nor `jitter`. */
    it('SetupWorktree_SingleCreation_NoStaggerDelay', async () => {
      setupCreationMocks();

      const recorded: number[] = [];
      const sleep = (ms: number): Promise<void> => {
        recorded.push(ms);
        return Promise.resolve();
      };
      const jitter = vi.fn<[], number>(() => 0);

      const workflowState = { tasks: [{ id: 'T-001' }] };

      const result = await callSetup(
        { repoRoot: '/repo', taskId: 'T-001', taskName: 'x', skipTests: true },
        workflowState,
        { sleep, jitter },
      );

      expect(result.success).toBe(true);
      expect(recorded).toEqual([]);
      expect(jitter).not.toHaveBeenCalled();
    });
  });
});

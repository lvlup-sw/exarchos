import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSetupWorktree } from '../../../../src/verbs/team/setup-worktree.js';
import { BURST_STAGGER_MIN_MS, BURST_STAGGER_MAX_MS } from '../../../../src/verbs/worktree/git-retry.js';

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
import type {
  WorktreeProvisioner,
  WorktreeProvisionRequest,
  WorktreeProvisionOutcome,
} from '../../../../src/vcs/worktree-provisioner.js';

// ── VCS mutation owner seam (P04-05) ────────────────────────────────────────
// Branch+worktree creation now routes through the injected WorktreeProvisioner
// (the single typed VCS mutation owner) instead of bare `execFileSync('git',
// ['branch'|'worktree', …])`. These tests inject an in-memory fake so creation
// is asserted without real git or an EventStore: `provisionOutcome` is the
// configurable result each test drives; `lastProvisionRequest`/`provisionRequests`
// record what the handler asked for (base/branch), replacing the old assertions
// that inspected the `git branch`/`git worktree` execFileSync argv.
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
 * Invoke the real `handleSetupWorktree` entry point with the fake provisioner
 * injected (a test may still override other seams — sleep/jitter — which merge
 * over the default). Every call site awaits this; the handler is async because
 * the production provisioner is EventStore-backed.
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
    // Reset the injected VCS-provisioner seam to a fresh, fully-successful
    // creation (branch minted + worktree added). Tests that exercise the
    // "already exists" (idempotent no-op) or failure paths override this.
    provisionOutcome = { ok: true, branchCreated: true, worktreeCreated: true };
    lastProvisionRequest = undefined;
    provisionRequests.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 9: Derived paths are correct ───────────────────────────────────

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

  // ── Test 1: Full setup succeeds ─────────────────────────────────────────

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

  // ── Test 2: Branch already exists ───────────────────────────────────────

  it('BranchExists_SkipsCreation_StepPasses', async () => {
    // The branch already exists → the owner's create is an idempotent no-op
    // for the branch (worktree still freshly added), so the report reads
    // "already exists" for the branch check.
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

  // ── Test 3: Worktree already exists ─────────────────────────────────────

  it('WorktreeExists_SkipsCreation_StepPasses', async () => {
    // The worktree already exists → the owner's create is an idempotent no-op
    // for the worktree (branch may still be minted), so the report reads
    // "already exists" for the worktree check.
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

  // ── Test 4: .worktrees not gitignored → adds to .gitignore ─────────────

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

  // ── #1213 / CodeRabbit #7: gitignore append must preserve line boundary ─

  it('WorktreesNotGitignored_ExistingGitignoreNoTrailingNewline_PrependsNewline', async () => {
    // Existing .gitignore lacks trailing newline (ends with "dist", no \n).
    // A bare append would produce "dist.worktrees/\n" — a single
    // concatenated line that no longer ignores either path. The fix
    // prepends a newline so the final contents are "dist\n.worktrees/\n".
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
      // Crucially: NO trailing newline here.
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
    // The append payload MUST start with \n so the final content is
    // "dist\n.worktrees/\n", not "dist.worktrees/\n".
    expect(appendFileSync).toHaveBeenCalledWith(
      '/repo/.gitignore',
      '\n.worktrees/\n',
    );
  });

  // ── Test 5: install fails ───────────────────────────────────────────────

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

  // ── Test 6: skipTests=true → step 5 skipped ────────────────────────────

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

  // ── Test 7: Tests fail → step 5 fails, overall passed=false ────────────

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

  // ── Test 8: Missing repoRoot → error ───────────────────────────────────

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

  // ── T09 install-step tests (resolver-driven, lockfile-aware) ────────────

  it('runInstallStep_NoPackageJson_SkipsWithReason', async () => {
    vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
      const cmdStr = String(cmd).replace(/\.cmd$/, '');
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

    const result = await callSetup({
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
    // Critical: the destructive npm-install path must NOT have been triggered.
    const npmInstallCalls = vi.mocked(execFileSync).mock.calls.filter(
      (call) => call[0] === 'npm' && Array.isArray(call[1]) && (call[1] as string[])[0] === 'install',
    );
    expect(npmInstallCalls).toHaveLength(0);
  });

  it('runInstallStep_YarnClassicLockfilePresent_RunsYarnInstallFrozen', async () => {
    // No Berry signals → Classic. `--immutable` is Berry-only; Classic must
    // get `--frozen-lockfile`.
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

  // ── T10 baseline-tests tests (resolver-driven) ─────────────────────────

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
      // npm run test:run must NOT be invoked when no test:run script exists.
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
        // npm path (no lockfiles) but package.json lacks "test:run" script.
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
    // Resolver remediation references either .exarchos.yml or test:run.
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
      // No package.json — Python project marker only.
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
      // No test runner should be invoked when no markers are present.
      if (cmdStr === 'npm' || cmdStr === 'pnpm' || cmdStr === 'yarn' || cmdStr === 'bun' || cmdStr === 'pytest' || cmdStr === 'cargo' || cmdStr === 'dotnet') {
        throw new Error(`unexpected test invocation: ${cmdStr}`);
      }
      return '';
    });
    vi.mocked(existsSync).mockImplementation((p: unknown) => {
      const path = String(p);
      // Worktree exists but has no project markers.
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
    // The unresolved-state remediation mentions .exarchos.yml or override.
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
      // Both lockfiles present — bun wins per resolver priority chain.
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

  // ─── DR-1 (T-07, #1203): direct-read .gitignore, honest PASS message ──

  describe('ensureGitignored direct-read behavior', () => {
    function setupBaseExecMocks() {
      // Generic happy-path mocks for show-ref / rev-parse / install / test.
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

    it('ensureGitignored_GlobalIgnoreOnlyMatch_StillReportsHonestlyAndUpdatesRepoGitignore', async () => {
      // Critical regression coverage for #1203: a non-repo source (e.g.,
      // global gitignore, .git/info/exclude) might tell `git check-ignore`
      // the path is ignored. Repo `.gitignore` itself is empty of this entry
      // and `git status` from a fresh clone would show .worktrees/ as
      // untracked. The new contract: PASS message reflects the repo file
      // state truthfully, and we always update the repo file when needed.
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
        if (path === '/repo/.gitignore') return 'node_modules/\n'; // .worktrees absent
        if (path.endsWith('package.json')) return VALID_PACKAGE_JSON;
        return '';
      });

      const result = await callSetup({
        repoRoot: '/repo', taskId: 'T-004', taskName: 'a',
      });

      expect(result.success).toBe(true);
      const data = result.data as { report: string };
      // Even if a global ignore would have matched, the repo file is
      // missing — function must add and report 'added' truthfully.
      expect(data.report).toMatch(/added/i);
      expect(appendFileSync).toHaveBeenCalledWith('/repo/.gitignore', '.worktrees/\n');
      // No git check-ignore call — function works directly off the repo file.
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

      expect(result.success).toBe(true); // overall flow succeeds at I/O level
      const data = result.data as { passed: boolean; report: string };
      expect(data.report).toMatch(/FAIL.*\.worktrees is gitignored.*EACCES/i);
      expect(data.passed).toBe(false);
    });
  });

  // ─── DR-3 (T-09, #1204): branch-override resolution ───────────────────────
  //
  // Resolution priority: args.branch > workflow.tasks[id=<taskId>].branch >
  // legacy `feature/<id>-<name>` default. The "Branch created" check report
  // includes a source-attribution suffix indicating which path was taken
  // (`from arg`, `from workflow state`, or `default`).

  describe('branch-override resolution (DR-3)', () => {
    function setupHappyPathMocks() {
      vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
        const cmdStr = String(cmd).replace(/\.cmd$/, '');
        const argsArr = args as string[];
        if (cmdStr === 'git' && argsArr.includes('show-ref')) {
          // Branch does not exist — handler proceeds to create it.
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
        // Worktree dir does NOT exist initially — `git worktree add` is invoked.
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
      // The VCS owner was asked to create the PLANNED branch, not the legacy
      // default — asserted on the provisioner request now that branch creation
      // routes through the owner instead of a direct `git branch` execFileSync.
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

  // ── base-branch resolution (#1509/#1501 managed-path parity) ────────────
  //
  // The Exarchos-managed (non-native) worktree path must base subagent
  // worktrees on the INTEGRATION TIP, not a stale `main`. Resolution mirrors
  // prepare_delegation's integration-branch derivation:
  //   args.baseBranch > synthesis.integrationBranch > current HEAD > 'main'
  // The current-HEAD fallback closes the silent `?? 'main'` footgun: the
  // orchestrator runs setup_worktree from the integration checkout, so HEAD
  // *is* the integration tip when nothing more specific is supplied.

  describe('base-branch resolution (#1509/#1501)', () => {
    // Returns `currentBranch` for `git rev-parse --abbrev-ref HEAD`; lets each
    // test stand the repo on an arbitrary integration branch.
    function setupBaseResolutionMocks(currentBranch: string) {
      vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
        const cmdStr = String(cmd).replace(/\.cmd$/, '');
        const argsArr = args as string[];
        if (cmdStr === 'git' && argsArr.includes('show-ref')) {
          const error = new Error('not found') as Error & { status: number };
          error.status = 1;
          throw error; // branch absent → handler creates it
        }
        if (cmdStr === 'git' && argsArr.includes('rev-parse') && argsArr.includes('--abbrev-ref')) {
          return currentBranch;
        }
        if (cmdStr === 'git' && argsArr.includes('rev-parse')) return ''; // bare rev-parse HEAD / --git-dir
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

    // The base ref the handler asked the VCS owner to branch from. Base
    // resolution now feeds the provisioner request instead of a direct
    // `git branch <name> <base>` execFileSync, so we inspect the request.
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

    it('BaseBranch_CurrentHead_WhenNoArgOrSynthesis', async () => {
      // The regression guard: a stacked integration branch must NOT silently
      // base on main. With no arg and no synthesis state, HEAD is the tip.
      setupBaseResolutionMocks('feat/stacked');
      await callSetup(
        { repoRoot: '/repo', taskId: 'T1', taskName: 'x', skipTests: true },
        undefined,
      );
      expect(createdBranchBase()).toBe('feat/stacked');
      expect(createdBranchBase()).not.toBe('main');
    });

    it('BaseBranch_FallsBackToMain_WhenHeadUnresolvable', async () => {
      // Detached HEAD with no resolvable ref/SHA → safe legacy default.
      setupBaseResolutionMocks('HEAD');
      await callSetup(
        { repoRoot: '/repo', taskId: 'T1', taskName: 'x', skipTests: true },
        undefined,
      );
      expect(createdBranchBase()).toBe('main');
    });
  });

  // ── DR-1: burst-creation stagger at the worktree-creation seam ───────────
  //
  // The DR-8 kernel's `burstStagger` is wired into the creation seam so that a
  // delegate wave's parallel worktree creations don't thundering-herd the git
  // index. A creation is a "burst" when the enclosing workflow delegates more
  // than one task (the composite adapter already materializes that `tasks`
  // list). Both the sleep and jitter seams are injected so the jitter window is
  // asserted without wall-clock waits.

  describe('DR-1 burst-creation stagger', () => {
    // Happy-path mocks so `runSetupWorktreeSteps` completes without spawning
    // real subprocesses or throwing — the stagger runs *before* these steps, so
    // their pass/fail is irrelevant; only the recorded delays matter.
    function setupCreationMocks() {
      vi.mocked(execFileSync).mockImplementation((cmd: unknown, args: unknown) => {
        const cmdStr = String(cmd).replace(/\.cmd$/, '');
        const argsArr = args as string[];
        if (cmdStr === 'git' && argsArr.includes('show-ref')) {
          const error = new Error('not found') as Error & { status: number };
          error.status = 1;
          throw error; // branch absent → handler creates it
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

    it('SetupWorktree_BurstCreation_StaggersWithinConfiguredJitterWindow', async () => {
      setupCreationMocks();

      // Injected sleep seam records each stagger delay applied.
      const recorded: number[] = [];
      const sleep = (ms: number): Promise<void> => {
        recorded.push(ms);
        return Promise.resolve();
      };

      // Sweep the signed-jitter source across the full band [-1, 1] so the
      // recorded delays exercise both edges of the configured window.
      const jitterSweep = [-1, -0.5, 0, 0.5, 1];
      let jitterCall = 0;
      const jitter = (): number => jitterSweep[jitterCall++ % jitterSweep.length];

      // A burst = a multi-task delegation. Each task's creation is one
      // setup_worktree call racing for the git index; run the whole burst.
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

      // Every creation in the burst staggered exactly once…
      expect(recorded.length).toBe(workflowState.tasks.length);
      // …and every stagger fell inside the configured jitter window.
      for (const delay of recorded) {
        expect(delay).toBeGreaterThanOrEqual(BURST_STAGGER_MIN_MS);
        expect(delay).toBeLessThanOrEqual(BURST_STAGGER_MAX_MS);
      }
      // The swept jitter maps to distinct in-band delays, hitting both bounds —
      // proving both the jitter source and the window are actually wired.
      expect(recorded).toEqual([
        BURST_STAGGER_MIN_MS, // jitter -1  → band floor
        200,
        300,
        400,
        BURST_STAGGER_MAX_MS, // jitter +1  → band ceiling
      ]);
    });

    it('SetupWorktree_SingleCreation_NoStaggerDelay', async () => {
      setupCreationMocks();

      const recorded: number[] = [];
      const sleep = (ms: number): Promise<void> => {
        recorded.push(ms);
        return Promise.resolve();
      };
      // Real jitter must never be consulted — assert it stays untouched too.
      const jitter = vi.fn<[], number>(() => 0);

      // A single-task workflow is not a burst → no stagger.
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

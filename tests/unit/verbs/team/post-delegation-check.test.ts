// ─── Post-Delegation Check Handler Tests ────────────────────────────────────

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';

// ─── Mock fs and child_process ──────────────────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

// ─── Import after mocks ────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handlePostDelegationCheck } from '../../../../src/verbs/team/post-delegation-check.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);

// ─── Test Helpers ───────────────────────────────────────────────────────────

function makeState(tasks: Record<string, unknown>[]) {
  return JSON.stringify({ tasks });
}

function makeCompleteTask(id: string, worktree?: string) {
  return { id, status: 'complete', branch: `branch-${id}`, ...(worktree ? { worktree } : {}) };
}

function makeIncompleteTask(id: string, status = 'in-progress') {
  return { id, status, branch: `branch-${id}` };
}

// The worktree test command is resolved from the worktree's own toolchain, so
// a fixture worktree has to look like a repository the resolver recognizes.
const NODE_MANIFEST = JSON.stringify({ scripts: { 'test:run': 'vitest run' } });

/** `readFileSync` answering the manifest for package.json and the state otherwise. */
function stateAndManifest(stateJson: string): (p: unknown) => string {
  return (p: unknown) => (String(p).endsWith('package.json') ? NODE_MANIFEST : stateJson);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handlePostDelegationCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Test 1: All tasks complete, tests pass → passed: true ────────────

  it('allTasksComplete_testsPass_returnsPassed', async () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-1'),
      makeCompleteTask('task-2', 'wt-2'),
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      // Strip a leading Windows drive (`C:`) so these posix mock keys match
      // the handler's toPosix(resolve(...)) output, which prefixes the drive
      // on Windows (#1620).
      const path = String(p).replace(/^[A-Za-z]:/, '');
      if (path === '/tmp/state.json') return true;
      if (path === '/repo/wt-1') return true;
      if (path === '/repo/wt-2') return true;
      if (path === '/repo/wt-1/package.json') return true;
      if (path === '/repo/wt-2/package.json') return true;
      return false;
    });
    mockReadFileSync.mockImplementation(stateAndManifest(stateJson));
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string; checks: { pass: number; fail: number; skip: number } };
    expect(data.passed).toBe(true);
    expect(data.checks.fail).toBe(0);
    expect(data.report).toContain('PASS');
  });

  // ─── Test 1b: the command comes from the resolver ─────────────────────

  it('PostDelegation_UsesResolvedCommand', async () => {
    const stateJson = makeState([makeCompleteTask('task-1', 'wt-1')]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p).replace(/^[A-Za-z]:/, '');
      return (
        path === '/tmp/state.json' ||
        path === '/repo/wt-1' ||
        path === '/repo/wt-1/package.json'
      );
    });
    mockReadFileSync.mockImplementation(stateAndManifest(stateJson));
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const [program, argv, options] = mockExecFileSync.mock.calls[0] as [
      string,
      readonly string[],
      { cwd?: string },
    ];
    expect(program).toBe('npm');
    expect(argv).toEqual(['run', 'test:run']);
    expect(String(options.cwd).replace(/^[A-Za-z]:/, '')).toBe('/repo/wt-1');
  });

  // ─── Test 1c: a worktree with no resolvable runtime ───────────────────

  it('NonNodeWorktree_IsIndeterminate_NotSkip', async () => {
    // The worktree exists but nothing in it names a test runtime. The gate
    // used to record a green SKIP here — a blocking gate reporting verified
    // when it had verified nothing.
    const stateJson = makeState([makeCompleteTask('task-1', 'wt-1')]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p).replace(/^[A-Za-z]:/, '');
      return path === '/tmp/state.json' || path === '/repo/wt-1';
    });
    mockReadFileSync.mockReturnValue(stateJson);

    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      passed: boolean;
      report: string;
      checks: { pass: number; fail: number; skip: number; indeterminate: number };
    };
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(data.checks.indeterminate).toBe(1);
    // Unconcluded, and counted apart from both a waived SKIP and a real FAIL.
    expect(data.checks.skip).toBe(0);
    expect(data.checks.fail).toBe(0);
    expect(data.passed).toBe(false);
    expect(data.report).toContain('INDETERMINATE');
  });

  // ─── Test 1d: a runner that never started is not a failing worktree ───

  it('PostDelegation_RunnerNeverStarts_IsIndeterminate_NotFail', async () => {
    const stateJson = makeState([makeCompleteTask('task-1', 'wt-1')]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p).replace(/^[A-Za-z]:/, '');
      return (
        path === '/tmp/state.json' ||
        path === '/repo/wt-1' ||
        path === '/repo/wt-1/package.json'
      );
    });
    mockReadFileSync.mockImplementation(stateAndManifest(stateJson));
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' });
    });

    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    const data = result.data as {
      passed: boolean;
      report: string;
      checks: { pass: number; fail: number; skip: number; indeterminate: number };
    };
    expect(data.checks.indeterminate).toBe(1);
    expect(data.checks.fail).toBe(0);
    expect(data.passed).toBe(false);
    expect(data.report).toContain('ENOENT');
  });

  it('PostDelegation_RunnerNonZeroExit_IsStillAFailure', async () => {
    // Discriminating twin: a process that RAN and exited non-zero is a real
    // finding, and must not be softened into an unmeasured leg.
    const stateJson = makeState([makeCompleteTask('task-1', 'wt-1')]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p).replace(/^[A-Za-z]:/, '');
      return (
        path === '/tmp/state.json' ||
        path === '/repo/wt-1' ||
        path === '/repo/wt-1/package.json'
      );
    });
    mockReadFileSync.mockImplementation(stateAndManifest(stateJson));
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('Command failed'), { status: 1 });
    });

    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    const data = result.data as {
      passed: boolean;
      checks: { pass: number; fail: number; skip: number; indeterminate: number };
    };
    expect(data.checks.fail).toBe(1);
    expect(data.checks.indeterminate).toBe(0);
    expect(data.passed).toBe(false);
  });

  // ─── Test 2: State file not found → error ────────────────────────────

  it('stateFileNotFound_returnsError', async () => {
    // Arrange
    mockExistsSync.mockReturnValue(false);

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/missing.json',
      repoRoot: '/repo',
    });

    // Assert — with no featureId/eventStore fallback, returns NO_STATE_SOURCE
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_STATE_SOURCE');
  });

  // ─── Test 3: Invalid JSON → error ────────────────────────────────────

  it('invalidJson_returnsError', async () => {
    // Arrange
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/bad.json',
      repoRoot: '/repo',
    });

    // Assert — invalid JSON falls through to NO_STATE_SOURCE with no event store fallback
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_STATE_SOURCE');
  });

  // ─── Test 4: No tasks → passed: false ─────────────────────────────────

  it('noTasks_returnsNotPassed', async () => {
    // Arrange
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeState([]));

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('FAIL');
  });

  // ─── Test 5: Incomplete tasks → passed: false with list ───────────────

  it('incompleteTasks_returnsNotPassedWithList', async () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1'),
      makeIncompleteTask('task-2', 'in-progress'),
      makeIncompleteTask('task-3', 'blocked'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('task-2');
    expect(data.report).toContain('task-3');
  });

  // ─── Test 6: skipTests=true → skips worktree test execution ───────────

  it('skipTests_skipsWorktreeTestExecution', async () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-1'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
      skipTests: true,
    });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { skip: number } };
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThan(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  // ─── Test 7: Worktree directory not found → fail for that worktree ────

  it('worktreeDirNotFound_failsForThatWorktree', async () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-missing'),
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      // Strip a leading Windows drive (`C:`) so these posix mock keys match
      // the handler's toPosix(resolve(...)) output, which prefixes the drive
      // on Windows (#1620).
      const path = String(p).replace(/^[A-Za-z]:/, '');
      if (path === '/tmp/state.json') return true;
      // worktree dir does not exist
      return false;
    });
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('wt-missing');
  });

  // ─── Test 8: Tasks missing id/status → consistency fail ───────────────

  it('tasksMissingIdOrStatus_consistencyFail', async () => {
    // Arrange
    const stateJson = makeState([
      { id: 'task-1', status: 'complete' },
      { status: 'complete' }, // missing id
      { id: 'task-3' },       // missing status
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('consistency');
  });

  // ─── Test 9: Report includes task status table ────────────────────────

  it('report_includesTaskStatusTable', async () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1'),
      makeIncompleteTask('task-2', 'in-progress'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    // Assert
    const data = result.data as { report: string };
    expect(data.report).toContain('| Task | Status | Branch |');
    expect(data.report).toContain('task-1');
    expect(data.report).toContain('task-2');
  });
});

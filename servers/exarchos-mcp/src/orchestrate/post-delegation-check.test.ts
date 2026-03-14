// ─── Post-Delegation Check Handler Tests ────────────────────────────────────

import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';

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
import { handlePostDelegationCheck } from './post-delegation-check.js';

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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handlePostDelegationCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Test 1: All tasks complete, tests pass → passed: true ────────────

  it('allTasksComplete_testsPass_returnsPassed', () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-1'),
      makeCompleteTask('task-2', 'wt-2'),
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/tmp/state.json') return true;
      if (path === '/repo/wt-1') return true;
      if (path === '/repo/wt-2') return true;
      if (path === '/repo/wt-1/package.json') return true;
      if (path === '/repo/wt-2/package.json') return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(stateJson);
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // Act
    const result = handlePostDelegationCheck({
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

  // ─── Test 2: State file not found → error ────────────────────────────

  it('stateFileNotFound_returnsError', () => {
    // Arrange
    mockExistsSync.mockReturnValue(false);

    // Act
    const result = handlePostDelegationCheck({
      stateFile: '/tmp/missing.json',
      repoRoot: '/repo',
    });

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_FILE_NOT_FOUND');
    expect(result.error?.message).toContain('/tmp/missing.json');
  });

  // ─── Test 3: Invalid JSON → error ────────────────────────────────────

  it('invalidJson_returnsError', () => {
    // Arrange
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    // Act
    const result = handlePostDelegationCheck({
      stateFile: '/tmp/bad.json',
      repoRoot: '/repo',
    });

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_JSON');
  });

  // ─── Test 4: No tasks → passed: false ─────────────────────────────────

  it('noTasks_returnsNotPassed', () => {
    // Arrange
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeState([]));

    // Act
    const result = handlePostDelegationCheck({
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

  it('incompleteTasks_returnsNotPassedWithList', () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1'),
      makeIncompleteTask('task-2', 'in-progress'),
      makeIncompleteTask('task-3', 'blocked'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = handlePostDelegationCheck({
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

  it('skipTests_skipsWorktreeTestExecution', () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-1'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = handlePostDelegationCheck({
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

  it('worktreeDirNotFound_failsForThatWorktree', () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-missing'),
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path === '/tmp/state.json') return true;
      // worktree dir does not exist
      return false;
    });
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = handlePostDelegationCheck({
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

  it('tasksMissingIdOrStatus_consistencyFail', () => {
    // Arrange
    const stateJson = makeState([
      { id: 'task-1', status: 'complete' },
      { status: 'complete' }, // missing id
      { id: 'task-3' },       // missing status
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = handlePostDelegationCheck({
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

  it('report_includesTaskStatusTable', () => {
    // Arrange
    const stateJson = makeState([
      makeCompleteTask('task-1'),
      makeIncompleteTask('task-2', 'in-progress'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    // Act
    const result = handlePostDelegationCheck({
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

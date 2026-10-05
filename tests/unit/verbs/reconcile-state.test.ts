// Tests for `handleReconcileState`, with mocks for `node:fs` and `node:child_process`.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../../src/format.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handleReconcileState } from '../../../src/verbs/reconcile-state.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);

function makeState(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'delegate',
    tasks: [],
    worktrees: {},
    ...overrides,
  });
}

describe('handleReconcileState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AllChecksPassing_ReturnsPassed', async () => {
    const stateJson = makeState({
      tasks: [
        { id: 'task-1', branch: 'feat/task-1', status: 'complete' },
      ],
      worktrees: {},
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);
    mockExecFileSync.mockReturnValue(Buffer.from('abc123\n'));

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/test.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { pass: number; fail: number } };
    expect(data.passed).toBe(true);
    expect(data.checks.fail).toBe(0);
    expect(data.checks.pass).toBeGreaterThanOrEqual(5);
  });

  it('StateFileNotFound_ReturnsError', async () => {
    mockExistsSync.mockReturnValue(false);

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/missing.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_STATE_SOURCE');
  });

  it('InvalidJsonInStateFile_ReturnsError', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/bad.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_STATE_SOURCE');
  });

  it('InvalidPhaseForWorkflowType_ReturnsNotPassed', async () => {
    const stateJson = makeState({ phase: 'nonexistent-phase' });
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/test.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('FAIL');
    expect(data.report).toContain('nonexistent-phase');
  });

  /** `git rev-parse` resolves the first branch and fails on the second. */
  it('MissingGitBranches_ReturnsNotPassed', async () => {
    const stateJson = makeState({
      tasks: [
        { id: 'task-1', branch: 'feat/task-1', status: 'complete' },
        { id: 'task-2', branch: 'feat/task-2', status: 'complete' },
      ],
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from('abc123\n'))
      .mockImplementationOnce(() => {
        throw new Error('fatal: not a valid ref');
      });

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/test.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('feat/task-2');
  });

  /** The mocked `git worktree list --porcelain` output and the `existsSync` mock both omit `worktree-2`. */
  it('MissingWorktrees_ReturnsNotPassed', async () => {
    const stateJson = makeState({
      worktrees: {
        'wt-1': { path: '/tmp/worktree-1', status: 'active' },
        'wt-2': { path: '/tmp/worktree-2', status: 'active' },
      },
    });

    mockExistsSync.mockImplementation((p: unknown) => {
      const path = p as string;
      if (path === '/tmp/test.state.json') return true;
      if (path === '/tmp/worktree-1') return true;
      if (path === '/tmp/worktree-2') return false;
      return false;
    });
    mockReadFileSync.mockReturnValue(stateJson);
    mockExecFileSync.mockReturnValue(Buffer.from(
      'worktree /tmp/repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
      'worktree /tmp/worktree-1\nHEAD def456\nbranch refs/heads/feat/wt-1\n\n',
    ));

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/test.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('worktree-2');
  });

  it('InProgressTaskWithoutBranch_ReturnsNotPassed', async () => {
    const stateJson = makeState({
      tasks: [
        { id: 'task-1', branch: '', status: 'in-progress' },
      ],
    });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/test.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('task-1');
    expect(data.report).toContain('in-progress');
  });

  it('NoTasks_PassesBranchAndConsistencyChecks', async () => {
    const stateJson = makeState({ tasks: [] });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/test.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { pass: number; fail: number } };
    expect(data.passed).toBe(true);
    expect(data.checks.fail).toBe(0);
  });

  it('UnknownWorkflowType_FailsPhaseCheckWithError', async () => {
    const stateJson = makeState({ workflowType: 'unknown-type', phase: 'delegate' });

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);

    const result: ToolResult = await handleReconcileState({
      stateFile: '/tmp/test.state.json',
      repoRoot: '/tmp/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('unknown-type');
  });
});

// The gate runner mock calls only the provider, because these cases test the
// provider verdict. `unrunbooked-gate-evidence-dispatch.test.ts` proves the
// recorded evidence over real dispatch.

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolResult } from '../../../../src/format.js';

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
import { handlePostDelegationCheck } from '../../../../src/verbs/team/post-delegation-check.js';
import type { EventStore } from '../../../../src/events/store.js';
import { rmrf } from '../../../../tools/test-helpers/temp-dir.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);

/**
 * The gate takes its feature ID, state directory and event store from this wiring.
 * The event store is the authoritative state source, so each case feeds its tasks
 * through a store that the projection can fold.
 */
const STATE_DIR = '/tmp/test-post-delegation-check';
const FEATURE_ID = 'post-delegation-feature';

let currentStore: EventStore;

function storeFrom(stateJson: string): EventStore {
  const patch = JSON.parse(stateJson) as Record<string, unknown>;
  return {
    append: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([{ type: 'state.patched', data: { patch } }]),
  } as unknown as EventStore;
}

/** A store with nothing usable to say — the no-state-source case. */
function unavailableStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockRejectedValue(new Error('store unavailable')),
  } as unknown as EventStore;
}

function gateWiring(): { featureId: string; stateDir: string; eventStore: EventStore } {
  return { featureId: FEATURE_ID, stateDir: STATE_DIR, eventStore: currentStore };
}

/** A node project the toolchain resolver resolves to its `test:run` script. */
const NODE_PACKAGE_JSON = JSON.stringify({ scripts: { 'test:run': 'vitest run' } });

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const fixtureDirs: string[] = [];

/** A real temporary repository, removed after each test. */
function fixtureRepo(): string {
  const dir = realFs.mkdtempSync(join(tmpdir(), 'post-delegation-'));
  fixtureDirs.push(dir);
  return dir;
}

/** Route the mocked `existsSync` and `readFileSync` to the real file system. */
function useRealFs(): void {
  mockExistsSync.mockImplementation(realFs.existsSync);
  mockReadFileSync.mockImplementation(realFs.readFileSync);
}

function makeState(tasks: Record<string, unknown>[]) {
  return JSON.stringify({ tasks });
}

function makeCompleteTask(id: string, worktree?: string) {
  return { id, status: 'complete', branch: `branch-${id}`, ...(worktree ? { worktree } : {}) };
}

function makeIncompleteTask(id: string, status = 'in-progress') {
  return { id, status, branch: `branch-${id}` };
}

describe('handlePostDelegationCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentStore = unavailableStore();
  });

  afterEach(() => {
    for (const dir of fixtureDirs.splice(0)) rmrf(dir);
  });

  /** The `existsSync` mock strips a leading Windows drive, so its posix keys match the resolved paths on Windows. */
  it('allTasksComplete_testsPass_returnsPassed', async () => {
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-1'),
      makeCompleteTask('task-2', 'wt-2'),
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p).replace(/^[A-Za-z]:/, '');
      if (path === '/tmp/state.json') return true;
      if (path === '/repo/wt-1') return true;
      if (path === '/repo/wt-2') return true;
      if (path === '/repo/wt-1/package.json') return true;
      if (path === '/repo/wt-2/package.json') return true;
      return false;
    });
    mockReadFileSync.mockImplementation(((p: unknown) =>
      String(p).endsWith('package.json') ? NODE_PACKAGE_JSON : stateJson) as typeof readFileSync);
    currentStore = storeFrom(stateJson);
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string; checks: { pass: number; fail: number; skip: number } };
    expect(data.passed).toBe(true);
    expect(data.checks.fail).toBe(0);
    expect(data.report).toContain('PASS');
  });

  /** A worktree without a package.json still runs its tests. A Go module resolves `go test ./...`. */
  it('worktreeGoModule_runsTheResolvedTestCommand', async () => {
    const repoRoot = fixtureRepo();
    realFs.mkdirSync(join(repoRoot, 'wt-go'));
    realFs.writeFileSync(join(repoRoot, 'wt-go', 'go.mod'), 'module example.com/fixture\n');
    useRealFs();
    currentStore = storeFrom(makeState([makeCompleteTask('task-1', 'wt-go')]));
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    const result = await handlePostDelegationCheck({ ...gateWiring(), repoRoot });

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'go',
      ['test', './...'],
      expect.objectContaining({ cwd: expect.stringMatching(/wt-go$/) }),
    );
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(true);
    expect(data.report).toContain('Worktree tests: wt-go (go test ./...)');
  });

  /** A worktree with nothing to resolve fails the check. It is not skipped. */
  it('worktreeWithoutResolvableTestCommand_failsTheCheck', async () => {
    const repoRoot = fixtureRepo();
    realFs.mkdirSync(join(repoRoot, 'wt-empty'));
    useRealFs();
    currentStore = storeFrom(makeState([makeCompleteTask('task-1', 'wt-empty')]));

    const result = await handlePostDelegationCheck({ ...gateWiring(), repoRoot });

    const data = result.data as { passed: boolean; report: string; checks: { skip: number } };
    expect(data.passed).toBe(false);
    expect(data.checks.skip).toBe(0);
    expect(data.report).toMatch(/FAIL\*\*: Worktree tests: wt-empty — No test command resolved: No project markers detected/);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  /**
   * The event store is the authoritative state source. A store that cannot answer
   * gives `EVENT_STORE_ERROR`, and the missing state file does not change the result.
   */
  it('stateSourceUnreadable_returnsError', async () => {
    mockExistsSync.mockReturnValue(false);
    currentStore = unavailableStore();

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/missing.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_STORE_ERROR');
  });

  /** Without an event store, the gate refuses with `MISWIRED_CONTEXT` before it reads the state file. */
  it('noStateSource_returnsNoStateSource', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      eventStore: undefined as unknown as EventStore,
      stateFile: '/tmp/bad.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISWIRED_CONTEXT');
  });

  it('noTasks_returnsNotPassed', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeState([]));
    currentStore = storeFrom(makeState([]));

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('FAIL');
  });

  it('incompleteTasks_returnsNotPassedWithList', async () => {
    const stateJson = makeState([
      makeCompleteTask('task-1'),
      makeIncompleteTask('task-2', 'in-progress'),
      makeIncompleteTask('task-3', 'blocked'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);
    currentStore = storeFrom(stateJson);

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('task-2');
    expect(data.report).toContain('task-3');
  });

  it('skipTests_skipsWorktreeTestExecution', async () => {
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-1'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);
    currentStore = storeFrom(stateJson);

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
      skipTests: true,
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; checks: { skip: number } };
    expect(data.passed).toBe(true);
    expect(data.checks.skip).toBeGreaterThan(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  /** The `existsSync` mock strips a leading Windows drive, so its posix keys match the resolved paths on Windows. */
  it('worktreeDirNotFound_failsForThatWorktree', async () => {
    const stateJson = makeState([
      makeCompleteTask('task-1', 'wt-missing'),
    ]);
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p).replace(/^[A-Za-z]:/, '');
      if (path === '/tmp/state.json') return true;
      return false;
    });
    mockReadFileSync.mockReturnValue(stateJson);
    currentStore = storeFrom(stateJson);

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('wt-missing');
  });

  it('tasksMissingIdOrStatus_consistencyFail', async () => {
    const stateJson = makeState([
      { id: 'task-1', status: 'complete' },
      { status: 'complete' },
      { id: 'task-3' },
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);
    currentStore = storeFrom(stateJson);

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    expect(result.success).toBe(true);
    const data = result.data as { passed: boolean; report: string };
    expect(data.passed).toBe(false);
    expect(data.report).toContain('consistency');
  });

  it('report_includesTaskStatusTable', async () => {
    const stateJson = makeState([
      makeCompleteTask('task-1'),
      makeIncompleteTask('task-2', 'in-progress'),
    ]);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(stateJson);
    currentStore = storeFrom(stateJson);

    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/state.json',
      repoRoot: '/repo',
    });

    const data = result.data as { report: string };
    expect(data.report).toContain('| Task | Status | Branch |');
    expect(data.report).toContain('task-1');
    expect(data.report).toContain('task-2');
  });
});

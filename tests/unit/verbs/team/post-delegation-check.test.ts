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

// The gate now records durable evidence through the shared phase-gate runner
// before any success carrier escapes. These cases are about the PROVIDER's
// verdict, so the runner is stubbed down to its provider call — the same seam
// every other migrated gate's unit test stubs. The evidence a caller actually
// gets is proven over real dispatch in
// `unrunbooked-gate-evidence-dispatch.test.ts`.
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

// ─── Import after mocks ────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { handlePostDelegationCheck } from '../../../../src/verbs/team/post-delegation-check.js';
import type { EventStore } from '../../../../src/events/store.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockExecFileSync = vi.mocked(execFileSync);

// ─── Dispatch wiring the gate needs to record its declared evidence ─────────
//
// The gate now names the stream its durable evidence records against, and takes
// the event store and state directory from the dispatch context rather than the
// caller. The event store is also the authoritative state source (`.state.json`
// is a derived stamp), so each case feeds its tasks through a store the
// projection can fold rather than through the file mock alone.
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
    currentStore = unavailableStore();
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
    mockReadFileSync.mockReturnValue(stateJson);
    currentStore = storeFrom(stateJson);
    mockExecFileSync.mockReturnValue(Buffer.from(''));

    // Act
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
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

  // ─── Test 2: no usable state source → error ──────────────────────────
  //
  // The event store is the authoritative state source and the `.state.json` a
  // derived stamp, so an absent or corrupt file no longer decides the answer on
  // its own — a store that cannot answer does. Both cases are refusals, and the
  // refusal names which source failed.

  it('stateSourceUnreadable_returnsError', async () => {
    // Arrange — the file is gone AND the store cannot answer.
    mockExistsSync.mockReturnValue(false);
    currentStore = unavailableStore();

    // Act
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      stateFile: '/tmp/missing.json',
      repoRoot: '/repo',
    });

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_STORE_ERROR');
  });

  // ─── Test 3: no state source at all → error ──────────────────────────

  it('noStateSource_returnsNoStateSource', async () => {
    // Arrange — neither a readable file nor an event store.
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    // Act — the wiring's store is bypassed for the resolution leg only, which
    // is the shape a legacy file-only caller had.
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
      eventStore: undefined as unknown as EventStore,
      stateFile: '/tmp/bad.json',
      repoRoot: '/repo',
    });

    // Assert — the gate refuses rather than running against nothing.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISWIRED_CONTEXT');
  });

  // ─── Test 4: No tasks → passed: false ─────────────────────────────────

  it('noTasks_returnsNotPassed', async () => {
    // Arrange
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeState([]));
    currentStore = storeFrom(makeState([]));

    // Act
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
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
    currentStore = storeFrom(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
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
    currentStore = storeFrom(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
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
    currentStore = storeFrom(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
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
    currentStore = storeFrom(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
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
    currentStore = storeFrom(stateJson);

    // Act
    const result = await handlePostDelegationCheck({
      ...gateWiring(),
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

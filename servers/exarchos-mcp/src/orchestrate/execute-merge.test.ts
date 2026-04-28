// ─── handleExecuteMerge tests (T15) ────────────────────────────────────────
//
// T15 — happy path. Wraps the pure `executeMerge` (T08+T09+T10) with a
// VCS provider adapter and event-store emission. Asserts:
//   1. delegates to the underlying VCS merge (handleMergePr / vcs.mergePr)
//   2. emits `merge.executed` to the workflow's event stream with both the
//      mergeSha and the rollbackSha captured pre-merge
//   3. persists the `executing` intermediate state (with rollbackSha) BEFORE
//      the VCS merge call, so a crash mid-merge is recoverable
//
// T16 (next task) covers the rolled-back path; tests for that live elsewhere.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

import { handleExecuteMerge } from './execute-merge.js';

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeMockEventStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue({
      sequence: 1,
      type: 'merge.executed',
      timestamp: new Date().toISOString(),
    }),
  } as unknown as EventStore;
}

function makeMockCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: makeMockEventStore(),
    enableTelemetry: false,
    ...overrides,
  };
}

const ROLLBACK_SHA = 'b'.repeat(40);
const MERGE_SHA = 'a'.repeat(40);

// gitExec stub: `git rev-parse HEAD` returns the rollback sha.
function makeGitExec() {
  return vi.fn().mockImplementation((_repo: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  });
}

describe('handleExecuteMerge (T15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleExecuteMerge_MergeSucceeds_DelegatesToVcsMergePr', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi
      .fn()
      .mockResolvedValue({ mergeSha: MERGE_SHA });
    const persistState = vi.fn().mockResolvedValue(undefined);

    await handleExecuteMerge(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        // DI: bypass real createVcsProvider + git invocation
        vcsMerge,
        persistState,
        gitExec: makeGitExec(),
      },
      ctx,
    );

    expect(vcsMerge).toHaveBeenCalledTimes(1);
    expect(vcsMerge).toHaveBeenCalledWith({
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      strategy: 'squash',
    });
  });

  it('handleExecuteMerge_MergeSucceeds_EmitsMergeExecutedWithMergeSha', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockResolvedValue({ mergeSha: MERGE_SHA });
    const persistState = vi.fn().mockResolvedValue(undefined);

    const result = await handleExecuteMerge(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        vcsMerge,
        persistState,
        gitExec: makeGitExec(),
      },
      ctx,
    );

    expect(result.success).toBe(true);
    // Direct stream append — NOT wrapped in gate.executed.
    expect(ctx.eventStore.append).toHaveBeenCalledTimes(1);
    expect(ctx.eventStore.append).toHaveBeenCalledWith('feat-x', {
      type: 'merge.executed',
      data: {
        taskId: 'T11',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        mergeSha: MERGE_SHA,
        rollbackSha: ROLLBACK_SHA,
      },
    });
  });

  it('handleExecuteMerge_BeforeRefMutation_RollbackShaPersistedToWorkflowState', async () => {
    const ctx = makeMockCtx();
    const callOrder: string[] = [];

    const persistState = vi.fn().mockImplementation(async (state: unknown) => {
      callOrder.push(`persistState:${JSON.stringify(state)}`);
    });
    const vcsMerge = vi.fn().mockImplementation(async () => {
      callOrder.push('vcsMerge');
      return { mergeSha: MERGE_SHA };
    });

    await handleExecuteMerge(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        vcsMerge,
        persistState,
        gitExec: makeGitExec(),
      },
      ctx,
    );

    // Ordering: persistState({phase:'executing', rollbackSha}) BEFORE vcsMerge.
    expect(callOrder.length).toBeGreaterThanOrEqual(2);
    expect(callOrder[0]).toBe(
      `persistState:${JSON.stringify({
        phase: 'executing',
        rollbackSha: ROLLBACK_SHA,
      })}`,
    );
    expect(callOrder.indexOf('vcsMerge')).toBeGreaterThan(0);
    expect(persistState).toHaveBeenCalledWith({
      phase: 'executing',
      rollbackSha: ROLLBACK_SHA,
    });
  });
});

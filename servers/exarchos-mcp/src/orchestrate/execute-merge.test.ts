// ─── handleExecuteMerge tests (T15 + T16) ───────────────────────────────────
//
// T15 — happy path. Wraps the pure `executeMerge` (T08+T09+T10) with a
// VCS provider adapter and event-store emission. Asserts:
//   1. delegates to the underlying VCS merge (handleMergePr / vcs.mergePr)
//   2. emits `merge.executed` to the workflow's event stream with both the
//      mergeSha and the rollbackSha captured pre-merge
//   3. persists the `executing` intermediate state (with rollbackSha) BEFORE
//      the VCS merge call, so a crash mid-merge is recoverable
//
// T16 — rollback path. When the VCS merge rejects, the pure executor
// returns `phase: 'rolled-back'` after running `git reset --hard <rollbackSha>`.
// The handler must:
//   1. emit `merge.rollback` to the workflow's event stream carrying the
//      categorized reason ('merge-failed' | 'verification-failed' | 'timeout')
//   2. invoke `git reset --hard <rollbackSha>` so HEAD matches the captured sha
//   3. return a structured `ToolResult` failure with code `MERGE_ROLLED_BACK`

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

describe('handleExecuteMerge rollback (T16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleExecuteMerge_PureExecuteMergeRollsBack_EmitsMergeRollbackWithReason', async () => {
    const ctx = makeMockCtx();
    // vcsMerge rejects → categorized as 'merge-failed' (default bucket).
    const vcsMerge = vi.fn().mockRejectedValue(new Error('merge conflict'));
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

    expect(result.success).toBe(false);
    // Direct stream append to the merge.rollback type — NOT wrapped in
    // gate.executed and NOT a merge.executed event.
    expect(ctx.eventStore.append).toHaveBeenCalledTimes(1);
    expect(ctx.eventStore.append).toHaveBeenCalledWith('feat-x', {
      type: 'merge.rollback',
      data: {
        taskId: 'T11',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        rollbackSha: ROLLBACK_SHA,
        reason: 'merge-failed',
      },
    });
  });

  it('handleExecuteMerge_AfterRollback_HeadMatchesRecordedSha', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockRejectedValue(new Error('merge conflict'));
    const persistState = vi.fn().mockResolvedValue(undefined);

    // Track the gitExec calls so we can assert that `git reset --hard <sha>`
    // was invoked with the recorded rollback sha after the failure.
    const gitCalls: ReadonlyArray<string>[] = [];
    const gitExec = vi.fn().mockImplementation(
      (_repo: string, args: readonly string[]) => {
        gitCalls.push([...args]);
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
        }
        // git reset --hard <sha>
        return { stdout: '', exitCode: 0 };
      },
    );

    await handleExecuteMerge(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        vcsMerge,
        persistState,
        gitExec,
      },
      ctx,
    );

    // The pure executor invokes `git reset --hard <rollbackSha>` on failure.
    const resetCall = gitCalls.find(
      (a) => a[0] === 'reset' && a[1] === '--hard',
    );
    expect(resetCall).toBeDefined();
    expect(resetCall![2]).toBe(ROLLBACK_SHA);
  });

  it('handleExecuteMerge_RollbackPath_ReturnsToolResultFailureWithStructuredError', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockRejectedValue(new Error('verification check failed'));
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

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_ROLLED_BACK');
    expect(typeof result.error?.message).toBe('string');
    expect(result.error?.message.length ?? 0).toBeGreaterThan(0);
    // The handler also surfaces `data` so the caller can introspect.
    expect(result.data).toMatchObject({
      phase: 'rolled-back',
      rollbackSha: ROLLBACK_SHA,
      reason: 'verification-failed',
    });
  });
});

// ─── T29: Executor's persistState retries on VersionConflictError ─────────
//
// `handleExecuteMerge`'s default `persistState` writes to disk via
// `writeStateFile`, which throws `VersionConflictError` when a concurrent
// writer raced. T14 added the retry loop only in the orchestrator; T29
// extracts it to a shared module and applies it here so the executor's
// intermediate `executing` write + terminal `completed`/`rolled-back`
// writes are equally race-tolerant.

import { VersionConflictError } from '../workflow/state-store.js';

describe('handleExecuteMerge default persistState retries on VersionConflictError (T29)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleExecuteMerge_DefaultPersistState_VersionConflictThenSucceeds_RetriesAndCompletes', async () => {
    // We exercise the retry by injecting a `persistState` that simulates a
    // VersionConflictError on the first 'executing' write, then succeeds
    // on the retry. The handler must NOT bubble the error out — the merge
    // should complete normally.
    let executingAttempt = 0;
    const persistState = vi.fn().mockImplementation(async (state: { phase: string }) => {
      if (state.phase === 'executing') {
        executingAttempt += 1;
        if (executingAttempt === 1) {
          throw new VersionConflictError('simulated CAS race');
        }
      }
    });
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockResolvedValue({ mergeSha: MERGE_SHA });

    // Wrap the injected persistState in the same retry helper the handler
    // uses internally — i.e. assert the handler exposes/honors the retry
    // contract for caller-injected hooks too.
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
    // 1st attempt threw, 2nd succeeded for executing; then 1 terminal write.
    expect(executingAttempt).toBe(2);
    // Handler called persistState 3 times: executing(retry-1)=throw,
    // executing(retry-2)=success, completed=success.
    expect(persistState).toHaveBeenCalledTimes(3);
  });

  it('handleExecuteMerge_DefaultPersistState_VersionConflictExhausted_BubblesErrorAsToolResult', async () => {
    // Persistent VersionConflictError → handler exhausts retries and
    // returns a structured failure (not a thrown exception).
    const persistState = vi.fn().mockImplementation(async () => {
      throw new VersionConflictError('persistent CAS race');
    });
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockResolvedValue({ mergeSha: MERGE_SHA });

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

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_CONFLICT');
    // 3 retries × 1 (executing only — vcsMerge never runs after exhaustion).
    expect(persistState).toHaveBeenCalledTimes(3);
  });
});

// ─── T27: handleExecuteMerge persists terminal phase ──────────────────────
//
// The pure executor (T09) writes the intermediate `phase: 'executing'` shape
// before invoking vcsMerge. After T27, the handler is responsible for the
// terminal-phase write so disk state always reflects the actual outcome:
//   • completed  → persist {phase, rollbackSha, mergeSha}
//   • rolled-back → persist {phase, rollbackSha, reason}
// Without this, a successful merge or rollback leaves disk state at
// 'executing' indefinitely, breaking HSM exit guards and resume semantics.

describe('handleExecuteMerge terminal-phase persistence (T27)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleExecuteMerge_OnCompleted_PersistsCompletedPhaseWithMergeSha', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockResolvedValue({ mergeSha: MERGE_SHA });
    const persistState = vi.fn().mockResolvedValue(undefined);

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

    // Two persistState calls now: executing (T09) → completed (T27).
    expect(persistState).toHaveBeenCalledTimes(2);
    expect(persistState).toHaveBeenNthCalledWith(2, {
      phase: 'completed',
      rollbackSha: ROLLBACK_SHA,
      mergeSha: MERGE_SHA,
    });
  });

  it('handleExecuteMerge_OnRolledBack_PersistsRolledBackPhaseWithReason', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockRejectedValue(new Error('merge conflict'));
    const persistState = vi.fn().mockResolvedValue(undefined);

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

    expect(persistState).toHaveBeenCalledTimes(2);
    expect(persistState).toHaveBeenNthCalledWith(2, {
      phase: 'rolled-back',
      rollbackSha: ROLLBACK_SHA,
      reason: 'merge-failed',
    });
  });

  it('handleExecuteMerge_OnCompleted_PersistsBeforeMergeExecutedEmit', async () => {
    const ctx = makeMockCtx();
    const callOrder: string[] = [];

    const persistState = vi.fn().mockImplementation(async (state: unknown) => {
      const phase = (state as { phase: string }).phase;
      callOrder.push(`persist:${phase}`);
    });
    const vcsMerge = vi.fn().mockImplementation(async () => {
      callOrder.push('vcsMerge');
      return { mergeSha: MERGE_SHA };
    });
    const eventStore = makeMockEventStore();
    (eventStore.append as ReturnType<typeof vi.fn>).mockImplementation(
      async (_stream: string, event: { type: string }) => {
        callOrder.push(`event:${event.type}`);
        return { sequence: 1, type: event.type, timestamp: '' };
      },
    );

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
      { ...ctx, eventStore },
    );

    // Order: persist(executing) → vcsMerge → persist(completed) → event(merge.executed)
    // Persisting BEFORE the event means observers reading state at event-emit
    // time see the right phase.
    expect(callOrder).toEqual([
      'persist:executing',
      'vcsMerge',
      'persist:completed',
      'event:merge.executed',
    ]);
  });

  it('handleExecuteMerge_OnRolledBack_PersistsBeforeMergeRollbackEmit', async () => {
    const ctx = makeMockCtx();
    const callOrder: string[] = [];

    const persistState = vi.fn().mockImplementation(async (state: unknown) => {
      const phase = (state as { phase: string }).phase;
      callOrder.push(`persist:${phase}`);
    });
    const vcsMerge = vi.fn().mockImplementation(async () => {
      callOrder.push('vcsMerge');
      throw new Error('merge conflict');
    });
    const eventStore = makeMockEventStore();
    (eventStore.append as ReturnType<typeof vi.fn>).mockImplementation(
      async (_stream: string, event: { type: string }) => {
        callOrder.push(`event:${event.type}`);
        return { sequence: 1, type: event.type, timestamp: '' };
      },
    );

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
      { ...ctx, eventStore },
    );

    expect(callOrder).toEqual([
      'persist:executing',
      'vcsMerge',
      'persist:rolled-back',
      'event:merge.rollback',
    ]);
  });
});

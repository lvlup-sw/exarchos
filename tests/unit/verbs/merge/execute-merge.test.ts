// Tests for `handleExecuteMerge`, which wraps the pure `executeMerge` with a VCS adapter and
// event-store emission.
//
// On success, the handler persists the `executing` state with the recovery point before the VCS
// merge, then appends `merge.executed` and `merge.completed`.
//
// When the VCS merge rejects, the pure executor runs the recovery ladder: `git merge --abort`, then
// `git reset --keep <rollbackSha>`, never `--hard`. The handler appends only `merge.recovered`, with
// the categorized reason and, after a recovery that does not land cleanly, `recoveryError` and `recoveryErrorDetail`.
// It returns a `MERGE_ROLLED_BACK` failure.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';
import { SequenceConflictError } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

import { handleExecuteMerge } from '../../../../src/verbs/merge/execute-merge.js';

/**
 * A mock store. The handler calls `getAppender().decide(...)` to commit `merge.requested` before the
 * VCS merge, so the stub `decide` resolves to a committed result. `query` returns no events, so each
 * tail read gives `expectedSequence: 0`. `execute-merge.migration.test.ts` runs the real `decide` path.
 */
function makeMockEventStore(): EventStore {
  const decide = vi.fn().mockResolvedValue({
    ok: true,
    kind: 'committed',
    sequences: [1],
    eventIds: ['evt-mock-requested'],
    timestamps: [new Date().toISOString()],
  });
  return {
    append: vi.fn().mockResolvedValue({
      sequence: 1,
      type: 'merge.executed',
      timestamp: new Date().toISOString(),
    }),
    query: vi.fn().mockResolvedValue([]),
    getAppender: vi.fn().mockReturnValue({ decide }),
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

/** A `gitExec` stub. `git rev-parse HEAD` returns the rollback sha, and every other command succeeds. */
function makeGitExec() {
  return vi.fn().mockImplementation((_repo: string, args: readonly string[]) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  });
}

/**
 * The success path. Each test injects `vcsMerge`, `persistState` and `gitExec`,
 * so no real VCS provider or git command runs.
 */
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

  /**
   * The handler makes three appends. `merge.executing_started` marks liveness before the first VCS merge.
   * `merge.executed` records the side effect, and `merge.completed` is the terminal marker.
   * With a `taskId`, `instanceId` equals the task id. Each append reads the live stream tail for its
   * expected sequence. The mock tail is empty, so each value is 0.
   */
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
    expect(ctx.eventStore.append).toHaveBeenCalledTimes(3);
    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      1,
      'feat-x',
      {
        type: 'merge.executing_started',
        data: {
          taskId: 'T11',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          recoveryPointSha: ROLLBACK_SHA,
          startedAt: expect.any(String),
          instanceId: 'T11',
        },
      },
      {
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.executing_started',
      },
    );
    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      2,
      'feat-x',
      {
        type: 'merge.executed',
        data: {
          taskId: 'T11',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          strategy: 'squash',
          mergeSha: MERGE_SHA,
          rollbackSha: ROLLBACK_SHA,
          instanceId: 'T11',
        },
      },
      {
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.executed',
      },
    );
    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      3,
      'feat-x',
      {
        type: 'merge.completed',
        data: {
          taskId: 'T11',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          featureId: 'feat-x',
          mergeSha: MERGE_SHA,
        },
      },
      {
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.completed',
      },
    );
  });

  /**
   * The `merge.completed` append must read the live stream tail, not reuse the `merge.executed` sequence.
   * Another event on the shared stream moves the tail past a fixed pin. A retry gets the same cached
   * `merge.executed` sequence, so a fixed pin fails on every retry and the workflow stays in `executing`.
   * The mock tail is empty for the first two reads and at sequence 7 for the third.
   * The `merge.executed` append returns sequence 1, so a fixed pin sends 1, not 7.
   */
  it('handleExecuteMerge_MergeCompleted_CasPinsToLiveTailNotFrozenExecutedSequence', async () => {
    const ctx = makeMockCtx();
    (ctx.eventStore.query as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ sequence: 7 }]);
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

    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      3,
      'feat-x',
      expect.objectContaining({ type: 'merge.completed' }),
      expect.objectContaining({ expectedSequence: 7 }),
    );
  });

  /**
   * A `SequenceConflictError` on the `merge.completed` append must recover in place.
   * `handleMergeOrchestrate` runs the executor outside its retry boundary, so a new call runs the
   * non-idempotent `vcsMerge` again. This call won the `merge.executed` append, so it owns completion
   * and retries only the terminal marker. The first attempt fails, and the retry lands.
   */
  it('handleExecuteMerge_MergeCompleted_RetriesInPlaceOnTransientSequenceConflict', async () => {
    const ctx = makeMockCtx();
    let completedAttempts = 0;
    (ctx.eventStore.append as ReturnType<typeof vi.fn>).mockImplementation(
      async (_stream: string, event: { type: string }) => {
        if (event.type === 'merge.completed') {
          completedAttempts += 1;
          if (completedAttempts === 1) {
            throw new SequenceConflictError(0, 5);
          }
        }
        return { sequence: 1, type: event.type, timestamp: '' };
      },
    );
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
    expect(completedAttempts).toBe(2);
    expect(vcsMerge).toHaveBeenCalledTimes(1);
    expect(persistState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: 'completed' }),
    );
  });

  /** The first `persistState` call writes the `executing` phase with the recovery point, before `vcsMerge` runs. */
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

    expect(callOrder.length).toBeGreaterThanOrEqual(2);
    expect(callOrder[0]).toBe(
      `persistState:${JSON.stringify({
        phase: 'executing',
        recoveryPointSha: ROLLBACK_SHA,
      })}`,
    );
    expect(callOrder.indexOf('vcsMerge')).toBeGreaterThan(0);
    expect(persistState).toHaveBeenCalledWith({
      phase: 'executing',
      recoveryPointSha: ROLLBACK_SHA,
    });
  });
});

describe('handleExecuteMerge rollback (T16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A rejected `vcsMerge` gets the default reason `merge-failed`. The handler makes two appends:
   * the liveness event before the merge, then `merge.recovered` as the only recovery terminal.
   * `merge.recovered` has its own idempotency key and reads a fresh tail.
   */
  it('executeMerge_RecoveryPath_EmitsOnlyMergeRecovered', async () => {
    const ctx = makeMockCtx();
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
    expect(ctx.eventStore.append).toHaveBeenCalledTimes(2);
    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      1,
      'feat-x',
      {
        type: 'merge.executing_started',
        data: {
          taskId: 'T11',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          recoveryPointSha: ROLLBACK_SHA,
          startedAt: expect.any(String),
          instanceId: 'T11',
        },
      },
      {
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.executing_started',
      },
    );
    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      2,
      'feat-x',
      {
        type: 'merge.recovered',
        data: {
          taskId: 'T11',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          recoveryPointSha: ROLLBACK_SHA,
          reason: 'merge-failed',
        },
      },
      {
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.recovered',
      },
    );
  });

  /** The recovery path appends `merge.recovered` and never the retired `merge.rollback` event. */
  it('executeMerge_RecoveryPath_NoLegacyRollbackAppend', async () => {
    const ctx = makeMockCtx();
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
    const appendedTypes = (ctx.eventStore.append as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[1] as { type: string }).type,
    );
    expect(appendedTypes).toContain('merge.recovered');
    expect(appendedTypes).not.toContain('merge.rollback');
  });

  /**
   * After the failure, the pure executor runs `git merge --abort`, then `git reset --keep <rollbackSha>`.
   * It never runs the destructive `--hard` reset.
   */
  it('handleExecuteMerge_AfterRollback_HeadMatchesRecordedSha', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockRejectedValue(new Error('merge conflict'));
    const persistState = vi.fn().mockResolvedValue(undefined);

    const gitCalls: ReadonlyArray<string>[] = [];
    const gitExec = vi.fn().mockImplementation(
      (_repo: string, args: readonly string[]) => {
        gitCalls.push([...args]);
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
        }
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

    const resetCall = gitCalls.find(
      (a) => a[0] === 'reset' && a[1] === '--keep',
    );
    expect(resetCall).toBeDefined();
    expect(resetCall![2]).toBe(ROLLBACK_SHA);
    expect(gitCalls.some((a) => a[0] === 'merge' && a[1] === '--abort')).toBe(true);
    expect(gitCalls.some((a) => a[0] === 'reset' && a[1] === '--hard')).toBe(false);
  });

  /** A message that matches `verification` gives the reason `verification-failed`. The failure also carries `data`. */
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
    expect(result.data).toMatchObject({
      phase: 'rolled-back',
      recoveryPointSha: ROLLBACK_SHA,
      reason: 'verification-failed',
    });
  });

  /**
   * A refused `git reset --keep` leaves the worktree indeterminate but intact, and an operator must act.
   * `recoveryError: 'reset-keep-blocked'` and `recoveryErrorDetail` go on the `ToolResult` data and on
   * `merge.recovered`. Callers and event consumers see the signal without a read of the state file.
   * The handler makes two appends: the liveness event, then `merge.recovered`.
   */
  it('handleExecuteMerge_ResetKeepRefuses_SurfacesRecoveryErrorOnEventAndToolResult', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockRejectedValue(new Error('merge conflict'));
    const persistState = vi.fn().mockResolvedValue(undefined);

    const gitExec = vi.fn().mockImplementation(
      (_repo: string, args: readonly string[]) => {
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
        }
        if (args[0] === 'reset' && args[1] === '--keep') {
          return { stdout: 'fatal: Could not reset index file', exitCode: 1 };
        }
        return { stdout: '', exitCode: 0 };
      },
    );

    const result = await handleExecuteMerge(
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

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_ROLLED_BACK');
    expect(result.data).toMatchObject({
      phase: 'rolled-back',
      recoveryPointSha: ROLLBACK_SHA,
      reason: 'merge-failed',
    });
    expect((result.data as { recoveryError?: string }).recoveryError).toBe(
      'reset-keep-blocked',
    );
    expect((result.data as { recoveryErrorDetail?: string }).recoveryErrorDetail).toContain(
      'reset --keep',
    );

    expect(ctx.eventStore.append).toHaveBeenCalledTimes(2);
    const calls = (ctx.eventStore.append as ReturnType<typeof vi.fn>).mock.calls;
    const [, startedPayload] = calls[0];
    expect(startedPayload.type).toBe('merge.executing_started');
    const [, recoveredPayload] = calls[1];
    expect(recoveredPayload.type).toBe('merge.recovered');
    expect(recoveredPayload.data.recoveryError).toBe('reset-keep-blocked');
    expect(recoveredPayload.data.recoveryErrorDetail).toContain('reset --keep');
    const appendedTypes = calls.map((call) => (call[1] as { type: string }).type);
    expect(appendedTypes).not.toContain('merge.rollback');
  });
});

import { VersionConflictError } from '../../../../src/workflow/state-store.js';

/**
 * The handler wraps each `persistState` call in a retry on `VersionConflictError`, at most three attempts.
 * The wrapper covers the `executing` write and the terminal write, and it also retries an injected hook.
 */
describe('handleExecuteMerge default persistState retries on VersionConflictError (T29)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * The first `executing` write throws `VersionConflictError`, and the retry succeeds.
   * The merge completes: two `executing` attempts, then one `completed` write.
   */
  it('handleExecuteMerge_DefaultPersistState_VersionConflictThenSucceeds_RetriesAndCompletes', async () => {
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
    expect(executingAttempt).toBe(2);
    expect(persistState).toHaveBeenCalledTimes(3);
  });

  /**
   * A persistent `VersionConflictError` uses all three attempts on the `executing` write, so `vcsMerge` does not run.
   * The handler returns a `STATE_CONFLICT` failure and does not throw.
   */
  it('handleExecuteMerge_DefaultPersistState_VersionConflictExhausted_BubblesErrorAsToolResult', async () => {
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
    expect(persistState).toHaveBeenCalledTimes(3);
  });
});

/**
 * The pure executor writes the `executing` phase before the VCS merge. The handler writes the terminal phase:
 * `completed` with `mergeSha`, or `rolled-back` with `reason`. Without that write, disk state stays at
 * `executing`, and the HSM exit guards and resume fail.
 */
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

    expect(persistState).toHaveBeenCalledTimes(2);
    expect(persistState).toHaveBeenNthCalledWith(2, {
      phase: 'completed',
      recoveryPointSha: ROLLBACK_SHA,
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
      recoveryPointSha: ROLLBACK_SHA,
      reason: 'merge-failed',
    });
  });

  /**
   * Both terminal events go to the store before the state file write. If an append fails, replay rebuilds
   * from the event stream. If the state write fails after the appends, a reconcile recovers from the events.
   * The liveness event goes out in the `persistState` wrapper, before the `executing` write.
   * The projection fold needs this order. Log adjacency is not required, because each append reads the live tail.
   */
  it('handleExecuteMerge_OnCompleted_EmitsMergeExecutedBeforePersistingTerminalState', async () => {
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

    expect(callOrder).toEqual([
      'event:merge.executing_started',
      'persist:executing',
      'vcsMerge',
      'event:merge.executed',
      'event:merge.completed',
      'persist:completed',
    ]);
  });

  /** The liveness event comes first. On rollback, only `merge.recovered` goes to the store before the terminal state write. */
  it('handleExecuteMerge_OnRolledBack_EmitsMergeRecoveredBeforePersistingTerminalState', async () => {
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
      'event:merge.executing_started',
      'persist:executing',
      'vcsMerge',
      'event:merge.recovered',
      'persist:rolled-back',
    ]);
  });

  /**
   * A `vcsMerge` that times out once and then succeeds gives one `merge.retry_attempt`, then the
   * `merge.executed` and `merge.completed` pair. No recovery ladder runs. The retry event carries
   * `attempt`, `delayMs` and `reason`. The `jitter` and `sleep` hooks make the test deterministic and instant.
   */
  it('handleExecuteMerge_TimeoutOnceThenSuccess_EmitsOneRetryThenExecuted', async () => {
    const ctx = makeMockCtx();
    const appendedTypes: string[] = [];
    (ctx.eventStore.append as ReturnType<typeof vi.fn>).mockImplementation(
      async (_stream: string, event: { type: string }) => {
        appendedTypes.push(event.type);
        return { sequence: 1, type: event.type, timestamp: '' };
      },
    );

    let call = 0;
    const vcsMerge = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        const err = new Error('operation timed out');
        (err as Error & { code?: string }).code = 'ETIMEDOUT';
        throw err;
      }
      return { mergeSha: MERGE_SHA };
    });
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
        jitter: () => 0,
        sleep: async () => {},
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(vcsMerge).toHaveBeenCalledTimes(2);
    expect(appendedTypes).toEqual([
      'merge.executing_started',
      'merge.retry_attempt',
      'merge.executed',
      'merge.completed',
    ]);
    expect(appendedTypes).not.toContain('merge.recovered');
    expect(appendedTypes).not.toContain('merge.rollback');

    const retryCall = (ctx.eventStore.append as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'merge.retry_attempt',
    );
    expect(retryCall).toBeDefined();
    expect((retryCall![1] as { data: unknown }).data).toMatchObject({
      attempt: 1,
      delayMs: 1000,
      reason: 'timeout',
    });
  });

  /**
   * The handler emits `merge.executing_started` once, after it records the recovery point and before the
   * first `vcsMerge`. It precedes every `merge.retry_attempt` and the terminal event. The payload carries
   * the recovery point sha, the branch and task context, and a `startedAt` timestamp.
   */
  it('ExecuteMerge_Timeline_ExecutingStartedBeforeTerminal', async () => {
    const ctx = makeMockCtx();
    const appendedTypes: string[] = [];
    (ctx.eventStore.append as ReturnType<typeof vi.fn>).mockImplementation(
      async (_stream: string, event: { type: string }) => {
        appendedTypes.push(event.type);
        return { sequence: 1, type: event.type, timestamp: '' };
      },
    );

    let call = 0;
    const vcsMerge = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        const err = new Error('operation timed out');
        (err as Error & { code?: string }).code = 'ETIMEDOUT';
        throw err;
      }
      return { mergeSha: MERGE_SHA };
    });
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
        jitter: () => 0,
        sleep: async () => {},
      },
      ctx,
    );

    expect(result.success).toBe(true);

    const startedCount = appendedTypes.filter(
      (t) => t === 'merge.executing_started',
    ).length;
    expect(startedCount).toBe(1);

    const startedIdx = appendedTypes.indexOf('merge.executing_started');
    const retryIdx = appendedTypes.indexOf('merge.retry_attempt');
    const executedIdx = appendedTypes.indexOf('merge.executed');
    expect(startedIdx).toBe(0);
    expect(retryIdx).toBeGreaterThan(startedIdx);
    expect(executedIdx).toBeGreaterThan(retryIdx);

    expect(appendedTypes).toEqual([
      'merge.executing_started',
      'merge.retry_attempt',
      'merge.executed',
      'merge.completed',
    ]);

    const startedCall = (ctx.eventStore.append as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as { type: string }).type === 'merge.executing_started',
    );
    expect(startedCall).toBeDefined();
    const startedData = (startedCall![1] as { data: Record<string, unknown> }).data;
    expect(startedData).toMatchObject({
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      recoveryPointSha: ROLLBACK_SHA,
    });
    expect(typeof startedData.startedAt).toBe('string');
    expect((startedData.startedAt as string).length).toBeGreaterThan(0);
  });

  /** On the recovery path, the liveness event also comes first, and `merge.recovered` is the only terminal. */
  it('ExecuteMerge_Timeline_ExecutingStartedBeforeRecoveryTerminal', async () => {
    const ctx = makeMockCtx();
    const appendedTypes: string[] = [];
    (ctx.eventStore.append as ReturnType<typeof vi.fn>).mockImplementation(
      async (_stream: string, event: { type: string }) => {
        appendedTypes.push(event.type);
        return { sequence: 1, type: event.type, timestamp: '' };
      },
    );

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
    expect(appendedTypes).toEqual([
      'merge.executing_started',
      'merge.recovered',
    ]);
  });
});

import { EventStore } from '../../../../src/events/store.js';
import * as fsp from 'node:fs/promises';
import * as osMod from 'node:os';
import * as pathMod from 'node:path';
import '../../../../src/projections/merge-orchestrator/index.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const realScratchRoots: string[] = [];

async function makeRealScratchEventStore(): Promise<{
  eventStore: EventStore;
  stateDir: string;
}> {
  const stateDir = await fsp.mkdtemp(
    pathMod.join(osMod.tmpdir(), '1306-t4-dual-emit-'),
  );
  realScratchRoots.push(stateDir);
  await fsp.mkdir(pathMod.join(stateDir, 'workflow-state'), { recursive: true });
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return { eventStore, stateDir };
}

function makeRealCtx(eventStore: EventStore, stateDir: string): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: false,
  } as unknown as DispatchContext;
}

/**
 * The recovery path appends only `merge.recovered`. The append carries an idempotency key, so a retried
 * recovery is a no-op. The append reads a fresh tail and never reuses an earlier sequence.
 * These tests use a real `EventStore` in a temporary directory, so the SQLite idempotency claims really dedupe.
 */
describe('handleExecuteMerge DR-2 (task 006) — single-emit recovery + CAS idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await Promise.all(
      realScratchRoots.map((p) =>
        rmrfAsync(p),
      ),
    );
  });

  /** Against the real store, the recovery path writes one `merge.recovered` with `recoveryPointSha` and no `merge.rollback`. */
  it('ExecuteMerge_RecoveryPath_EmitsOnlyMergeRecovered_NoLegacyRollback', async () => {
    const { eventStore, stateDir } = await makeRealScratchEventStore();
    const ctx = makeRealCtx(eventStore, stateDir);

    const vcsMerge = vi.fn().mockRejectedValue(new Error('merge conflict'));
    const persistState = vi.fn().mockResolvedValue(undefined);

    const result = await handleExecuteMerge(
      {
        featureId: 'feat-dual',
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

    const events = await eventStore.query('feat-dual');
    const recovered = events.filter((e) => e.type === 'merge.recovered');
    const rollback = events.filter((e) => e.type === 'merge.rollback');

    expect(recovered).toHaveLength(1);
    expect(rollback).toHaveLength(0);

    const recoveredData = recovered[0].data as Record<string, unknown>;
    expect(recoveredData.recoveryPointSha).toBe(ROLLBACK_SHA);
    expect(recoveredData.reason).toBe('merge-failed');
  });

  /**
   * The CLI and MCP surfaces both call `handleExecuteMerge`, so the `merge.recovered` payload must be byte-identical.
   * The test runs the executor twice against two separate real stores and compares the serialized payloads.
   */
  it('ExecuteMerge_RecoveredPayload_ByteEqualAcrossRuns', async () => {
    async function driveRecoveryAndReadPayload(): Promise<unknown> {
      const { eventStore, stateDir } = await makeRealScratchEventStore();
      const ctx = makeRealCtx(eventStore, stateDir);
      await handleExecuteMerge(
        {
          featureId: 'feat-envelope',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          taskId: 'T11',
          strategy: 'squash',
          vcsMerge: vi.fn().mockRejectedValue(new Error('merge conflict')),
          persistState: vi.fn().mockResolvedValue(undefined),
          gitExec: makeGitExec(),
        },
        ctx,
      );
      const events = await eventStore.query('feat-envelope');
      return events.find((e) => e.type === 'merge.recovered')?.data;
    }

    const cliPayload = await driveRecoveryAndReadPayload();
    const mcpPayload = await driveRecoveryAndReadPayload();

    const expected = {
      taskId: 'T11',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      recoveryPointSha: ROLLBACK_SHA,
      reason: 'merge-failed',
    };
    expect(cliPayload).toEqual(expected);
    expect(mcpPayload).toEqual(expected);

    expect(JSON.stringify(cliPayload)).toEqual(JSON.stringify(mcpPayload));
    expect(JSON.stringify(cliPayload)).toEqual(JSON.stringify(expected));
  });

  /**
   * A second run of the same recovery must be a no-op. The SQLite idempotency index dedupes the append by its key.
   * A fixed pin to an earlier sequence makes the retry conflict on every run.
   * Then the second run throws or returns `STATE_CONFLICT`, and this test fails.
   */
  it('ExecuteMerge_RetriedRecovery_IdempotentOnMergeRecovered', async () => {
    const { eventStore, stateDir } = await makeRealScratchEventStore();
    const ctx = makeRealCtx(eventStore, stateDir);

    const invoke = () =>
      handleExecuteMerge(
        {
          featureId: 'feat-retry',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          taskId: 'T11',
          strategy: 'squash',
          vcsMerge: vi.fn().mockRejectedValue(new Error('merge conflict')),
          persistState: vi.fn().mockResolvedValue(undefined),
          gitExec: makeGitExec(),
        },
        ctx,
      );

    const first = await invoke();
    expect(first.success).toBe(false);
    expect(first.error?.code).toBe('MERGE_ROLLED_BACK');

    const second = await invoke();
    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('MERGE_ROLLED_BACK');

    const events = await eventStore.query('feat-retry');
    expect(events.filter((e) => e.type === 'merge.recovered')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'merge.rollback')).toHaveLength(0);
  });
});

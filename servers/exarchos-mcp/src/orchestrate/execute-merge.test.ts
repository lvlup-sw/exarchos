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
// T16 — rollback path. When the VCS merge rejects, the pure executor returns
// `phase: 'rolled-back'` after running the INV-14 recovery ladder
// (`git merge --abort` → `git reset --keep <rollbackSha>`, never `--hard`).
// The handler must:
//   1. emit `merge.rollback` to the workflow's event stream carrying the
//      categorized reason ('merge-failed' | 'verification-failed' | 'timeout')
//      and, on a non-clean recovery, the INV-14 `recoveryError` discriminator
//   2. rewind to `<rollbackSha>` via the ladder so HEAD matches the captured sha
//   3. return a structured `ToolResult` failure with code `MERGE_ROLLED_BACK`

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../event-store/store.js';
import { SequenceConflictError } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

import { handleExecuteMerge } from './execute-merge.js';

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeMockEventStore(): EventStore {
  // Wave 4 (audit §F1.2): the executor now invokes
  // `ctx.eventStore.getAppender().decide(...)` to commit `merge.requested`
  // (Phase A) BEFORE the vcsMerge side effect fires. The mock returns a
  // stub appender whose `decide` resolves to a `kind: 'committed'` shape
  // so the pre-existing tests (T15/T16/T27/etc — which assert on the
  // vcsMerge invocation + merge.executed/rollback emission legs)
  // continue passing. The migration test
  // (execute-merge.migration.test.ts) is the one that exercises the real
  // `decide` path against a tmp-dir `EventStore`.
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
    // #1303: handler reads stream tail to compute expectedSequence before
    // appending merge.executed / merge.completed / merge.rollback. Empty
    // array → expectedSequence: 0.
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
    // Two appends: `merge.executed` (side-effect record) and `merge.completed`
    // (terminal lifecycle marker). Distinct events per #1304 INV-10 alignment.
    expect(ctx.eventStore.append).toHaveBeenCalledTimes(2);
    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      1,
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
        },
      },
      // #1303: idempotencyKey + expectedSequence wired on merge.executed.
      {
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.executed',
      },
    );
    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      2,
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
        // CAS against the LIVE stream tail (not a static pin to the
        // merge.executed append result). The mock `query` returns [] for
        // every tail read, so the high-water mark is 0 here. The live-tail
        // read is what makes the terminal marker self-heal on retry — see
        // the `...CasPinsToLiveTailNotFrozenExecutedSequence` regression
        // test (Sentry r3315312847).
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.completed',
      },
    );
  });

  it('handleExecuteMerge_MergeCompleted_CasPinsToLiveTailNotFrozenExecutedSequence', async () => {
    // Regression — Sentry r3315312847 (PR #1492). The merge.completed CAS
    // MUST read the live stream tail, NOT a static pin to the merge.executed
    // sequence. The old pin stranded the workflow permanently in `executing`:
    // any unrelated event interleaving on the shared featureId stream advanced
    // the tail past the pin, and a retry re-derived the SAME executed sequence
    // (idempotency-key cache-hit) so the pinned CAS reproduced the conflict
    // forever with no recovery. A live-tail CAS self-heals on retry.
    const ctx = makeMockCtx();
    // First tail read (before merge.executed) → empty. By the second read
    // (before merge.completed) a concurrent writer has advanced the tail to
    // seq 7. merge.executed still returns its own seq 1 from the append mock —
    // a frozen pin would carry that stale 1 into the merge.completed CAS.
    (ctx.eventStore.query as ReturnType<typeof vi.fn>)
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

    // merge.completed (2nd append) CAS-pins to the LIVE tail (7), not the
    // merge.executed append's returned sequence (1).
    expect(ctx.eventStore.append).toHaveBeenNthCalledWith(
      2,
      'feat-x',
      expect.objectContaining({ type: 'merge.completed' }),
      expect.objectContaining({ expectedSequence: 7 }),
    );
  });

  it('handleExecuteMerge_MergeCompleted_RetriesInPlaceOnTransientSequenceConflict', async () => {
    // Regression — Sentry r3329404869 (PR #1492). A SequenceConflictError on
    // the merge.completed append must self-heal IN PLACE. Recovery cannot be
    // delegated to the caller: `handleMergeOrchestrate` runs the executor
    // OUTSIDE its retry boundary so a re-invocation would re-fire the
    // non-idempotent `vcsMerge`. This invocation already won the merge.executed
    // CAS, so it owns completion and retries just the terminal-marker append.
    const ctx = makeMockCtx();
    let completedAttempts = 0;
    (ctx.eventStore.append as ReturnType<typeof vi.fn>).mockImplementation(
      async (_stream: string, event: { type: string }) => {
        if (event.type === 'merge.completed') {
          completedAttempts += 1;
          // First attempt loses the sequence race; the in-place retry lands.
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

    // Recovered: terminal phase reached despite the transient conflict.
    expect(result.success).toBe(true);
    // The marker append was retried (first threw, retry landed).
    expect(completedAttempts).toBe(2);
    // The non-idempotent git merge was NOT re-run by the retry.
    expect(vcsMerge).toHaveBeenCalledTimes(1);
    // Terminal state still persisted after the marker landed.
    expect(persistState).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: 'completed' }),
    );
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

    // Ordering: persistState({phase:'executing', recoveryPointSha}) BEFORE vcsMerge.
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
    expect(ctx.eventStore.append).toHaveBeenCalledWith(
      'feat-x',
      {
        type: 'merge.rollback',
        data: {
          taskId: 'T11',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          rollbackSha: ROLLBACK_SHA,
          reason: 'merge-failed',
        },
      },
      // #1303 α-05: idempotencyKey + expectedSequence wired on merge.rollback.
      {
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.rollback',
      },
    );
  });

  it('handleExecuteMerge_AfterRollback_HeadMatchesRecordedSha', async () => {
    const ctx = makeMockCtx();
    const vcsMerge = vi.fn().mockRejectedValue(new Error('merge conflict'));
    const persistState = vi.fn().mockResolvedValue(undefined);

    // Track the gitExec calls so we can assert the INV-14 recovery ladder
    // (`git merge --abort` → `git reset --keep <sha>`) ran after the failure.
    const gitCalls: ReadonlyArray<string>[] = [];
    const gitExec = vi.fn().mockImplementation(
      (_repo: string, args: readonly string[]) => {
        gitCalls.push([...args]);
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
        }
        // merge --abort / reset --keep <sha> both succeed via this catch-all
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

    // INV-14: the pure executor invokes `git reset --keep <rollbackSha>` on
    // failure (after `git merge --abort`), never the destructive `--hard`.
    const resetCall = gitCalls.find(
      (a) => a[0] === 'reset' && a[1] === '--keep',
    );
    expect(resetCall).toBeDefined();
    expect(resetCall![2]).toBe(ROLLBACK_SHA);
    expect(gitCalls.some((a) => a[0] === 'merge' && a[1] === '--abort')).toBe(true);
    expect(gitCalls.some((a) => a[0] === 'reset' && a[1] === '--hard')).toBe(false);
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
      recoveryPointSha: ROLLBACK_SHA,
      reason: 'verification-failed',
    });
  });

  // The recovery-failure path is the one that populates `recoveryError` +
  // the recovery-error detail end-to-end — exercising it here keeps the operator
  // recovery contract (state file + emitted event + ToolResult all carry the
  // indeterminate-worktree signal) covered by the test suite.
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
          // Simulate `git reset --keep` refusing to discard local work: the
          // worktree is indeterminate (but non-destructive). INV-14's
          // 'reset-keep-blocked' case — operators must intervene.
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
    // `recoveryError` (discriminator) + `recoveryErrorDetail` (detail) ride on
    // the ToolResult `data` so callers detect the indeterminate worktree without
    // re-querying the event stream.
    expect((result.data as { recoveryError?: string }).recoveryError).toBe(
      'reset-keep-blocked',
    );
    expect((result.data as { recoveryErrorDetail?: string }).recoveryErrorDetail).toContain(
      'reset --keep',
    );

    // Same signals must appear on the emitted `merge.rollback` event so
    // event-stream consumers (projections, dashboards, alerting) see them
    // without reading the state file. The legacy event keeps its `rollbackError`
    // wire field during the #1306 deprecation window.
    expect(ctx.eventStore.append).toHaveBeenCalledTimes(1);
    const [, eventPayload] = (ctx.eventStore.append as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(eventPayload.type).toBe('merge.rollback');
    expect(eventPayload.data.recoveryError).toBe('reset-keep-blocked');
    expect(eventPayload.data.rollbackError).toContain('reset --keep');
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
//   • completed  → persist {phase, recoveryPointSha, mergeSha}
//   • rolled-back → persist {phase, recoveryPointSha, reason}
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

    // Event-first commit point (#1109 §1): both terminal events MUST be
    // appended before the state file is mutated. If either event append
    // fails, replay can still reconstruct from the event stream; if the
    // state write fails after, a reconcile recovers from the events alone.
    //
    // Order: persist(executing) → vcsMerge → event(merge.executed) →
    //        event(merge.completed) → persist(completed).
    // The merge.completed terminal marker (#1304) follows merge.executed and
    // both precede the state-file write. Ordering is what the projection fold
    // requires; strict log adjacency is NOT enforced (the CAS reads the live
    // tail), so an unrelated interleaved event would not break this.
    expect(callOrder).toEqual([
      'persist:executing',
      'vcsMerge',
      'event:merge.executed',
      'event:merge.completed',
      'persist:completed',
    ]);
  });

  it('handleExecuteMerge_OnRolledBack_EmitsMergeRollbackBeforePersistingTerminalState', async () => {
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
      'event:merge.rollback',
      'persist:rolled-back',
    ]);
  });
});

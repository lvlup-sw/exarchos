// ─── handleMergeOrchestrate tests (T11 + T12 + T13 + T14) ──────────────────
//
// T11 — happy path. Top-level orchestrator handler that composes preflight
// (T06/T07) with executor (T15) and emits the `merge.preflight` event for
// observability. Asserts:
//   1. on preflight pass + execute success returns
//      { success: true, data: { phase: 'completed', mergeSha, recoveryPointSha,
//        preflight } }.
//   2. emits `merge.preflight` exactly once (direct stream append, NOT
//      wrapped in `gate.executed` — the dedicated schema (T03) is top-level).
//
// T12 — preflight-fail abort branch. Asserts:
//   3. persistState invoked with
//      { phase: 'aborted', preflight, abortReason: 'preflight-failed' }
//      and ToolResult is { success: false, error: { code: 'PREFLIGHT_FAILED' } }.
//   4. executor adapter is NEVER invoked when preflight fails.
//   5. `merge.preflight` event is still emitted with `passed: false`.
//
// T13 — dry-run path. Asserts:
//   6. with `dryRun: true` and a passing preflight, the executor adapter is
//      NEVER invoked.
//   7. with `dryRun: true` and a passing preflight, returns
//      { success: true, data: { dryRun: true, preflight, phase: 'pending' } }
//      WITHOUT persisting `mergeOrchestrator` state (dry-run is observation
//      only).
//
// T14 — resume + state-write retry. Asserts:
//   8. with `resume: true` and existing `mergeOrchestrator.phase === 'pending'`
//      state, handler continues from preflight (no special short-circuit).
//   9. with `resume: true` and existing `mergeOrchestrator.phase === 'completed'`
//      state, handler returns the existing result without re-emitting events
//      or invoking the executor.
//   10. with `resume: false` (or omitted), existing state is ignored — fresh run.
//   11. when `persistState` throws `VersionConflictError` once then succeeds,
//       handler retries and the merge completes successfully.
//   12. when `persistState` keeps throwing `VersionConflictError`, handler
//       returns `{ success: false, error: { code: 'STATE_CONFLICT' } }`.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

import { handleMergeOrchestrate } from './merge-orchestrate.js';
import type { MergePreflightResult } from './pure/merge-preflight.js';
import { VersionConflictError } from '../workflow/state-store.js';

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeMockEventStore(): EventStore {
  // Wave 4 (audit §F1.2): the orchestrator now invokes
  // `ctx.eventStore.getAppender().decide(...)` to commit `merge.requested`
  // (Phase A) before delegating to the executor. The mock returns a stub
  // appender whose `decide` resolves to a `kind: 'committed'` shape so the
  // pre-existing tests (T11/T12/T13/T14 — which only assert on the
  // preflight + executor delegation legs) continue to pass without the
  // need for a real `AtomicAppender` instance. The migration test
  // (merge-orchestrate.migration.test.ts) is the one that exercises the
  // real `decide` path against a tmp-dir `EventStore`.
  const decide = vi.fn().mockResolvedValue({
    ok: true,
    kind: 'committed',
    sequences: [2],
    eventIds: ['evt-mock-requested'],
    timestamps: [new Date().toISOString()],
  });
  return {
    append: vi.fn().mockResolvedValue({
      sequence: 1,
      type: 'merge.preflight',
      timestamp: new Date().toISOString(),
    }),
    // #1303 α-04: handler reads stream tail to compute expectedSequence
    // before appending merge.preflight. Empty array → expectedSequence: 0.
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

const MERGE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);

// Type the fixture so it stays in lockstep with the production
// `MergePreflightResult` contract — an untyped fixture lets fields like
// `branch` vs `currentBranch` drift silently while tests still pass.
const PASSING_PREFLIGHT: MergePreflightResult = {
  passed: true,
  ancestry: { passed: true, checks: ['ancestry'] },
  currentBranchProtection: { blocked: false, currentBranch: 'feat/x' },
  worktree: { isMain: true, actual: '/repo', expected: '/repo' },
  drift: {
    clean: true,
    uncommittedFiles: [] as string[],
    indexStale: false,
    detachedHead: false,
  },
};

const FAILING_PREFLIGHT = {
  passed: false,
  // Ancestry not satisfied — target ('main') is not an ancestor of source
  // ('feat/x'), i.e., source is not up-to-date with target.
  ancestry: {
    passed: false,
    blocked: true,
    reason: 'ancestry' as const,
    missing: ['main'],
  },
  currentBranchProtection: { blocked: false, currentBranch: 'feat/x' },
  worktree: { isMain: true, actual: '/repo', expected: '/repo' },
  drift: {
    clean: true,
    uncommittedFiles: [] as string[],
    indexStale: false,
    detachedHead: false,
  },
};

describe('handleMergeOrchestrate (T11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleMergeOrchestrate_PreflightAndExecutePass_ReturnsCompletedToolResult', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: MERGE_SHA,
        recoveryPointSha: ROLLBACK_SHA,
      },
    });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        // DI: bypass real preflight composer + executor
        preflight,
        executeMerge,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      phase: 'completed',
      mergeSha: MERGE_SHA,
      recoveryPointSha: ROLLBACK_SHA,
      preflight: PASSING_PREFLIGHT,
    });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).toHaveBeenCalledTimes(1);
  });

  it('handleMergeOrchestrate_Always_EmitsMergePreflightEventOnce', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: MERGE_SHA,
        recoveryPointSha: ROLLBACK_SHA,
      },
    });

    await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        preflight,
        executeMerge,
      },
      ctx,
    );

    // Filter to merge.preflight emissions only — handleExecuteMerge is
    // mocked here, so the only append in this test should be preflight.
    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
    // DR-MO-1 AC#1: emit must include the structured preflight sub-results
    // (ancestry / currentBranchProtection / worktree / drift) so the event
    // log alone is sufficient for timeline reconstruction.
    expect(preflightCalls[0]).toEqual([
      'feat-x',
      {
        type: 'merge.preflight',
        data: {
          taskId: 'T11',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          passed: true,
          ancestry: PASSING_PREFLIGHT.ancestry,
          currentBranchProtection: PASSING_PREFLIGHT.currentBranchProtection,
          worktree: PASSING_PREFLIGHT.worktree,
          drift: PASSING_PREFLIGHT.drift,
        },
      },
      // #1303 α-04: idempotencyKey + expectedSequence wired on merge.preflight.
      {
        expectedSequence: 0,
        idempotencyKey: 'feat-x:merge_orchestrate:T11:merge.preflight',
      },
    ]);
  });
});

describe('handleMergeOrchestrate (T12 — preflight-fail abort)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleMergeOrchestrate_PreflightFails_PersistsPhaseAbortedAndReturnsToolResultFailure', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(FAILING_PREFLIGHT);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockResolvedValue(undefined);

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T12',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    // 1. persistState invoked with the abort shape, carrying source/target so
    //    a downstream consumer can render the aborted record without
    //    re-reading the event stream.
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(persistState).toHaveBeenCalledWith({
      phase: 'aborted',
      preflight: FAILING_PREFLIGHT,
      abortReason: 'preflight-failed',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      taskId: 'T12',
    });

    // 2. ToolResult is a structured failure with code 'PREFLIGHT_FAILED'.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PREFLIGHT_FAILED');
    expect(typeof result.error?.message).toBe('string');
    expect(result.error?.message.length).toBeGreaterThan(0);
    expect(result.data).toEqual({
      phase: 'aborted',
      preflight: FAILING_PREFLIGHT,
    });
  });

  it('handleMergeOrchestrate_PreflightFails_DoesNotInvokeExecutor', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(FAILING_PREFLIGHT);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockResolvedValue(undefined);

    await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T12',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    // Critical: the executor adapter must NEVER be invoked when preflight
    // fails. A successful merge after a failing preflight would defeat the
    // purpose of the gate.
    expect(executeMerge).not.toHaveBeenCalled();
  });

  it('handleMergeOrchestrate_PreflightFails_EmitsMergePreflightWithPassedFalse', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(FAILING_PREFLIGHT);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockResolvedValue(undefined);

    await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T12',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
    // DR-MO-1 AC#1 + MEDIUM fix: failing emits include sub-results AND a
    // populated `failureReasons` mirroring the operator-facing diagnostic.
    const [, emitted] = preflightCalls[0] as [string, { data: Record<string, unknown> }];
    expect(emitted.data).toMatchObject({
      taskId: 'T12',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      passed: false,
      ancestry: FAILING_PREFLIGHT.ancestry,
      currentBranchProtection: FAILING_PREFLIGHT.currentBranchProtection,
      worktree: FAILING_PREFLIGHT.worktree,
      drift: FAILING_PREFLIGHT.drift,
    });
    expect(Array.isArray(emitted.data.failureReasons)).toBe(true);
    expect((emitted.data.failureReasons as string[])[0]).toMatch(/ancestry/);
  });
});

// ─── #1362 phase 1 — preflight.debug event-wire ─────────────────────────────
//
// The helper at `pure/merge-preflight.ts` attaches an optional `debug` field
// to `MergePreflightResult` when `EXARCHOS_PREFLIGHT_DEBUG=1 && !ancestry.passed`.
// The schema at `event-store/schemas.ts:MergePreflightData.debug` declares an
// optional `MergePreflightDebugData` branch. The handler is the missing link:
// these tests assert that `preflight.debug`, when present on the helper's
// return value, is threaded through to `event.data.debug` on the appended
// `merge.preflight` event. Without this assertion the regression class
// (helper produces debug, schema accepts debug, but handler silently drops
// it) is invisible — `tests/outcome/preflight-debug.test.ts` only exercises
// the pure helper's return value and never inspects the appended event.
const FAILING_PREFLIGHT_WITH_DEBUG: MergePreflightResult = {
  ...FAILING_PREFLIGHT,
  debug: {
    gitVersion: 'git version 2.45.0',
    repoRoot: '/repo',
    worktreeList: 'worktree /repo\nHEAD abc\nbranch refs/heads/main\n',
    refsHeadsSource: { sha: 'c'.repeat(40), packed: false },
    refsHeadsTarget: { sha: 'd'.repeat(40), packed: false },
    mergeBaseCommand: ['git', 'merge-base', '--is-ancestor', 'main', 'feat/x'],
    mergeBaseExitCode: 1,
    mergeBaseStdout: '',
    mergeBaseStderr: '',
  },
};

describe('handleMergeOrchestrate (#1362 — preflight.debug event-wire)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('MergeOrchestrate_EnvSetAndAncestryFail_AppendsDebugBlockToEvent', async () => {
    // The handler accepts a DI'd `preflight` adapter, so the helper's env-var
    // gating is exercised separately (outcome test). Here we drive the handler
    // with a result that *already* carries `debug` (the exact shape the helper
    // produces under `EXARCHOS_PREFLIGHT_DEBUG=1 && !ancestry.passed`) and
    // assert the handler propagates it into the appended event.
    vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', '1');
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(FAILING_PREFLIGHT_WITH_DEBUG);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockResolvedValue(undefined);

    await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T1362',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
    const [, emitted] = preflightCalls[0] as [string, { data: Record<string, unknown> }];

    // Core assertion: handler threads `preflight.debug` into `event.data.debug`.
    expect(emitted.data.debug).toBeDefined();
    expect(emitted.data.debug).toEqual(FAILING_PREFLIGHT_WITH_DEBUG.debug);

    // Shape sanity — every required PreflightDebug field is present so a
    // schema validator at the read-side will accept the record.
    const debug = emitted.data.debug as Record<string, unknown>;
    expect(typeof debug.gitVersion).toBe('string');
    expect(typeof debug.repoRoot).toBe('string');
    expect(typeof debug.worktreeList).toBe('string');
    expect(debug.refsHeadsSource).toMatchObject({
      sha: expect.any(String),
      packed: expect.any(Boolean),
    });
    expect(debug.refsHeadsTarget).toMatchObject({
      sha: expect.any(String),
      packed: expect.any(Boolean),
    });
    expect(Array.isArray(debug.mergeBaseCommand)).toBe(true);
    expect(typeof debug.mergeBaseExitCode).toBe('number');
    expect(typeof debug.mergeBaseStdout).toBe('string');
    expect(typeof debug.mergeBaseStderr).toBe('string');
  });

  it('MergeOrchestrate_EnvUnsetAndAncestryFail_NoDebugBlockOnEvent', async () => {
    // Symmetric case: when the helper does NOT attach `debug` (env unset or
    // ancestry passed), the handler must omit `debug` from the event entirely
    // — not stamp an empty object, not stamp `undefined` explicitly. The
    // optional-spread pattern (matching `failureReasons`) is the contract.
    vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', '');
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(FAILING_PREFLIGHT);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockResolvedValue(undefined);

    await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T1362',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
    const [, emitted] = preflightCalls[0] as [string, { data: Record<string, unknown> }];
    expect('debug' in emitted.data).toBe(false);
  });

  it('MergeOrchestrate_PassingAncestryWithDebugInjected_DoesNotPersistDebug', async () => {
    // Defense-in-depth at the event-sourcing boundary (INV-1). The helper's
    // contract is "only attach `debug` when ancestry FAILED" — but the handler
    // accepts a DI'd `preflight` adapter, so a test fixture (or a future code
    // path) could synthesize a `PreflightResult` with `debug` set on a PASSING
    // preflight. The handler MUST NOT persist that debug into the event;
    // otherwise we'd leak diagnostic payloads onto passing-preflight events
    // and pollute the event store. The wire condition gates on BOTH the
    // presence of debug AND `ancestry.passed === false`.
    vi.stubEnv('EXARCHOS_PREFLIGHT_DEBUG', '1');
    const passingWithDebug: MergePreflightResult = {
      ...PASSING_PREFLIGHT,
      debug: FAILING_PREFLIGHT_WITH_DEBUG.debug,
    };
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(passingWithDebug);
    const executeMerge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: MERGE_SHA,
        recoveryPointSha: ROLLBACK_SHA,
      },
    });
    const persistState = vi.fn().mockResolvedValue(undefined);

    await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T1362-passing',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
    const [, emitted] = preflightCalls[0] as [string, { data: Record<string, unknown> }];
    // Passing preflight + debug-injected → handler MUST drop debug.
    expect('debug' in emitted.data).toBe(false);
  });
});

describe('handleMergeOrchestrate (T13 — dry-run path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleMergeOrchestrate_DryRunFlag_RunsPreflightAndSkipsExecutor', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockResolvedValue(undefined);

    await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T13',
        strategy: 'squash',
        dryRun: true,
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    // Preflight must still run — dry-run is observation, not bypass.
    expect(preflight).toHaveBeenCalledTimes(1);
    // Executor must NEVER run on a dry-run path.
    expect(executeMerge).not.toHaveBeenCalled();
  });

  it('handleMergeOrchestrate_DryRunPassedTrue_ReturnsToolResultSuccess', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockResolvedValue(undefined);

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T13',
        strategy: 'squash',
        dryRun: true,
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    // Successful dry-run shape — phase 'pending' signals "would proceed".
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      dryRun: true,
      preflight: PASSING_PREFLIGHT,
      phase: 'pending',
    });

    // Dry-run must NOT persist `mergeOrchestrator` state — it's pure
    // observation. Persistence on the dry-run path would corrupt the
    // workflow state with a transient phase that has no real effect.
    expect(persistState).not.toHaveBeenCalled();
  });
});

describe('handleMergeOrchestrate (T14 — resume path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleMergeOrchestrate_ResumeWithExistingPendingState_LoadsAndContinues', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: MERGE_SHA,
        recoveryPointSha: ROLLBACK_SHA,
      },
    });
    const persistState = vi.fn().mockResolvedValue(undefined);
    const readState = vi.fn().mockResolvedValue({
      mergeOrchestrator: {
        phase: 'pending',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T14',
      },
    });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T14',
        strategy: 'squash',
        resume: true,
        preflight,
        executeMerge,
        persistState,
        readState,
      },
      ctx,
    );

    // On a 'pending' phase resume, the handler reads existing state, then
    // falls through to preflight + executor as if it were a fresh run.
    expect(readState).toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect((result.data as { phase: string }).phase).toBe('completed');
  });

  it('handleMergeOrchestrate_ResumeWithCompletedState_ReturnsExistingResultNoOp', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn();
    const executeMerge = vi.fn();
    const persistState = vi.fn();
    const readState = vi.fn().mockResolvedValue({
      mergeOrchestrator: {
        phase: 'completed',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T14',
        mergeSha: MERGE_SHA,
        recoveryPointSha: ROLLBACK_SHA,
      },
    });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T14',
        strategy: 'squash',
        resume: true,
        preflight,
        executeMerge,
        persistState,
        readState,
      },
      ctx,
    );

    // Critical: terminal-phase resume is a NO-OP. No new events, no executor,
    // no persistence — just surface the existing result.
    expect(preflight).not.toHaveBeenCalled();
    expect(executeMerge).not.toHaveBeenCalled();
    expect(persistState).not.toHaveBeenCalled();
    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    expect(appendMock).not.toHaveBeenCalled();

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      phase: 'completed',
      mergeSha: MERGE_SHA,
      recoveryPointSha: ROLLBACK_SHA,
    });
  });

  it('handleMergeOrchestrate_ResumeWithoutFlagButStateExists_StartsFresh', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: MERGE_SHA,
        recoveryPointSha: ROLLBACK_SHA,
      },
    });
    const persistState = vi.fn().mockResolvedValue(undefined);
    // readState returns terminal state, but resume=false should ignore it.
    const readState = vi.fn().mockResolvedValue({
      mergeOrchestrator: {
        phase: 'completed',
        mergeSha: 'old-merge-sha',
        recoveryPointSha: 'old-rollback-sha',
      },
    });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T14',
        strategy: 'squash',
        // resume omitted → must default to fresh dispatch
        preflight,
        executeMerge,
        persistState,
        readState,
      },
      ctx,
    );

    // Without resume, readState must not be consulted (fresh run semantics).
    expect(readState).not.toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    // Result reflects the FRESH executor output, not the stale state.
    expect((result.data as { mergeSha: string }).mergeSha).toBe(MERGE_SHA);
  });

  it('handleMergeOrchestrate_StateWriteVersionConflict_RetriesAndSucceeds', async () => {
    // Setup: trigger the persistState path via preflight failure (T12 abort).
    // First call throws VersionConflictError, second call succeeds.
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(FAILING_PREFLIGHT);
    const executeMerge = vi.fn();
    let calls = 0;
    const persistState = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new VersionConflictError(1, 2);
      }
      return undefined;
    });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T14',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    // Retry succeeded → persistState invoked twice, ToolResult reflects abort.
    expect(persistState).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PREFLIGHT_FAILED');
  });

  it('handleMergeOrchestrate_StateWriteRetriesExhausted_ReturnsToolResultFailure', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(FAILING_PREFLIGHT);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockImplementation(async () => {
      throw new VersionConflictError(1, 2);
    });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T14',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
      },
      ctx,
    );

    // After MAX_STATE_RETRIES exhaustions, surface STATE_CONFLICT.
    expect(persistState).toHaveBeenCalledTimes(3);
    expect(executeMerge).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_CONFLICT');
  });
});

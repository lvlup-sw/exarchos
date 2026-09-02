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
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';

import { handleMergeOrchestrate } from '../../../../src/verbs/merge/merge-orchestrate.js';
import type { MergePreflightResult, GitExec } from '../../../../src/verbs/pure/merge-preflight.js';
import { VersionConflictError } from '../../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../../../src/verbs/worktree/manager.js';
import type { ProcessTableSource, ProcessRecord } from '../../../../src/verbs/worktree/pure/probe.js';

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
  // DR-2 lease guard: the handler folds `worktrees@v1` via
  // `getAppender().aggregateStream(...)` before any git side effect. These
  // legacy tests hold NO lease, so the mock returns an empty projection →
  // guard finds no holder → proceeds exactly as before the guard existed.
  const aggregateStream = vi.fn().mockResolvedValue({
    aggregate: { projectionSequence: 0, worktrees: {}, inFlightMerges: {} },
    version: 0,
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
    getAppender: vi.fn().mockReturnValue({ decide, aggregateStream }),
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
// The schema at `events/schemas.ts:MergePreflightData.debug` declares an
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

// ─── #1706 DR-1 — unknown-error paths return coded envelopes, never throw ──
//
// Three sites in this handler convert KNOWN retryable/typed errors
// (SequenceConflictError/VersionConflictError/StateStoreError/
// ConcurrencyError/StorageBusyError) but previously RE-THREW anything else.
// dispatch.ts's outer safety net would catch that throw and flatten it to a
// generic INTERNAL_ERROR, discarding the structured classification. Each
// site must instead return a coded ToolResult.error directly. `withStateRetry`
// only retries the recognized typed errors (state-retry.ts's `isRetryable`),
// so a plain `Error` propagates on the FIRST attempt — these tests assert
// single-call, not retried.
// ─────────────────────────────────────────────────────────────────────────────

describe('handleMergeOrchestrate (#1706 DR-1 — unknown-error coded envelopes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Section 0a (#1356) shells out to REAL git (via the default `gitExec`)
  // to detect whether `targetBranch` is checked out in a sibling worktree —
  // a real concern when these tests run from inside an actual git worktree
  // checkout (e.g. this repo's own `.worktrees/` dev layout), where 'main'
  // genuinely IS checked out in a sibling directory. A non-zero exit code
  // short-circuits that whole probe (merge-orchestrate.ts:509), so this
  // fixture — mirroring the DR-2 lease-guard describe block's `NO_GIT`
  // below — makes these tests deterministic regardless of the host repo's
  // real worktree topology.
  const bypassSection0a: GitExec = () => ({ exitCode: 1, stdout: '', stderr: '' });

  it('MergeOrchestrate_PreflightAppendUnknownError_ReturnsCodedEnvelopeNotThrow', async () => {
    // The `merge.preflight` append (section 2) runs before the dry-run /
    // abort branches, for both a passing and failing preflight. A plain
    // Error (not SequenceConflictError) must return EVENT_APPEND_FAILED.
    const decide = vi.fn();
    const aggregateStream = vi.fn().mockResolvedValue({
      aggregate: { projectionSequence: 0, worktrees: {}, inFlightMerges: {} },
      version: 0,
    });
    const ctx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append: vi.fn().mockImplementation(
          async (_streamId: string, event: { type: string }) => {
            if (event.type === 'merge.preflight') {
              throw new Error('disk full');
            }
            return { sequence: 1, type: event.type, timestamp: new Date().toISOString() };
          },
        ),
        query: vi.fn().mockResolvedValue([]),
        getAppender: vi.fn().mockReturnValue({ decide, aggregateStream }),
      } as unknown as EventStore,
      enableTelemetry: false,
    };
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn();

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T-append',
        strategy: 'squash',
        preflight,
        executeMerge,
        gitExec: bypassSection0a,
      },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(result.error?.message).toContain('disk full');
    expect(executeMerge).not.toHaveBeenCalled();
  });

  it('MergeOrchestrate_PersistAbortStateUnknownError_ReturnsCodedEnvelopeNotThrow', async () => {
    // The abort-branch persistState (section 4, T12) converts
    // VersionConflictError and StateStoreError; a plain Error must return
    // STATE_WRITE_FAILED instead of escaping.
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(FAILING_PREFLIGHT);
    const executeMerge = vi.fn();
    const persistState = vi.fn().mockRejectedValue(new Error('disk full'));

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T-persist',
        strategy: 'squash',
        preflight,
        executeMerge,
        persistState,
        gitExec: bypassSection0a,
      },
      ctx,
    );

    // Not a recognized retryable class — persistState invoked exactly once.
    expect(persistState).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_WRITE_FAILED');
    expect(result.error?.message).toContain('disk full');
    expect(executeMerge).not.toHaveBeenCalled();
  });

  it('MergeOrchestrate_MergeRequestedDecideUnknownError_ReturnsCodedEnvelopeNotThrow', async () => {
    // Phase A's `appender.decide` (section 4b) converts ConcurrencyError and
    // StorageBusyError; a plain Error must return EVENT_APPEND_FAILED
    // instead of escaping.
    const decide = vi.fn().mockRejectedValue(new Error('disk full'));
    const aggregateStream = vi.fn().mockResolvedValue({
      aggregate: { projectionSequence: 0, worktrees: {}, inFlightMerges: {} },
      version: 0,
    });
    const ctx: DispatchContext = {
      stateDir: '/tmp/test-state',
      eventStore: {
        append: vi.fn().mockResolvedValue({
          sequence: 1,
          type: 'merge.preflight',
          timestamp: new Date().toISOString(),
        }),
        query: vi.fn().mockResolvedValue([]),
        getAppender: vi.fn().mockReturnValue({ decide, aggregateStream }),
      } as unknown as EventStore,
      enableTelemetry: false,
    };
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn();

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T-decide',
        strategy: 'squash',
        preflight,
        executeMerge,
        gitExec: bypassSection0a,
      },
      ctx,
    );

    // Not a recognized retryable class — decide invoked exactly once.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EVENT_APPEND_FAILED');
    expect(result.error?.message).toContain('disk full');
    expect(executeMerge).not.toHaveBeenCalled();
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

// ─── DR-2 — single-writer lease guard (task-005) ─────────────────────────────
//
// The guard folds `worktrees@v1` at the handler chokepoint and fails a merge
// CLOSED when a FOREIGN live lease holds the target integration ref. These
// tests drive it against a REAL EventStore (real fold) with the DR-5 probe
// fixtures, injecting only the preflight / executor / git seams the handler
// itself owns. A benign `gitExec` neutralizes the section-0a worktree probe so
// the proceed-path tests exercise the guard in isolation.

/** Real EventStore arm — the guard reads a genuine `worktrees@v1` fold. */
interface LeaseArm {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly ctx: DispatchContext;
}

const leaseArms: LeaseArm[] = [];

async function createLeaseArm(): Promise<LeaseArm> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'mo-lease-guard-'));
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  const arm: LeaseArm = { stateDir, eventStore, ctx };
  leaseArms.push(arm);
  return arm;
}

/** Live process table reporting exactly the listed (pid, startTime) pairs alive. */
function liveTable(pairs: ReadonlyArray<{ pid: number; startTime: string }>): ProcessTableSource {
  const records: ProcessRecord[] = pairs.map(({ pid, startTime }) => ({
    pid,
    ppid: 1,
    cwd: `/proc-fixture/${pid}`,
    startTime,
  }));
  return { list: () => records };
}

/** Empty but SUPPORTED table — every probed pid reads as absent (provably dead). */
const EMPTY_TABLE: ProcessTableSource = { list: () => [] };

/** UNSUPPORTED (off-Linux) table — every probed pid reads `'unknown'`, never dead. */
const UNSUPPORTED_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => false,
};

/** Seed a held merge lease (CLAIM) directly on the singleton worktrees stream. */
async function seedLease(
  arm: LeaseArm,
  holder: {
    integrationRef: string;
    operationId: string;
    sourceBranch: string;
    holderPid: number;
    holderStartedAt: string;
  },
): Promise<void> {
  await arm.eventStore.getAppender().append(
    WORKTREES_STREAM,
    [{ type: 'worktree.merge_requested', data: { ...holder } }],
    `worktree.merge_requested:${holder.operationId}`,
  );
}

/** A gitExec that fails every invocation → neutralizes the section-0a probe. */
const NO_GIT: GitExec = () => ({ exitCode: 1, stdout: '', stderr: '' });

function passingExecuteMerge() {
  return vi.fn().mockResolvedValue({
    success: true,
    data: {
      phase: 'completed' as const,
      mergeSha: MERGE_SHA,
      recoveryPointSha: ROLLBACK_SHA,
    },
  });
}

describe('handleMergeOrchestrate (DR-2 — single-writer lease guard)', () => {
  afterEach(async () => {
    while (leaseArms.length > 0) {
      const arm = leaseArms.pop();
      if (arm) {
        arm.eventStore.close();
        await rmrfAsync(arm.stateDir);
      }
    }
  });

  it('MergeOrchestrate_ForeignLiveLeaseOnTarget_FailsClosedNamingSerializeMerge', async () => {
    const arm = await createLeaseArm();
    const integrationRef = 'integration/guard-foreign';
    await seedLease(arm, {
      integrationRef,
      operationId: 'foreign-live-op',
      sourceBranch: 'feat/other',
      holderPid: 999,
      holderStartedAt: 'alive-999',
    });
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = passingExecuteMerge();

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-guard',
        sourceBranch: 'feat/mine',
        targetBranch: integrationRef,
        strategy: 'squash',
        // No leaseOperationId — a plain caller racing the integration branch.
        preflight,
        executeMerge,
        gitExec: NO_GIT,
        processTableSource: liveTable([{ pid: 999, startTime: 'alive-999' }]),
      },
      arm.ctx,
    );

    // Fail-closed with a structured error that NAMES serialize_merge.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_LEASE_HELD');
    expect(result.error?.message).toMatch(/serialize_merge/);
    expect((result.data as { reason?: string }).reason).toBe('foreign-live-lease');

    // NO git side effect: the executor never ran and NO merge.preflight /
    // merge.requested event landed on the feature stream (guard runs first).
    expect(preflight).not.toHaveBeenCalled();
    expect(executeMerge).not.toHaveBeenCalled();
    const featureEvents = await arm.eventStore.query('feat-guard');
    expect(featureEvents).toHaveLength(0);
    // The lease is untouched — still held by the foreign holder.
    const wt = await arm.eventStore
      .getAppender()
      .aggregateStream(WORKTREES_STREAM, 'worktrees@v1');
    expect(
      (wt.aggregate as { inFlightMerges: Record<string, { operationId: string }> })
        .inFlightMerges[integrationRef]?.operationId,
    ).toBe('foreign-live-op');
  });

  it('MergeOrchestrate_NoLease_BehavesAsToday', async () => {
    const arm = await createLeaseArm();
    // No lease seeded — the target integration ref is free.
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = passingExecuteMerge();

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-nolease',
        sourceBranch: 'feat/mine',
        targetBranch: 'integration/guard-free',
        strategy: 'squash',
        preflight,
        executeMerge,
        gitExec: NO_GIT,
        processTableSource: liveTable([{ pid: 999, startTime: 'alive-999' }]),
      },
      arm.ctx,
    );

    // No holder → guard is transparent → preflight + executor run as today.
    expect(result.success).toBe(true);
    expect((result.data as { phase: string }).phase).toBe('completed');
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).toHaveBeenCalledTimes(1);
  });

  it('MergeOrchestrate_DeadHolderLease_ProceedsAfterProbe', async () => {
    const arm = await createLeaseArm();
    const integrationRef = 'integration/guard-dead';
    // Holder pid absent from the SUPPORTED empty table → provably dead.
    await seedLease(arm, {
      integrationRef,
      operationId: 'dead-holder-op',
      sourceBranch: 'feat/dead',
      holderPid: 4242,
      holderStartedAt: 'gone',
    });
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = passingExecuteMerge();

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-dead',
        sourceBranch: 'feat/mine',
        targetBranch: integrationRef,
        strategy: 'squash',
        // No leaseOperationId — a provably-dead holder proceeds regardless.
        preflight,
        executeMerge,
        gitExec: NO_GIT,
        processTableSource: EMPTY_TABLE,
      },
      arm.ctx,
    );

    // Provably-dead holder does NOT block — the merge proceeds (back-compat).
    expect(result.success).toBe(true);
    expect(executeMerge).toHaveBeenCalledTimes(1);
  });

  it('MergeOrchestrate_UnknownHolderLiveness_FailsClosed', async () => {
    const arm = await createLeaseArm();
    const integrationRef = 'integration/guard-unknown';
    // Same absent pid, but probed against the UNSUPPORTED (off-Linux) table:
    // liveness reads 'unknown', NOT 'dead' → the guard must fail CLOSED.
    await seedLease(arm, {
      integrationRef,
      operationId: 'unknown-holder-op',
      sourceBranch: 'feat/held',
      holderPid: 9090,
      holderStartedAt: 'boot-9090',
    });
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = passingExecuteMerge();

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-unknown',
        sourceBranch: 'feat/mine',
        targetBranch: integrationRef,
        strategy: 'squash',
        preflight,
        executeMerge,
        gitExec: NO_GIT,
        processTableSource: UNSUPPORTED_TABLE,
      },
      arm.ctx,
    );

    // Unknown liveness counts as held → fail closed (off-Linux fail-closed).
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_LEASE_HELD');
    expect((result.data as { holder?: { liveness?: string } }).holder?.liveness).toBe('unknown');
    expect(executeMerge).not.toHaveBeenCalled();
  });

  it('MergeOrchestrate_LeaseKeyShape_MatchesSerializerBareBranch', async () => {
    const arm = await createLeaseArm();
    // The serializer writes BARE branch names as the inFlightMerges key. Seed
    // under the bare 'main' and target 'main': the handler builds
    // `refs/heads/main` internally, but the guard MUST look up the BARE key the
    // serializer WROTE. A guard that looked up `refs/heads/main` would miss the
    // lease and proceed — this test would then go red.
    await seedLease(arm, {
      integrationRef: 'main',
      operationId: 'bare-key-op',
      sourceBranch: 'feat/other',
      holderPid: 555,
      holderStartedAt: 'alive-555',
    });
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = passingExecuteMerge();

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-barekey',
        sourceBranch: 'feat/mine',
        targetBranch: 'main',
        strategy: 'squash',
        preflight,
        executeMerge,
        gitExec: NO_GIT,
        processTableSource: liveTable([{ pid: 555, startTime: 'alive-555' }]),
      },
      arm.ctx,
    );

    // The bare-branch key matched → fail closed against the foreign live lease.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_LEASE_HELD');
    expect((result.data as { integrationRef?: string }).integrationRef).toBe('main');
    expect(executeMerge).not.toHaveBeenCalled();
  });

  it('MergeOrchestrate_MatchingLeaseOperationId_ProceedsThroughGuard', async () => {
    // The serializer's own composed call (and a crash-resumed caller) present
    // the holder's operationId as leaseOperationId → matched → proceed even
    // though the holder is LIVE. This is the positive twin of the fail-closed
    // path and pins the operationId-match short-circuit.
    const arm = await createLeaseArm();
    const integrationRef = 'integration/guard-own';
    await seedLease(arm, {
      integrationRef,
      operationId: 'my-own-lease-op',
      sourceBranch: 'feat/mine',
      holderPid: 777,
      holderStartedAt: 'alive-777',
    });
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = passingExecuteMerge();

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-own',
        sourceBranch: 'feat/mine',
        targetBranch: integrationRef,
        strategy: 'squash',
        leaseOperationId: 'my-own-lease-op', // our own lease → matched by opId.
        preflight,
        executeMerge,
        gitExec: NO_GIT,
        processTableSource: liveTable([{ pid: 777, startTime: 'alive-777' }]),
      },
      arm.ctx,
    );

    expect(result.success).toBe(true);
    expect(executeMerge).toHaveBeenCalledTimes(1);
  });
});

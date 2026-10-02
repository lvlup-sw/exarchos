// Tests for `handleMergeOrchestrate`, which runs the merge preflight, emits
// `merge.preflight`, and calls the executor. The tests inject the preflight,
// the executor, the state callbacks, and `gitExec`. They cover the completed
// path, the abort on a failing preflight, and the `debug` block on the event.
// They also cover the dry run, coded errors, resume, the state-write retry,
// and the single-writer lease guard.

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
import { BYPASS_SECTION_0A } from '../../../helpers/section-0a-bypass.js';

/**
 * A mock event store. `getAppender().decide` resolves as `committed`, so the
 * handler commits `merge.requested` without a real appender. The migration test
 * covers the real `decide` path. `aggregateStream` returns an empty
 * `worktrees@v1` projection, so the lease guard finds no holder. `query`
 * returns no events, so `merge.preflight` gets `expectedSequence: 0`.
 */
function makeMockEventStore(): EventStore {
  const decide = vi.fn().mockResolvedValue({
    ok: true,
    kind: 'committed',
    sequences: [2],
    eventIds: ['evt-mock-requested'],
    timestamps: [new Date().toISOString()],
  });
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

/**
 * Typed as `MergePreflightResult`, so an editor flags a field name that drifts
 * from the production contract. `npm run typecheck` does not read `tests/unit`.
 */
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
  /** The ancestry check fails: `main` is not an ancestor of `feat/x`, so the source is behind the target. */
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
        preflight,
        executeMerge,
        gitExec: BYPASS_SECTION_0A,
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

  /**
   * The executor is a mock, so the only `merge.preflight` append comes from the
   * handler. The event carries the preflight sub-results, so the event log
   * alone can rebuild the timeline. The append sets `expectedSequence` and an
   * `idempotencyKey`.
   */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
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

  /**
   * The abort record carries the source and target, so a consumer can show it
   * without a read of the event stream. The result is a `PREFLIGHT_FAILED` failure.
   */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(persistState).toHaveBeenCalledTimes(1);
    expect(persistState).toHaveBeenCalledWith({
      phase: 'aborted',
      preflight: FAILING_PREFLIGHT,
      abortReason: 'preflight-failed',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      taskId: 'T12',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PREFLIGHT_FAILED');
    expect(typeof result.error?.message).toBe('string');
    expect(result.error?.message.length).toBeGreaterThan(0);
    expect(result.data).toEqual({
      phase: 'aborted',
      preflight: FAILING_PREFLIGHT,
    });
  });

  /** A merge after a failing preflight defeats the gate, so the executor must not run. */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(executeMerge).not.toHaveBeenCalled();
  });

  /**
   * A failing event carries the sub-results and a `failureReasons` list that
   * matches the diagnostic for the operator.
   */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
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

/**
 * A failing preflight with a `debug` block. The preflight helper adds `debug`
 * when `EXARCHOS_PREFLIGHT_DEBUG=1` and ancestry fails, and the event schema
 * accepts it. These tests prove that the handler copies `preflight.debug` to
 * `event.data.debug`. `tests/outcome/preflight-debug.test.ts` reads only the
 * helper result, not the appended event.
 */
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

  /**
   * The outcome test covers the env gate of the helper. This test injects a
   * preflight result that already has `debug`. The event must carry that block
   * with each required field, so a schema check on the read side accepts it.
   */
  it('MergeOrchestrate_EnvSetAndAncestryFail_AppendsDebugBlockToEvent', async () => {
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
    const [, emitted] = preflightCalls[0] as [string, { data: Record<string, unknown> }];

    expect(emitted.data.debug).toBeDefined();
    expect(emitted.data.debug).toEqual(FAILING_PREFLIGHT_WITH_DEBUG.debug);

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

  /**
   * If the preflight result has no `debug`, the event has no `debug` key: not
   * an empty object, and not an explicit `undefined`.
   */
  it('MergeOrchestrate_EnvUnsetAndAncestryFail_NoDebugBlockOnEvent', async () => {
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
        gitExec: BYPASS_SECTION_0A,
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

  /**
   * The handler copies `debug` only when `debug` is present and ancestry
   * fails. An injected adapter can put `debug` on a passing preflight. The
   * handler must drop it, so diagnostic payloads stay off passing events.
   */
  it('MergeOrchestrate_PassingAncestryWithDebugInjected_DoesNotPersistDebug', async () => {
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
        gitExec: BYPASS_SECTION_0A,
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
});

describe('handleMergeOrchestrate (T13 — dry-run path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A dry run still runs the preflight, but never the executor. */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).not.toHaveBeenCalled();
  });

  /**
   * A dry run returns `phase: 'pending'` and persists no `mergeOrchestrator`
   * state. A persisted dry-run phase puts a phase with no real effect into the
   * workflow state.
   */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      dryRun: true,
      preflight: PASSING_PREFLIGHT,
      phase: 'pending',
    });

    expect(persistState).not.toHaveBeenCalled();
  });
});

/**
 * Three sites in the handler map known typed errors to codes. Any other error
 * must also return a coded `ToolResult.error`, not a throw that dispatch turns
 * into a generic `INTERNAL_ERROR`. `withStateRetry` retries only the typed
 * errors, so a plain `Error` stops after one call. `bypassSection0a` makes the
 * sibling-worktree probe fail, so the result does not depend on the worktree
 * layout of the host repo.
 */
describe('handleMergeOrchestrate (#1706 DR-1 — unknown-error coded envelopes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const bypassSection0a = BYPASS_SECTION_0A;

  /**
   * The `merge.preflight` append runs before the dry-run and abort branches. A
   * plain `Error` from it gives `EVENT_APPEND_FAILED`.
   */
  it('MergeOrchestrate_PreflightAppendUnknownError_ReturnsCodedEnvelopeNotThrow', async () => {
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

  /**
   * The abort-branch `persistState` maps `VersionConflictError` and
   * `StateStoreError`. A plain `Error` gives `STATE_WRITE_FAILED` after one call.
   */
  it('MergeOrchestrate_PersistAbortStateUnknownError_ReturnsCodedEnvelopeNotThrow', async () => {
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

    expect(persistState).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_WRITE_FAILED');
    expect(result.error?.message).toContain('disk full');
    expect(executeMerge).not.toHaveBeenCalled();
  });

  /**
   * The `appender.decide` call for `merge.requested` maps `ConcurrencyError`
   * and `StorageBusyError`. A plain `Error` gives `EVENT_APPEND_FAILED` after
   * one call.
   */
  it('MergeOrchestrate_MergeRequestedDecideUnknownError_ReturnsCodedEnvelopeNotThrow', async () => {
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

  /**
   * On a resume from a `pending` phase, the handler reads the state and then
   * runs the preflight and the executor as a fresh run does.
   */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(readState).toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect((result.data as { phase: string }).phase).toBe('completed');
  });

  /**
   * A resume from a terminal phase does nothing: no event, no executor, and no
   * state write. It returns the stored result.
   */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

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

  /**
   * Without `resume`, the handler does not read the stored terminal state. The
   * result comes from the new executor run.
   */
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
        preflight,
        executeMerge,
        persistState,
        readState,
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(readState).not.toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect((result.data as { mergeSha: string }).mergeSha).toBe(MERGE_SHA);
  });

  /**
   * A failing preflight takes the `persistState` path. The first call throws
   * `VersionConflictError` and the second call succeeds, so the result is the abort.
   */
  it('handleMergeOrchestrate_StateWriteVersionConflict_RetriesAndSucceeds', async () => {
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(persistState).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PREFLIGHT_FAILED');
  });

  /** After `MAX_STATE_RETRIES` conflicts, the handler returns `STATE_CONFLICT`. */
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(persistState).toHaveBeenCalledTimes(3);
    expect(executeMerge).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_CONFLICT');
  });
});

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

/** @see BYPASS_SECTION_0A — the shared helper this alias points at. */
const NO_GIT = BYPASS_SECTION_0A;

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

/**
 * The guard folds `worktrees@v1` and fails a merge closed when a live foreign
 * lease holds the target ref. The tests use a real `EventStore` and inject only
 * the preflight, executor, and git seams of the handler. `NO_GIT` makes the
 * sibling-worktree probe fail, so the tests isolate the guard.
 */
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

  /**
   * A caller without `leaseOperationId` meets a live foreign lease. The handler
   * fails closed with an error that names `serialize_merge`. The guard runs
   * first, so no preflight, executor, or feature event occurs. The lease stays
   * with its holder.
   */
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
        preflight,
        executeMerge,
        gitExec: NO_GIT,
        processTableSource: liveTable([{ pid: 999, startTime: 'alive-999' }]),
      },
      arm.ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_LEASE_HELD');
    expect(result.error?.message).toMatch(/serialize_merge/);
    expect((result.data as { reason?: string }).reason).toBe('foreign-live-lease');

    expect(preflight).not.toHaveBeenCalled();
    expect(executeMerge).not.toHaveBeenCalled();
    const featureEvents = await arm.eventStore.query('feat-guard');
    expect(featureEvents).toHaveLength(0);
    const wt = await arm.eventStore
      .getAppender()
      .aggregateStream(WORKTREES_STREAM, 'worktrees@v1');
    expect(
      (wt.aggregate as { inFlightMerges: Record<string, { operationId: string }> })
        .inFlightMerges[integrationRef]?.operationId,
    ).toBe('foreign-live-op');
  });

  /** With no lease on the target, the guard has no effect, and the preflight and the executor run. */
  it('MergeOrchestrate_NoLease_BehavesAsToday', async () => {
    const arm = await createLeaseArm();
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

    expect(result.success).toBe(true);
    expect((result.data as { phase: string }).phase).toBe('completed');
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).toHaveBeenCalledTimes(1);
  });

  /**
   * The holder pid is absent from a supported empty table, so the holder is
   * dead. A dead holder does not block, even without `leaseOperationId`.
   */
  it('MergeOrchestrate_DeadHolderLease_ProceedsAfterProbe', async () => {
    const arm = await createLeaseArm();
    const integrationRef = 'integration/guard-dead';
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
        preflight,
        executeMerge,
        gitExec: NO_GIT,
        processTableSource: EMPTY_TABLE,
      },
      arm.ctx,
    );

    expect(result.success).toBe(true);
    expect(executeMerge).toHaveBeenCalledTimes(1);
  });

  /**
   * An absent pid on an unsupported table reads as `unknown`, not dead.
   * Unknown liveness counts as held, so the guard fails closed.
   */
  it('MergeOrchestrate_UnknownHolderLiveness_FailsClosed', async () => {
    const arm = await createLeaseArm();
    const integrationRef = 'integration/guard-unknown';
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

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_LEASE_HELD');
    expect((result.data as { holder?: { liveness?: string } }).holder?.liveness).toBe('unknown');
    expect(executeMerge).not.toHaveBeenCalled();
  });

  /**
   * The serializer keys `inFlightMerges` by the bare branch name. The handler
   * builds `refs/heads/main` internally, but the guard must look up the bare key
   * `main`. A lookup of `refs/heads/main` misses the lease and fails this test.
   */
  it('MergeOrchestrate_LeaseKeyShape_MatchesSerializerBareBranch', async () => {
    const arm = await createLeaseArm();
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

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MERGE_LEASE_HELD');
    expect((result.data as { integrationRef?: string }).integrationRef).toBe('main');
    expect(executeMerge).not.toHaveBeenCalled();
  });

  /**
   * The serializer, or a caller that resumes after a crash, passes the
   * operation id of the holder as `leaseOperationId`. The guard matches it and
   * proceeds, although the holder is live.
   */
  it('MergeOrchestrate_MatchingLeaseOperationId_ProceedsThroughGuard', async () => {
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
        leaseOperationId: 'my-own-lease-op',
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

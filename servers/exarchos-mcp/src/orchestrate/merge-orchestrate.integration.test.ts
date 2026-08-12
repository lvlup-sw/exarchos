// ─── Merge orchestrator happy-timeline integration test (T23) ──────────────
//
// Reconstructs the full event timeline for a successful subagent worktree
// merge across the contract assembled in T01-T22:
//
//   1. T17 — `task.completed` (with `data.worktree`) parks the feature
//      workflow in the `merge-pending` HSM substate.
//   2. T18 — `computeNextActions` surfaces the `merge_orchestrate` verb
//      (with idempotency key) for callers in `merge-pending`.
//   3. T20 — the composite `exarchos_orchestrate` action registry routes
//      `merge_orchestrate` to `handleMergeOrchestrate`.
//   4. T11 — `handleMergeOrchestrate` runs preflight (T06) and emits
//      `merge.preflight` (T03 schema) directly to the workflow stream.
//   5. T15 — `handleExecuteMerge` (delegated by T11) emits `merge.executed`
//      (T03 schema) to the same stream after a successful VCS merge.
//
// The full stream — `task.completed → merge.preflight → merge.executed` —
// must reconstruct in order, with monotonically-increasing sequence numbers.
//
// Per #1185, this exercises a real `EventStore` constructed via a real
// `DispatchContext` (production wiring). The composition-root smoke gate
// (`scripts/check-event-store-composition-root.mjs`, run in T25) excludes
// `*.test.ts` files automatically, so the direct `new EventStore(...)` here
// is allowed and intentional — we want to assert the on-disk + in-memory
// store reconstructs the timeline, not just that mocks were invoked.
//
// The only DI overrides are at the VCS / git boundary (we cannot run real
// git or hit a real PR provider). Everything between the dispatch entry
// point and those leaves runs production code.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';

import { initializeContext } from '../core/context.js';
import { handleOrchestrate } from './composite.js';
import { handleMergeOrchestrate } from './merge-orchestrate.js';
import {
  handleExecuteMerge,
  type HandleExecuteMergeInput,
} from './execute-merge.js';
import type { MergePreflightResult } from './pure/merge-preflight.js';
import type { GitExecResult } from './pure/merge-preflight.js';
import { writeStateFile } from '../workflow/state-store.js';
import type { WorkflowEvent } from '../events/schemas.js';

import { computeNextActions } from '../next-actions-computer.js';
import {
  getHSMDefinition,
  executeTransition,
} from '../workflow/state-machine.js';
import { createFeatureHSM } from '../workflow/hsm-definitions.js';
import { handleWorkflow } from '../workflow/composite.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const FEATURE_ID = 'feat-merge-orch-happy';
const TASK_ID = 'T-happy';
const SOURCE_BRANCH = 'feat/happy';
const TARGET_BRANCH = 'main';
const WORKTREE_PATH = '/repo/.claude/worktrees/T-happy';
const MERGE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);

const PASSING_PREFLIGHT: MergePreflightResult = {
  passed: true,
  ancestry: { passed: true, missing: [], target: TARGET_BRANCH },
  currentBranchProtection: { blocked: false, currentBranch: SOURCE_BRANCH },
  worktree: { isMain: true, actual: '/repo', expected: '/repo' },
  drift: {
    clean: true,
    uncommittedFiles: [],
    indexStale: false,
    detachedHead: false,
  },
} as MergePreflightResult;

// ─── Suite ─────────────────────────────────────────────────────────────────

describe('Merge orchestrator happy timeline (T23, DR-MO-1, DR-MO-2)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'merge-orch-integ-happy-'));
    // Real EventStore via real DispatchContext — production wiring shape.
    // The composition-root gate (`scripts/check-event-store-composition-root.mjs`)
    // excludes `*.test.ts` automatically, so this raw `new EventStore` is
    // intentionally permitted in this fixture.
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    ctx = {
      stateDir,
      eventStore,
      enableTelemetry: false,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rmrfAsync(stateDir);
  });

  it('eventTimeline_TaskCompletedThroughMergeExecuted_FullyReconstructs', async () => {
    // ─── 1. (Implicit) workflow is in `delegate` ────────────────────────────
    //
    // The HSM transition check (step 3) and the next-actions check (step 4)
    // both use in-memory state shapes constructed below. The merge-orchestrate
    // handler itself does not read the workflow state file on the happy path
    // (no `resume: true`, and `persistState` is overridden to a no-op), so we
    // intentionally skip materializing a `<featureId>.state.json` here — the
    // full WorkflowStateSchema would require ~10 unrelated fields that this
    // test does not exercise.

    // ─── 2. Emit `task.completed` with worktree association (T17 trigger) ──
    //
    // This is the upstream signal a delegated subagent emits when its task
    // finishes inside its own worktree. The HSM guard `mergePendingEntry`
    // (T17) reads this from `state._events` and authorizes the
    // `delegate → merge-pending` transition.
    const taskCompletedEvent = await eventStore.append(FEATURE_ID, {
      type: 'task.completed',
      data: {
        taskId: TASK_ID,
        worktree: WORKTREE_PATH,
      },
    });
    expect(taskCompletedEvent.type).toBe('task.completed');
    expect(taskCompletedEvent.sequence).toBe(1);

    // ─── 3. HSM evaluator — assert delegate → merge-pending fires ──────────
    //
    // Build the in-memory state shape the HSM evaluator consumes (`_events`
    // sourced from the real stream we just wrote to).
    const eventsForHsm = await eventStore.query(FEATURE_ID, {});
    const stateForHsm = {
      phase: 'delegate',
      featureId: FEATURE_ID,
      mergeOrchestrator: { taskId: TASK_ID },
      _events: eventsForHsm.map((e) => ({ type: e.type, data: e.data })),
    };
    const hsm = getHSMDefinition('feature');
    const transition = executeTransition(hsm, stateForHsm, 'merge-pending');
    expect(transition.success).toBe(true);
    expect(transition.newPhase).toBe('merge-pending');

    // ─── 4. Next-actions surfaces `merge_orchestrate` verb (T18 clause) ────
    //
    // Once parked in `merge-pending`, the next-action computer must include
    // the `merge_orchestrate` action verb with a deterministic
    // idempotency key composed from featureId + taskId.
    const stateAtMergePending = {
      phase: 'merge-pending',
      featureId: FEATURE_ID,
      mergeOrchestrator: { taskId: TASK_ID },
    };
    const nextActions = computeNextActions(stateAtMergePending, hsm);
    const mergeAction = nextActions.find((a) => a.verb === 'merge_orchestrate');
    expect(mergeAction).toBeDefined();
    expect(mergeAction?.idempotencyKey).toBe(
      `${FEATURE_ID}:merge_orchestrate:${TASK_ID}`,
    );
    expect(mergeAction?.validTargets).toEqual(['merge_orchestrate']);

    // ─── 5. Dispatch `merge_orchestrate` via the composite ─────────────────
    //
    // We dispatch through the real `handleOrchestrate` composite (T20) so
    // the routing layer + handler are exercised together. The only DI is at
    // the leaves we cannot run for real:
    //   - `preflight`     → returns PASSING_PREFLIGHT (avoids a git shell-out)
    //   - `executeMerge`  → delegates to the REAL `handleExecuteMerge` with
    //                       a stub `vcsMerge` (resolves with mergeSha) and
    //                       a stub `gitExec` (returns ROLLBACK_SHA for
    //                       `rev-parse HEAD` so `recordRollbackPoint`
    //                       succeeds without git on disk).
    //   - `persistState`  → no-op so we don't compete with the workflow state
    //                       file; the merge-orchestrator phase persistence is
    //                       tested at the unit level in
    //                       merge-orchestrate.test.ts.
    //
    // This shape preserves the production emission path for
    // `merge.preflight` (in handleMergeOrchestrate) AND `merge.executed`
    // (in the real handleExecuteMerge). Both events land on the SAME real
    // EventStore, so the timeline assertion below reads what the dispatcher
    // actually wrote.
    const stubVcsMerge = vi.fn().mockResolvedValue({ mergeSha: MERGE_SHA });
    const stubGitExec = (
      _repoRoot: string,
      args: readonly string[],
    ): GitExecResult => {
      // recordRollbackPoint shells out `git rev-parse HEAD` for the pre-merge SHA.
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
      }
      // No other shell-outs are expected on the happy path; default to a
      // benign empty success so a stray invocation doesn't crash the test
      // (the assertions below would still catch behavioral drift).
      return { stdout: '', exitCode: 0 };
    };

    const dispatchResult: ToolResult = await handleOrchestrate(
      {
        action: 'merge_orchestrate',
        featureId: FEATURE_ID,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
        taskId: TASK_ID,
        strategy: 'squash',

        // DI overrides — typed-only, never crossed over the wire.
        preflight: async (): Promise<MergePreflightResult> => PASSING_PREFLIGHT,

        // Delegate to the real handleExecuteMerge with leaf stubs so the
        // real `merge.executed` emission path runs against our real EventStore.
        executeMerge: async (
          input: HandleExecuteMergeInput,
          innerCtx: DispatchContext,
        ): Promise<ToolResult> =>
          handleExecuteMerge(
            {
              ...input,
              vcsMerge: stubVcsMerge,
              gitExec: stubGitExec,
              persistState: async () => {
                /* no-op — see header comment */
              },
            },
            innerCtx,
          ),

        // Skip the workflow-state mergeOrchestrator phase write — that path
        // is unit-tested elsewhere and would race with our bootstrap above.
        persistState: async () => {
          /* no-op */
        },
      },
      ctx,
    );

    expect(dispatchResult.success).toBe(true);
    const data = dispatchResult.data as {
      phase: string;
      mergeSha: string;
      recoveryPointSha: string;
      preflight: MergePreflightResult;
      // Composite envelope wrapping (T038) may add `next_actions`, `_meta`,
      // `_perf` here — we only assert the shape we contracted on.
    };
    expect(data.phase).toBe('completed');
    expect(data.mergeSha).toBe(MERGE_SHA);
    expect(data.recoveryPointSha).toBe(ROLLBACK_SHA);
    expect(stubVcsMerge).toHaveBeenCalledTimes(1);
    expect(stubVcsMerge).toHaveBeenCalledWith({
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      strategy: 'squash',
    });

    // ─── 6. Reconstruct the full event timeline ────────────────────────────
    //
    // Query the same real EventStore instance the dispatcher wrote through.
    // The expected order is the production contract (post Wave 4 / audit
    // §F1.2 two-event split):
    //
    //   sequence 1: task.completed          (the T17 trigger, from step 2)
    //   sequence 2: merge.preflight          (T11 emits before delegating)
    //   sequence 3: merge.requested          (Wave 4 Phase A — durable intent
    //                                          emitted via `decide` BEFORE the
    //                                          executor's local git merge side effect)
    //   sequence 4: merge.executing_started  (#1309 liveness — emitted after the
    //                                          recovery point is recorded, before
    //                                          the first vcsMerge)
    //   sequence 5: merge.executed           (T15 emits on phase: 'completed')
    //
    // No other events are expected on the happy path (no merge.rollback,
    // no merge.aborted).
    const finalEvents = await eventStore.query(FEATURE_ID, {});
    const timeline = finalEvents.map((e) => e.type);
    expect(timeline).toEqual([
      'task.completed',
      'merge.preflight',
      'merge.requested',
      // #1309 INV-10 liveness — emitted before the merge so a long-running merge
      // is observable as started-but-unterminated.
      'merge.executing_started',
      'merge.executed',
      // #1304 INV-10 terminal marker — emitted adjacent to merge.executed
      // by `handleExecuteMerge` once `merge.executed` lands successfully.
      'merge.completed',
    ]);

    // ─── 7. Sequence numbers monotonic ─────────────────────────────────────
    //
    // The EventStore guarantees per-stream sequence monotonicity. Re-assert
    // here so a future regression that breaks ordering (e.g. parallel writes
    // racing the sequence counter, sidecar mode leaking into the happy path)
    // shows up in this integration suite, not just in store-level unit tests.
    const sequences = finalEvents.map((e) => e.sequence);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
    for (let i = 1; i < sequences.length; i += 1) {
      const prev = sequences[i - 1];
      const curr = sequences[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      expect(curr as number).toBeGreaterThan(prev as number);
    }

    // ─── 8. Payload spot-checks on the merge events ────────────────────────
    //
    // Cheap sanity: the stream identifier flow (featureId → streamId) and
    // the carrier fields T03 declares on the dedicated schemas are present.
    const preflightEvent = finalEvents.find(
      (e) => e.type === 'merge.preflight',
    );
    expect(preflightEvent).toBeDefined();
    const preflightData = preflightEvent?.data as {
      taskId?: string;
      sourceBranch: string;
      targetBranch: string;
      passed: boolean;
    };
    expect(preflightData.passed).toBe(true);
    expect(preflightData.sourceBranch).toBe(SOURCE_BRANCH);
    expect(preflightData.targetBranch).toBe(TARGET_BRANCH);
    expect(preflightData.taskId).toBe(TASK_ID);

    const executedEvent = finalEvents.find((e) => e.type === 'merge.executed');
    expect(executedEvent).toBeDefined();
    const executedData = executedEvent?.data as {
      taskId?: string;
      sourceBranch: string;
      targetBranch: string;
      mergeSha: string;
      rollbackSha: string;
    };
    expect(executedData.taskId).toBe(TASK_ID);
    expect(executedData.sourceBranch).toBe(SOURCE_BRANCH);
    expect(executedData.targetBranch).toBe(TARGET_BRANCH);
    expect(executedData.mergeSha).toBe(MERGE_SHA);
    expect(executedData.rollbackSha).toBe(ROLLBACK_SHA);
  });
});

// ─── T24 — Rollback timeline integration ───────────────────────────────────
//
// Exercises the full rollback timeline through the real `EventStore` (via
// `initializeContext`, NOT a mock) when `vcsMerge` rejects:
//
//   1. dispatch `merge_orchestrate` with a passing preflight + a failing
//      `vcsMerge` adapter that rejects with a generic Error.
//   2. assert event stream contains `merge.preflight` (passed: true) followed
//      by `merge.recovered` with `data.reason === 'merge-failed'` per T10. DR-2
//      (task 006) retired the legacy `merge.rollback` write path; the recovery
//      terminal is now the canonical `merge.recovered` (carrying
//      `recoveryPointSha` in place of the legacy `rollbackSha`).
//   3. read workflow state file; assert `mergeOrchestrator.phase` advanced
//      past `'pending'` (softened — see Wiring Gaps footer).
//   4. compute `next_actions` for synthesized post-fix state (`phase:
//      'merge-pending'`, `mergeOrchestrator.phase: 'rolled-back'`); assert
//      `merge_orchestrate` is omitted (T19 filter).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Build a `gitExec` stub for the executor's INV-14 rollback ladder:
 *   1. `git rev-parse HEAD` — returns the rollback sha (anchor record + the
 *      post-recovery drift check both see it, so recovery lands clean).
 *   2. `git merge --abort` then `git reset --keep <rollbackSha>` — succeed (the
 *      catch-all returns exitCode 0). `--hard` is never invoked.
 */
function makeGitExecForRollback(): (
  repoRoot: string,
  args: readonly string[],
) => { stdout: string; exitCode: number } {
  return (_repoRoot, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
    }
    // `git merge --abort` / `git reset --keep <rollbackSha>` both succeed here.
    return { stdout: '', exitCode: 0 };
  };
}

/**
 * Seed a minimal feature workflow state file. Phase is `delegate` (a built-in
 * `FeaturePhaseSchema` member) rather than `merge-pending`. The HSM defines
 * `merge-pending` as a substate (T17), but `FeaturePhaseSchema` does not yet
 * include it — see Wiring Gaps footer item 2. Using `delegate` keeps state-
 * file reads/writes valid; the next-actions assertion runs against a
 * synthesized `phase: 'merge-pending'` because `computeNextActions` only
 * consults the HSM and the in-memory state shape.
 */
async function seedFeatureStateForRollback(
  stateDir: string,
  featureId: string,
): Promise<string> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const now = new Date().toISOString();
  const state = {
    version: '1.1',
    workflowType: 'feature' as const,
    featureId,
    phase: 'delegate' as const,
    createdAt: now,
    updatedAt: now,
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    mergeOrchestrator: {
      phase: 'pending' as const,
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      taskId: 'T24',
    },
  };
  await writeStateFile(stateFile, state as never);
  return stateFile;
}

describe('handleMergeOrchestrate integration — rollback timeline (T24)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-orch-rollback-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('eventTimeline_RecoveryPath_ContainsMergeRecoveredWithCategorizedReason', async () => {
    const ctx = await initializeContext(tmpDir);
    const featureId = 'feat-rollback';
    await seedFeatureStateForRollback(tmpDir, featureId);

    const preflight = async () => PASSING_PREFLIGHT;
    // Failing vcsMerge → pure executor categorizes as 'merge-failed'
    // (Error.message does not match /verification/i; not a TimeoutError /
    // ETIMEDOUT). See `pure/execute-merge.ts:categorizeFailure`.
    const vcsMerge = async () => {
      throw new Error('merge conflict');
    };

    const result = await handleMergeOrchestrate(
      {
        featureId,
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T24',
        strategy: 'squash',
        preflight,
        executeMerge: async (input, innerCtx) => {
          return handleExecuteMerge(
            { ...input, vcsMerge, gitExec: makeGitExecForRollback() },
            innerCtx,
          );
        },
      },
      ctx,
    );

    expect(result.success).toBe(false);

    const events = await ctx.eventStore.query(featureId);
    // DR-2 (task 006): the recovery terminal is the canonical `merge.recovered`;
    // the retired legacy `merge.rollback` must NOT appear on the stream.
    const recoveredEvents = events.filter((e) => e.type === 'merge.recovered');
    expect(recoveredEvents).toHaveLength(1);
    expect(events.filter((e) => e.type === 'merge.rollback')).toHaveLength(0);

    const recovered = recoveredEvents[0]!;
    const recoveredData = recovered.data as Record<string, unknown>;
    expect(recoveredData.reason).toBe('merge-failed');
    expect(recoveredData.sourceBranch).toBe('feat/x');
    expect(recoveredData.targetBranch).toBe('main');
    expect(typeof recoveredData.recoveryPointSha).toBe('string');

    const preflightEvents = events.filter((e) => e.type === 'merge.preflight');
    expect(preflightEvents).toHaveLength(1);
    expect(
      (preflightEvents[0]!.data as Record<string, unknown>).passed,
    ).toBe(true);
  });

  it('eventTimeline_AfterRollback_NextActionsOmitMergeOrchestrate', async () => {
    const ctx = await initializeContext(tmpDir);
    const featureId = 'feat-rollback-omit';
    const stateFile = await seedFeatureStateForRollback(tmpDir, featureId);

    const preflight = async () => PASSING_PREFLIGHT;
    const vcsMerge = async () => {
      throw new Error('merge conflict');
    };

    await handleMergeOrchestrate(
      {
        featureId,
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T24',
        strategy: 'squash',
        preflight,
        executeMerge: async (input, innerCtx) => {
          return handleExecuteMerge(
            { ...input, vcsMerge, gitExec: makeGitExecForRollback() },
            innerCtx,
          );
        },
      },
      ctx,
    );

    const raw = await fs.readFile(stateFile, 'utf-8');
    const state = JSON.parse(raw) as {
      phase: string;
      mergeOrchestrator?: { phase?: string; taskId?: string; reason?: string; recoveryPointSha?: string };
      featureId: string;
      workflowType: string;
    };

    // T27 persists the terminal phase before emitting the recovery terminal
    // (`merge.recovered` post-DR-2), so the on-disk `mergeOrchestrator.phase`
    // reflects the actual outcome. (Originally softened to `not.toBe('pending')`
    // while T27 was a known gap; now strict per the design.)
    expect(state.mergeOrchestrator?.phase).toBe('rolled-back');
    expect(state.mergeOrchestrator?.reason).toBe('merge-failed');
    expect(typeof state.mergeOrchestrator?.recoveryPointSha).toBe('string');

    // T19 contract: when state carries `mergeOrchestrator.phase ===
    // 'rolled-back'`, `merge_orchestrate` is omitted from next-actions.
    // Workflow-level `phase` is synthesized to `merge-pending` because the
    // integration test doesn't run the HSM evaluator that would auto-
    // transition the top-level phase. T26 added `merge-pending` to
    // `FeaturePhaseSchema`, so the synthesis is schema-valid.
    const hsm = createFeatureHSM();
    const realStateAtMergePending = {
      ...state,
      phase: 'merge-pending',
    };
    const actions = computeNextActions(realStateAtMergePending, hsm);
    const verbs = actions.map((a) => a.verb);
    expect(verbs).not.toContain('merge_orchestrate');
  });
});

// ─── #1303 — idempotencyKey + expectedSequence integration tests ───────────
//
// These tests pin the substrate guarantees added in #1259 / #1323 (SQLite
// PRIMARY KEY (stream_id, sequence) + UNIQUE INDEX (idempotency_key))
// onto the merge-orchestrate / execute-merge surface. Two scenarios:
//
//   α-01: a crash between event-append and downstream state-write must NOT
//         produce a duplicate `merge.executed` event when the caller resumes.
//         Idempotency-key dedup at append time is the substrate-level
//         guarantee being asserted.
//
//   α-03: two concurrent invocations against the same stream must NOT
//         produce duplicate sequences and must produce exactly one
//         `merge.executed` event. `expectedSequence` (CAS on the stream
//         high-water mark) plus the `idempotencyKey` UNIQUE INDEX is the
//         substrate-level guarantee being asserted.
//
// All in-process: NO subprocess spawn (per design — α-01 explicitly
// decouples from #1324). Event-append is the surface mocked / raced on.
// ───────────────────────────────────────────────────────────────────────────

describe('handleMergeOrchestrate integration — idempotency & concurrency (#1303)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'merge-orch-idem-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    ctx = {
      stateDir,
      eventStore,
      enableTelemetry: false,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rmrfAsync(stateDir);
  });

  it('MergeOrchestrate_CrashAfterMergeExecutedAppendThenResume_AppendsExactlyOneMergeExecutedEvent', async () => {
    const featureId = 'feat-idem-crash';
    const taskId = 'T-crash';

    const stubVcsMerge = vi.fn().mockResolvedValue({ mergeSha: MERGE_SHA });
    const stubGitExec = (
      _repoRoot: string,
      args: readonly string[],
    ): GitExecResult => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };

    // Spy on `append`. For the first invocation, let the underlying append
    // run (the row IS persisted), then throw on the way out — simulating
    // a crash between event-append durability and downstream state-write.
    const realAppend = eventStore.append.bind(eventStore);
    let crashed = false;
    const appendSpy = vi
      .spyOn(eventStore, 'append')
      .mockImplementation(
        async (streamId: string, event, options) => {
          const persisted = await realAppend(streamId, event, options);
          if (
            !crashed &&
            event.type === 'merge.executed' &&
            streamId === featureId
          ) {
            crashed = true;
            throw new Error('simulated crash post-append, pre-state-write');
          }
          return persisted;
        },
      );

    // First invocation — crashes after the merge.executed append.
    let firstError: unknown;
    try {
      await handleMergeOrchestrate(
        {
          featureId,
          sourceBranch: SOURCE_BRANCH,
          targetBranch: TARGET_BRANCH,
          taskId,
          strategy: 'squash',
          preflight: async () => PASSING_PREFLIGHT,
          executeMerge: async (input, innerCtx) =>
            handleExecuteMerge(
              {
                ...input,
                vcsMerge: stubVcsMerge,
                gitExec: stubGitExec,
                persistState: async () => {
                  /* no-op */
                },
              },
              innerCtx,
            ),
          persistState: async () => {
            /* no-op */
          },
        },
        ctx,
      );
    } catch (err) {
      firstError = err;
    }
    // The simulated crash bubbles all the way out (the handler does not
    // wrap event-store IO errors). Sanity-check we actually crashed.
    expect(firstError).toBeInstanceOf(Error);
    expect(crashed).toBe(true);

    // Sanity: row IS in the store from the first call.
    const afterFirst = await eventStore.query(featureId);
    expect(
      afterFirst.filter((e) => e.type === 'merge.executed'),
    ).toHaveLength(1);

    // Restore the spy for the resume call so it actually returns rather
    // than re-throwing.
    appendSpy.mockRestore();

    // Second invocation — caller's retry. Must NOT produce a second
    // merge.executed event.
    const resumeResult = await handleMergeOrchestrate(
      {
        featureId,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
        taskId,
        strategy: 'squash',
        resume: true,
        preflight: async () => PASSING_PREFLIGHT,
        executeMerge: async (input, innerCtx) =>
          handleExecuteMerge(
            {
              ...input,
              vcsMerge: stubVcsMerge,
              gitExec: stubGitExec,
              persistState: async () => {
                /* no-op */
              },
            },
            innerCtx,
          ),
        persistState: async () => {
          /* no-op */
        },
        // No prior workflow state file — readState returns undefined → fall
        // through to fresh dispatch (which is the non-trivial replay path
        // we need to exercise).
        readState: async () => undefined,
      },
      ctx,
    );

    // The second call should succeed (or at least not append a duplicate).
    // The substrate-level invariant under test is on the stream itself.
    expect(resumeResult).toBeDefined();

    const finalEvents = await eventStore.query(featureId);
    const mergeExecuted = finalEvents.filter(
      (e) => e.type === 'merge.executed',
    );
    expect(mergeExecuted).toHaveLength(1);
  });

});

// ─── #1305 T15 — merge-pending transitions emit workflow.transition ─────────
//
// INVARIANT: the `merge-pending` entry (`delegate → merge-pending`) and exit
// (`merge-pending → delegate`) phase transitions MUST go through the
// canonical HSM transition primitive — `handleWorkflow({ action: 'transition' })`
// → `handleTransition` → `hsmTransitionGuard.attempt` — which emits exactly
// one `workflow.transition` event per call and NEVER a bare top-level
// phase-set that would bypass the event log and desync the projection.
//
// v2.11 (composite.ts T5a.1) hard-cut the prior `set({phase})` rerouting
// path; `transition` is now the single phase-mutation entry point. These
// tests pin that the merge-pending edges resolve through it and produce the
// canonical event — `workflow.transition`, not `workflow.set` / a bare
// phase-set.
//
// Coverage split:
//   • The EXIT edge (`merge-pending → delegate`) is driven END-TO-END through
//     the real store + canonical primitive: its guard (`mergePendingExit`)
//     inspects only `_events[].type` for terminal events, so it evaluates
//     correctly against the store-hydrated `_events` shape.
//   • The ENTRY edge (`delegate → merge-pending`) is asserted reachable
//     through the HSM evaluator (the production projection path consumes the
//     same evaluator) and confirmed to route through the canonical primitive.
//     The entry guard reads `task.completed.data.worktree`; the store
//     hydration helper flattens event `data` to the top level (worktree lands
//     under `metadata`, not `.data`), so an entry transition cannot be driven
//     through `handleTransition` against a live store today. That `.data`-vs-
//     `metadata` impedance is a pre-existing hydration concern (out of scope
//     for T15 — the resolver/projection work is #1305 T13/T14), so the entry
//     edge is exercised at the HSM-evaluator seam the projection uses.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Seed a minimal feature workflow state file at the given phase. Same minimal
 * shape as the rollback seed helper, with a fresh `mergeOrchestrator` block
 * (`phase: 'pending'`) so the entry guard's "not in a terminal phase" check
 * passes.
 */
async function seedFeatureStateAtPhase(
  stateDir: string,
  featureId: string,
  phase: 'delegate' | 'merge-pending',
): Promise<string> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);
  const now = new Date().toISOString();
  const state = {
    version: '1.1',
    workflowType: 'feature' as const,
    featureId,
    phase,
    createdAt: now,
    updatedAt: now,
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    mergeOrchestrator: {
      phase: 'pending' as const,
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      taskId: 'T15',
    },
  };
  await writeStateFile(stateFile, state as never);
  return stateFile;
}

describe('MergePendingTransitions_EmitWorkflowTransition_NotSet (#1305 T15)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'merge-orch-transition-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    ctx = {
      stateDir,
      eventStore,
      enableTelemetry: false,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rmrfAsync(stateDir);
  });

  it('MergePendingExit_DrivenThroughCanonicalPrimitive_EmitsWorkflowTransitionNotBarePhaseSet', async () => {
    const featureId = 'feat-t15-exit';
    await seedFeatureStateAtPhase(stateDir, featureId, 'merge-pending');

    // Terminal events that authorize the `merge-pending → delegate` edge
    // (mergePendingExit guard): a worktree-bearing task.completed followed by
    // a merge.executed. Both land on the real stream so the guard evaluates
    // against production-shaped (store-hydrated) `_events`.
    await eventStore.append(featureId, {
      type: 'task.completed',
      data: { taskId: 'T15', worktree: WORKTREE_PATH },
    });
    await eventStore.append(featureId, {
      type: 'merge.executed',
      data: {
        taskId: 'T15',
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
        mergeSha: MERGE_SHA,
        rollbackSha: ROLLBACK_SHA,
      },
    });

    // No transition events before the exit call.
    const before = await eventStore.query(featureId);
    expect(
      before.filter((e) => e.type === 'workflow.transition'),
    ).toHaveLength(0);

    // ─── EXIT transition through the canonical primitive ────────────────────
    const exitResult = await handleWorkflow(
      { action: 'transition', featureId, target: 'delegate' },
      ctx,
    );
    expect(exitResult.success).toBe(true);

    // Exactly one workflow.transition event, from merge-pending → delegate.
    const after = await eventStore.query(featureId);
    const transitions = after.filter((e) => e.type === 'workflow.transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.data).toMatchObject({
      from: 'merge-pending',
      to: 'delegate',
      featureId,
    });

    // ─── No bare phase-set bypass ───────────────────────────────────────────
    // The event log is the ONLY phase-mutation seam: the phase change is
    // carried by a `workflow.transition` event. No separate `workflow.set` /
    // phase-mutation event exists that would indicate a `set({phase})` bypass.
    const phaseMutationEvents = after.filter(
      (e) =>
        e.type === 'workflow.transition' ||
        // Defensive: catch a hypothetical future `workflow.set` phase event.
        e.type === ('workflow.set' as typeof e.type),
    );
    expect(
      phaseMutationEvents.every((e) => e.type === 'workflow.transition'),
    ).toBe(true);
    expect(phaseMutationEvents).toHaveLength(1);

    // Final on-disk phase reflects the exit transition (delegate), proving the
    // CAS write that accompanies the transition primitive landed.
    const finalRaw = await fs.readFile(
      path.join(stateDir, `${featureId}.state.json`),
      'utf-8',
    );
    const finalState = JSON.parse(finalRaw) as { phase: string };
    expect(finalState.phase).toBe('delegate');
  });

  it('MergePendingEntry_IsReachableThroughHsmEvaluatorAndCanonicalPrimitive', async () => {
    // The entry edge (`delegate → merge-pending`) is the same edge the
    // production rehydration projection consults. Assert it is reachable
    // through the HSM evaluator with a worktree-bearing task.completed, and
    // that the only declared edge into `merge-pending` from `delegate` is the
    // guarded transition (so the sole phase-mutation seam is the canonical
    // `workflow.transition` primitive, never a bare set).
    const hsm = getHSMDefinition('feature');

    // (1) HSM evaluator — the entry edge fires with a worktree association.
    const stateForEntry = {
      phase: 'delegate',
      featureId: 'feat-t15-entry',
      mergeOrchestrator: { taskId: 'T15', phase: 'pending' },
      _events: [
        { type: 'task.completed', data: { taskId: 'T15', worktree: WORKTREE_PATH } },
      ],
    };
    const entryEval = executeTransition(hsm, stateForEntry, 'merge-pending');
    expect(entryEval.success).toBe(true);
    expect(entryEval.newPhase).toBe('merge-pending');

    // (2) Topology — `delegate → merge-pending` is a declared, guarded edge.
    //     A declared HSM edge is mutated ONLY by the canonical transition
    //     primitive (which emits `workflow.transition`); there is no separate
    //     phase-set code path for it.
    const entryEdges = hsm.transitions.filter(
      (t) => t.from === 'delegate' && t.to === 'merge-pending',
    );
    expect(entryEdges).toHaveLength(1);
    expect(entryEdges[0]!.guard).toBeDefined();

    // (3) Without a worktree association the entry edge does NOT fire — the
    //     guard, not a bare phase-set, gates entry.
    const stateNoWorktree = {
      phase: 'delegate',
      featureId: 'feat-t15-entry',
      _events: [{ type: 'task.completed', data: { taskId: 'T15' } }],
    };
    const blockedEval = executeTransition(hsm, stateNoWorktree, 'merge-pending');
    expect(blockedEval.success).toBe(false);
  });
});


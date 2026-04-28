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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';

import { handleOrchestrate } from './composite.js';
import {
  handleExecuteMerge,
  type HandleExecuteMergeInput,
} from './execute-merge.js';
import type { MergePreflightResult } from './pure/merge-preflight.js';
import type { GitExecResult } from './pure/merge-preflight.js';

import { computeNextActions } from '../next-actions-computer.js';
import {
  getHSMDefinition,
  executeTransition,
} from '../workflow/state-machine.js';

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
    await rm(stateDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
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
        prId: 'PR-23',

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
      rollbackSha: string;
      preflight: MergePreflightResult;
      // Composite envelope wrapping (T038) may add `next_actions`, `_meta`,
      // `_perf` here — we only assert the shape we contracted on.
    };
    expect(data.phase).toBe('completed');
    expect(data.mergeSha).toBe(MERGE_SHA);
    expect(data.rollbackSha).toBe(ROLLBACK_SHA);
    expect(stubVcsMerge).toHaveBeenCalledTimes(1);
    expect(stubVcsMerge).toHaveBeenCalledWith({
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      strategy: 'squash',
    });

    // ─── 6. Reconstruct the full event timeline ────────────────────────────
    //
    // Query the same real EventStore instance the dispatcher wrote through.
    // The expected order is the production contract:
    //
    //   sequence 1: task.completed  (the T17 trigger, from step 2)
    //   sequence 2: merge.preflight (T11 emits before delegating)
    //   sequence 3: merge.executed  (T15 emits on phase: 'completed')
    //
    // No other events are expected on the happy path (no merge.rollback,
    // no merge.aborted).
    const finalEvents = await eventStore.query(FEATURE_ID, {});
    const timeline = finalEvents.map((e) => e.type);
    expect(timeline).toEqual([
      'task.completed',
      'merge.preflight',
      'merge.executed',
    ]);

    // ─── 7. Sequence numbers monotonic ─────────────────────────────────────
    //
    // The EventStore guarantees per-stream sequence monotonicity. Re-assert
    // here so a future regression that breaks ordering (e.g. parallel writes
    // racing the sequence counter, sidecar mode leaking into the happy path)
    // shows up in this integration suite, not just in store-level unit tests.
    const sequences = finalEvents.map((e) => e.sequence);
    expect(sequences).toEqual([1, 2, 3]);
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

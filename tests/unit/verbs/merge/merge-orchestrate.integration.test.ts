// Integration tests for the merge orchestrator through a real `EventStore`.
//
// The happy timeline: a `task.completed` event with `data.worktree` moves the
// feature workflow to the `merge-pending` substate. `computeNextActions` then
// offers the `merge_orchestrate` verb with an idempotency key. The composite
// `exarchos_orchestrate` routes that action to `handleMergeOrchestrate`, which
// runs preflight, appends `merge.preflight`, and commits `merge.requested`.
// `handleExecuteMerge` appends `merge.executing_started` before the VCS merge,
// and `merge.executed` and `merge.completed` after it. The stream must hold the
// events in order, with increasing sequence numbers.
//
// The composition-root gate excludes test files, so a direct `new EventStore`
// is allowed here. Only the VCS and git leaves are stubs. The code between the
// dispatch entry and those leaves is production code.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { ToolResult } from '../../../../src/format.js';

import { initializeContext } from '../../../../src/dispatch/core/context.js';
import { handleOrchestrate } from '../../../../src/verbs/composite.js';
import { handleMergeOrchestrate } from '../../../../src/verbs/merge/merge-orchestrate.js';
import {
  handleExecuteMerge,
  type HandleExecuteMergeInput,
} from '../../../../src/verbs/merge/execute-merge.js';
import type { MergePreflightResult } from '../../../../src/verbs/pure/merge-preflight.js';
import type { GitExecResult } from '../../../../src/verbs/pure/merge-preflight.js';
import { writeStateFile } from '../../../../src/workflow/state-store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';

import { computeNextActions } from '../../../../src/next-actions-computer.js';
import {
  getHSMDefinition,
  executeTransition,
} from '../../../../src/workflow/state-machine.js';
import { createFeatureHSM } from '../../../../src/workflow/hsm-definitions.js';
import { handleWorkflow } from '../../../../src/workflow/composite.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { BYPASS_SECTION_0A } from '../../../helpers/section-0a-bypass.js';

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

describe('Merge orchestrator happy timeline (T23, DR-MO-1, DR-MO-2)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'merge-orch-integ-happy-'));
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

  /**
   * The test builds the HSM and next-actions inputs in memory and writes no state file, because the handler
   * does not read it on this path. It dispatches through the real `handleOrchestrate` composite. The executor
   * stub calls the real `handleExecuteMerge` with stub `vcsMerge` and `gitExec` leaves, so the merge events
   * land in the real store. The `persistState` stubs do nothing, and the unit suite tests that persistence.
   * `merge.executing_started` makes a long merge visible as started but not finished.
   * `merge.completed` is the terminal marker after `merge.executed`.
   */
  it('eventTimeline_TaskCompletedThroughMergeExecuted_FullyReconstructs', async () => {
    const taskCompletedEvent = await eventStore.append(FEATURE_ID, {
      type: 'task.completed',
      data: {
        taskId: TASK_ID,
        worktree: WORKTREE_PATH,
      },
    });
    expect(taskCompletedEvent.type).toBe('task.completed');
    expect(taskCompletedEvent.sequence).toBe(1);

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

    const dispatchResult: ToolResult = await handleOrchestrate(
      {
        action: 'merge_orchestrate',
        featureId: FEATURE_ID,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
        taskId: TASK_ID,
        strategy: 'squash',

        preflight: async (): Promise<MergePreflightResult> => PASSING_PREFLIGHT,

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
              },
            },
            innerCtx,
          ),

        persistState: async () => {
        },
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(dispatchResult.success).toBe(true);
    const data = dispatchResult.data as {
      phase: string;
      mergeSha: string;
      recoveryPointSha: string;
      preflight: MergePreflightResult;
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

    const finalEvents = await eventStore.query(FEATURE_ID, {});
    const timeline = finalEvents.map((e) => e.type);
    expect(timeline).toEqual([
      'task.completed',
      'merge.preflight',
      'merge.requested',
      'merge.executing_started',
      'merge.executed',
      'merge.completed',
    ]);

    const sequences = finalEvents.map((e) => e.sequence);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6]);
    for (let i = 1; i < sequences.length; i += 1) {
      const prev = sequences[i - 1];
      const curr = sequences[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      expect(curr as number).toBeGreaterThan(prev as number);
    }

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

/**
 * A `gitExec` stub for the rollback ladder of the executor. `git rev-parse HEAD` returns the rollback sha,
 * so the anchor record and the drift check after recovery both see it. Every other call succeeds, which
 * covers `git merge --abort` and `git reset --keep <rollbackSha>`.
 */
function makeGitExecForRollback(): (
  repoRoot: string,
  args: readonly string[],
) => { stdout: string; exitCode: number } {
  return (_repoRoot, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: `${ROLLBACK_SHA}\n`, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  };
}

/** Seeds a minimal feature workflow state file in the `delegate` phase, with a `pending` merge orchestrator. */
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

/**
 * The rollback timeline through a real store from `initializeContext`, with a `vcsMerge` that rejects.
 * The stream holds a passed `merge.preflight` and one `merge.recovered` with reason `merge-failed`, and no `merge.rollback`.
 */
describe('handleMergeOrchestrate integration — rollback timeline (T24)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-orch-rollback-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /** A plain `Error` is not a timeout and does not name verification, so `categorizeFailure` gives `merge-failed`. */
  it('eventTimeline_RecoveryPath_ContainsMergeRecoveredWithCategorizedReason', async () => {
    const ctx = await initializeContext(tmpDir);
    const featureId = 'feat-rollback';
    await seedFeatureStateForRollback(tmpDir, featureId);

    const preflight = async () => PASSING_PREFLIGHT;
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
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(result.success).toBe(false);

    const events = await ctx.eventStore.query(featureId);
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

  /**
   * The executor appends `merge.recovered` and then writes `rolled-back` to the state file.
   * With `mergeOrchestrator.phase` at `rolled-back`, next actions omit `merge_orchestrate`.
   * The test does not run the HSM evaluator, so it sets the workflow `phase` to `merge-pending` itself.
   */
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
        gitExec: BYPASS_SECTION_0A,
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

    expect(state.mergeOrchestrator?.phase).toBe('rolled-back');
    expect(state.mergeOrchestrator?.reason).toBe('merge-failed');
    expect(typeof state.mergeOrchestrator?.recoveryPointSha).toBe('string');

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

/**
 * A crash between the `merge.executed` append and the next state write must not give a second
 * `merge.executed` event when the caller resumes. The test runs in process and mocks the event append.
 */
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

  /**
   * The `append` spy persists the first `merge.executed` row and then throws, as a crash before the state write.
   * The handler does not wrap event-store errors, so the crash reaches the caller.
   * The resume call has no prior state file, so `readState` returns undefined and the handler dispatches again.
   */
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
                },
              },
              innerCtx,
            ),
          persistState: async () => {
          },
          gitExec: BYPASS_SECTION_0A,
        },
        ctx,
      );
    } catch (err) {
      firstError = err;
    }
    expect(firstError).toBeInstanceOf(Error);
    expect(crashed).toBe(true);

    const afterFirst = await eventStore.query(featureId);
    expect(
      afterFirst.filter((e) => e.type === 'merge.executed'),
    ).toHaveLength(1);

    appendSpy.mockRestore();

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
              },
            },
            innerCtx,
          ),
        persistState: async () => {
        },
        readState: async () => undefined,
        gitExec: BYPASS_SECTION_0A,
      },
      ctx,
    );

    expect(resumeResult).toBeDefined();

    const finalEvents = await eventStore.query(featureId);
    const mergeExecuted = finalEvents.filter(
      (e) => e.type === 'merge.executed',
    );
    expect(mergeExecuted).toHaveLength(1);
  });

});

/**
 * Seeds a minimal feature workflow state file at `phase`. The `pending` merge orchestrator passes the
 * terminal-phase check of the entry guard.
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

/**
 * The `merge-pending` entry and exit transitions must go through `handleWorkflow({ action: 'transition' })`.
 * That path emits one `workflow.transition` event per call and never a bare phase set that skips the event log.
 * The exit guard reads only the `type` of each event in `_events`, so the exit edge runs end to end on the real store.
 * The entry guard reads `task.completed.data.worktree`, but store hydration puts the worktree under `metadata`.
 * So the test checks the entry edge at the HSM evaluator, which the projection also uses.
 */
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

  /**
   * A `task.completed` with a worktree, then a `merge.executed`, authorize the exit edge.
   * The exit gives one `workflow.transition` event and no `workflow.set` event, and the state file shows `delegate`.
   */
  it('MergePendingExit_DrivenThroughCanonicalPrimitive_EmitsWorkflowTransitionNotBarePhaseSet', async () => {
    const featureId = 'feat-t15-exit';
    await seedFeatureStateAtPhase(stateDir, featureId, 'merge-pending');

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

    const before = await eventStore.query(featureId);
    expect(
      before.filter((e) => e.type === 'workflow.transition'),
    ).toHaveLength(0);

    const exitResult = await handleWorkflow(
      { action: 'transition', featureId, target: 'delegate' },
      ctx,
    );
    expect(exitResult.success).toBe(true);

    const after = await eventStore.query(featureId);
    const transitions = after.filter((e) => e.type === 'workflow.transition');
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.data).toMatchObject({
      from: 'merge-pending',
      to: 'delegate',
      featureId,
    });

    const phaseMutationEvents = after.filter(
      (e) =>
        e.type === 'workflow.transition' ||
        e.type === ('workflow.set' as typeof e.type),
    );
    expect(
      phaseMutationEvents.every((e) => e.type === 'workflow.transition'),
    ).toBe(true);
    expect(phaseMutationEvents).toHaveLength(1);

    const finalRaw = await fs.readFile(
      path.join(stateDir, `${featureId}.state.json`),
      'utf-8',
    );
    const finalState = JSON.parse(finalRaw) as { phase: string };
    expect(finalState.phase).toBe('delegate');
  });

  /**
   * The entry edge fires in the HSM evaluator when `task.completed` carries a worktree.
   * `delegate → merge-pending` is one declared, guarded edge, and without a worktree the guard blocks it.
   */
  it('MergePendingEntry_IsReachableThroughHsmEvaluatorAndCanonicalPrimitive', async () => {
    const hsm = getHSMDefinition('feature');

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

    const entryEdges = hsm.transitions.filter(
      (t) => t.from === 'delegate' && t.to === 'merge-pending',
    );
    expect(entryEdges).toHaveLength(1);
    expect(entryEdges[0]!.guard).toBeDefined();

    const stateNoWorktree = {
      phase: 'delegate',
      featureId: 'feat-t15-entry',
      _events: [{ type: 'task.completed', data: { taskId: 'T15' } }],
    };
    const blockedEval = executeTransition(hsm, stateNoWorktree, 'merge-pending');
    expect(blockedEval.success).toBe(false);
  });
});


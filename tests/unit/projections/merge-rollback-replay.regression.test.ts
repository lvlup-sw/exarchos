/**
 * Replay regression for the retired `merge.rollback` event.
 * `src/verbs/merge/execute-merge.ts` appends only `merge.recovered`, but the data schema of `merge.rollback` stays.
 * An old log with `merge.rollback` must still fold to its recovery state in three reducers.
 * They are `workflowStateProjection`, the rehydration reducer and the `merge-orchestrator@v1` reducer.
 * The HSM `merge-pending-exit` guard must also accept the event.
 * `merge.recovered` must fold to the same recovery state in each of those sites.
 */

import { describe, it, expect } from 'vitest';

import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { MergeRollbackData, MergeRecoveredData } from '../../../src/events/schemas.js';
import { workflowStateProjection } from '../../../src/projections/views/workflow-state-projection.js';
import { rehydrationReducer } from '../../../src/projections/rehydration/reducer.js';
import { mergeOrchestratorReducer } from '../../../src/projections/merge-orchestrator/reducer.js';
import { getHSMDefinition, executeTransition } from '../../../src/workflow/state-machine.js';

const FEATURE_ID = 'feat-replay';
const TASK_ID = 'T1';
const SOURCE_BRANCH = 'feat/x';
const TARGET_BRANCH = 'main';
/**
 * One sha serves as the `rollbackSha` of the old event and the `recoveryPointSha` of the new event.
 * The workflow-state view maps `recoveryPointSha` to `rollbackSha`, so the two events fold to the same value.
 */
const RECOVERY_SHA = 'a'.repeat(40);
const REASON = 'merge-failed' as const;

function makeEvent(
  type: string,
  data: Record<string, unknown>,
  sequence: number,
): WorkflowEvent {
  return {
    streamId: FEATURE_ID,
    sequence,
    timestamp: '2026-07-16T00:00:00.000Z',
    type,
    schemaVersion: '1.0',
    data,
  } as WorkflowEvent;
}

/** The payload of the retired `merge.rollback` event, as old recovery streams hold it. */
const LEGACY_ROLLBACK_DATA = {
  taskId: TASK_ID,
  sourceBranch: SOURCE_BRANCH,
  targetBranch: TARGET_BRANCH,
  rollbackSha: RECOVERY_SHA,
  reason: REASON,
};

/** The payload of `merge.recovered`, the recovery event that writers append. */
const CANONICAL_RECOVERED_DATA = {
  taskId: TASK_ID,
  sourceBranch: SOURCE_BRANCH,
  targetBranch: TARGET_BRANCH,
  recoveryPointSha: RECOVERY_SHA,
  reason: REASON,
};

interface FoldedRecoveryState {
  /** workflow-state-projection `mergeOrchestrator` block. */
  readonly view: Record<string, unknown> | undefined;
  /** rehydration reducer `workflowState.phase`. */
  readonly rehydratePhase: string;
  /** rehydration reducer `workflowState.mergeOrchestrator`. */
  readonly rehydrateOrchestrator: unknown;
  /** merge-orchestrator@v1 projection phase. */
  readonly orchestratorPhase: string;
  /** merge-orchestrator@v1 recovery reason. */
  readonly orchestratorReason: string | undefined;
  /** HSM merge-pending → delegate transition succeeded. */
  readonly hsmExitSucceeded: boolean;
  /** HSM resulting phase after the exit transition. */
  readonly hsmNewPhase: string | undefined;
}

/**
 * Folds a recovery event through the three reducers and the HSM `merge-pending-exit` guard, and returns the observable state.
 * Each site gets the context that it needs. The workflow-state view folds the event from `init()`.
 * The rehydration reducer first folds a `task.completed` event with a worktree, which creates the `pending` merge state.
 * The `merge-orchestrator@v1` reducer starts from `executed`.
 * The guard gets the recovery event after the latest `task.completed` event.
 */
function foldRecoveryTerminal(
  terminalType: 'merge.rollback' | 'merge.recovered',
  terminalData: Record<string, unknown>,
): FoldedRecoveryState {
  const terminal = makeEvent(terminalType, terminalData, 5);

  let view = workflowStateProjection.init();
  view = workflowStateProjection.apply(view, terminal);

  let rehydrate = rehydrationReducer.apply(
    rehydrationReducer.initial,
    makeEvent('workflow.started', { featureId: FEATURE_ID, workflowType: 'feature' }, 0),
  );
  rehydrate = rehydrationReducer.apply(
    rehydrate,
    makeEvent('workflow.transition', { from: '', to: 'delegate' }, 1),
  );
  rehydrate = rehydrationReducer.apply(
    rehydrate,
    makeEvent('task.completed', { taskId: TASK_ID, worktree: '.wt/T1' }, 2),
  );
  rehydrate = rehydrationReducer.apply(rehydrate, terminal);

  let orchestrator = mergeOrchestratorReducer.apply(
    mergeOrchestratorReducer.initial,
    makeEvent(
      'merge.executed',
      {
        taskId: TASK_ID,
        sourceBranch: SOURCE_BRANCH,
        targetBranch: TARGET_BRANCH,
        mergeSha: 'b'.repeat(40),
        rollbackSha: RECOVERY_SHA,
      },
      4,
    ),
  );
  orchestrator = mergeOrchestratorReducer.apply(orchestrator, terminal);

  const hsm = getHSMDefinition('feature');
  const hsmState = {
    phase: 'merge-pending',
    _events: [
      { type: 'task.completed', data: { taskId: TASK_ID, worktree: '.wt/T1' } },
      { type: terminalType, data: terminalData },
    ],
  };
  const hsmResult = executeTransition(hsm, hsmState, 'delegate');

  return {
    view: view.mergeOrchestrator as Record<string, unknown> | undefined,
    rehydratePhase: rehydrate.workflowState.phase,
    rehydrateOrchestrator: rehydrate.workflowState.mergeOrchestrator,
    orchestratorPhase: orchestrator.phase,
    orchestratorReason: orchestrator.recovery?.reason,
    hsmExitSucceeded: hsmResult.success,
    hsmNewPhase: hsmResult.newPhase,
  };
}

describe('merge.rollback replay-safety (DR-2, task 006)', () => {
  /** The old payload still parses against the kept `MergeRollbackData` schema, and each of the four sites folds it to the recovery state. */
  it('replayFixture_LegacyRollbackEvents_FoldsToIdenticalWorkflowState', () => {
    expect(MergeRollbackData.safeParse(LEGACY_ROLLBACK_DATA).success).toBe(true);

    const folded = foldRecoveryTerminal('merge.rollback', LEGACY_ROLLBACK_DATA);

    expect(folded.view).toEqual({
      phase: 'rolled-back',
      taskId: TASK_ID,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      rollbackSha: RECOVERY_SHA,
      reason: REASON,
    });

    expect(folded.rehydratePhase).toBe('delegate');
    expect(folded.rehydrateOrchestrator).toEqual({
      taskId: TASK_ID,
      phase: 'rolled-back',
    });

    expect(folded.orchestratorPhase).toBe('recovering');
    expect(folded.orchestratorReason).toBe(REASON);

    expect(folded.hsmExitSucceeded).toBe(true);
    expect(folded.hsmNewPhase).toBe('delegate');
  });

  /**
   * `merge.recovered` validates and folds to the same observable state as `merge.rollback` in each site.
   * The two payloads share the sha, and a clean recovery has no error detail.
   */
  it('replayFixture_ModernRecoveredEvents_FoldsToSameStateAsLegacyRollback', () => {
    expect(MergeRecoveredData.safeParse(CANONICAL_RECOVERED_DATA).success).toBe(true);

    const legacy = foldRecoveryTerminal('merge.rollback', LEGACY_ROLLBACK_DATA);
    const modern = foldRecoveryTerminal('merge.recovered', CANONICAL_RECOVERED_DATA);

    expect(modern.view).toEqual(legacy.view);
    expect(modern.rehydratePhase).toBe(legacy.rehydratePhase);
    expect(modern.rehydrateOrchestrator).toEqual(legacy.rehydrateOrchestrator);
    expect(modern.orchestratorPhase).toBe(legacy.orchestratorPhase);
    expect(modern.orchestratorReason).toBe(legacy.orchestratorReason);
    expect(modern.hsmExitSucceeded).toBe(legacy.hsmExitSucceeded);
    expect(modern.hsmNewPhase).toBe(legacy.hsmNewPhase);

    expect(modern.rehydrateOrchestrator).toEqual({
      taskId: TASK_ID,
      phase: 'rolled-back',
    });
    expect(modern.orchestratorPhase).toBe('recovering');
    expect(modern.hsmNewPhase).toBe('delegate');
  });
});

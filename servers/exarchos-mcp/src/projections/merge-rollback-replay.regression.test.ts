/**
 * DR-2 (task 006) — merge.rollback replay-safety regression.
 *
 * The `merge.rollback` WRITE path is RETIRED (`orchestrate/execute-merge.ts` now
 * emits only the canonical `merge.recovered`), but the READ path is KEPT
 * (its data schema + type-map entry survive). This suite is the INV-1 replay
 * proof: a legacy event log that ALREADY contains `merge.rollback` must still
 * fold to the SAME workflow state across ALL THREE folding reducers —
 *   1. `workflowStateProjection` (views/workflow-state-projection.ts),
 *   2. the rehydration reducer (projections/rehydration/reducer.ts),
 *   3. the `merge-orchestrator@v1` reducer (projections/merge-orchestrator/reducer.ts),
 * AND the HSM `merge-pending-exit` guard must behave identically —
 * as it did before the write path was retired.
 *
 * It ALSO proves forward-equivalence: the canonical `merge.recovered` successor
 * folds to the SAME observable recovery state in every one of those sites, so
 * retiring the legacy write path is a behavioural no-op for the live path while
 * remaining replay-safe for old streams.
 */

import { describe, it, expect } from 'vitest';

import type { WorkflowEvent } from '../event-store/schemas.js';
import { MergeRollbackData, MergeRecoveredData } from '../event-store/schemas.js';
import { workflowStateProjection } from '../views/workflow-state-projection.js';
import { rehydrationReducer } from './rehydration/reducer.js';
import { mergeOrchestratorReducer } from './merge-orchestrator/reducer.js';
import { getHSMDefinition, executeTransition } from '../workflow/state-machine.js';

// ─── Shared fixture facts ────────────────────────────────────────────────────

const FEATURE_ID = 'feat-replay';
const TASK_ID = 'T1';
const SOURCE_BRANCH = 'feat/x';
const TARGET_BRANCH = 'main';
// The SAME sha is used as the legacy `rollbackSha` and the canonical
// `recoveryPointSha` so the two events fold to a byte-identical `rollbackSha`
// in the workflow-state view (the projection maps recoveryPointSha → rollbackSha).
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

/** Legacy terminal event payload (pre-DR-2 recovery streams carry this). */
const LEGACY_ROLLBACK_DATA = {
  taskId: TASK_ID,
  sourceBranch: SOURCE_BRANCH,
  targetBranch: TARGET_BRANCH,
  rollbackSha: RECOVERY_SHA,
  reason: REASON,
};

/** Canonical successor payload (post-DR-2 recovery streams carry this). */
const CANONICAL_RECOVERED_DATA = {
  taskId: TASK_ID,
  sourceBranch: SOURCE_BRANCH,
  targetBranch: TARGET_BRANCH,
  recoveryPointSha: RECOVERY_SHA,
  reason: REASON,
};

// ─── Cross-reducer fold helper ───────────────────────────────────────────────

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
 * Fold a recovery-terminal event (`merge.rollback` OR `merge.recovered`) through
 * all three reducers plus the HSM merge-pending-exit guard, each supplied with
 * the realistic preceding context that reducer requires, and return the
 * observable recovery state.
 */
function foldRecoveryTerminal(
  terminalType: 'merge.rollback' | 'merge.recovered',
  terminalData: Record<string, unknown>,
): FoldedRecoveryState {
  const terminal = makeEvent(terminalType, terminalData, 5);

  // 1) workflow-state-projection — the merge.* case fully determines the
  //    `mergeOrchestrator` block, so fold the terminal from init().
  let view = workflowStateProjection.init();
  view = workflowStateProjection.apply(view, terminal);

  // 2) rehydration reducer — needs a worktree-bearing task.completed to create
  //    the `pending` mergeOrchestrator that the terminal event then exits.
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

  // 3) merge-orchestrator@v1 — the recovery transition fires from an `executed`
  //    state (mirrors the reducer's own suite: executed → recovering).
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

  // 4) HSM merge-pending-exit guard — the terminal event after the latest
  //    task.completed must satisfy the merge-pending → delegate transition.
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('merge.rollback replay-safety (DR-2, task 006)', () => {
  it('replayFixture_LegacyRollbackEvents_FoldsToIdenticalWorkflowState', () => {
    // READ tolerance intact: the legacy payload still parses against the KEPT
    // data schema (nothing was deleted from the read path).
    expect(MergeRollbackData.safeParse(LEGACY_ROLLBACK_DATA).success).toBe(true);

    const folded = foldRecoveryTerminal('merge.rollback', LEGACY_ROLLBACK_DATA);

    // 1) workflow-state-projection folds the legacy event to the rolled-back
    //    block — the exact shape the pre-DR-2 code produced.
    expect(folded.view).toEqual({
      phase: 'rolled-back',
      taskId: TASK_ID,
      sourceBranch: SOURCE_BRANCH,
      targetBranch: TARGET_BRANCH,
      rollbackSha: RECOVERY_SHA,
      reason: REASON,
    });

    // 2) rehydration reducer reverts to delegate + stamps rolled-back.
    expect(folded.rehydratePhase).toBe('delegate');
    expect(folded.rehydrateOrchestrator).toEqual({
      taskId: TASK_ID,
      phase: 'rolled-back',
    });

    // 3) merge-orchestrator@v1 advances to recovering with the captured reason.
    expect(folded.orchestratorPhase).toBe('recovering');
    expect(folded.orchestratorReason).toBe(REASON);

    // 4) HSM merge-pending-exit guard fires: merge-pending → delegate.
    expect(folded.hsmExitSucceeded).toBe(true);
    expect(folded.hsmNewPhase).toBe('delegate');
  });

  it('replayFixture_ModernRecoveredEvents_FoldsToSameStateAsLegacyRollback', () => {
    // Forward-equivalence: the canonical successor still validates and folds to
    // the SAME observable recovery state across every site — so retiring the
    // legacy write path is behaviour-preserving on the live path.
    expect(MergeRecoveredData.safeParse(CANONICAL_RECOVERED_DATA).success).toBe(true);

    const legacy = foldRecoveryTerminal('merge.rollback', LEGACY_ROLLBACK_DATA);
    const modern = foldRecoveryTerminal('merge.recovered', CANONICAL_RECOVERED_DATA);

    // Every folded observable is identical between the legacy and canonical
    // terminals (the SHA is shared and clean-recovery carries no error detail).
    expect(modern.view).toEqual(legacy.view);
    expect(modern.rehydratePhase).toBe(legacy.rehydratePhase);
    expect(modern.rehydrateOrchestrator).toEqual(legacy.rehydrateOrchestrator);
    expect(modern.orchestratorPhase).toBe(legacy.orchestratorPhase);
    expect(modern.orchestratorReason).toBe(legacy.orchestratorReason);
    expect(modern.hsmExitSucceeded).toBe(legacy.hsmExitSucceeded);
    expect(modern.hsmNewPhase).toBe(legacy.hsmNewPhase);

    // ...and both reach the concrete rolled-back/recovering terminal.
    expect(modern.rehydrateOrchestrator).toEqual({
      taskId: TASK_ID,
      phase: 'rolled-back',
    });
    expect(modern.orchestratorPhase).toBe('recovering');
    expect(modern.hsmNewPhase).toBe('delegate');
  });
});

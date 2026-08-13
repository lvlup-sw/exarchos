import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from './reducer.js';
import { RehydrationDocumentSchema } from './schema.js';
import type { WorkflowEvent } from '../../events/schemas.js';

/**
 * Helper — build a minimal, schema-coherent WorkflowEvent. Only the fields the
 * reducer inspects (`type`, `data`) are load-bearing; the rest satisfy the
 * `WorkflowEventBase` shape so tests read naturally.
 */
function makeEvent<T extends Record<string, unknown>>(
  type: string,
  data: T,
  sequence: number,
): WorkflowEvent {
  return {
    streamId: 'wf-test',
    sequence,
    timestamp: '2026-04-24T00:00:00.000Z',
    type,
    schemaVersion: '1.0',
    data,
  } as WorkflowEvent;
}

/**
 * Helper — produce a rehydration document seeded as a feature workflow
 * already in `delegate` phase. Used by detour tests so they exercise the
 * realistic precondition (the detour gate post-#1208-rev requires
 * workflowType='feature' AND phase ∈ {delegate, merge-pending}).
 */
function featureInDelegate(featureId = 'wf-test') {
  let s = rehydrationReducer.apply(
    rehydrationReducer.initial,
    makeEvent('workflow.started', { featureId, workflowType: 'feature' }, 0),
  );
  s = rehydrationReducer.apply(
    s,
    makeEvent('workflow.transition', { from: '', to: 'delegate' }, 1),
  );
  return s;
}

describe('rehydration reducer — initial state (T022, DR-3)', () => {
  it('Rehydration_NoEvents_ReturnsV3InitialDocument', () => {
    // GIVEN: no events
    // WHEN: we read rehydrationReducer.initial
    const initial = rehydrationReducer.initial;

    // THEN: the initial document parses cleanly via RehydrationDocumentSchema
    // (v:3) and round-trips back to itself.
    expect(RehydrationDocumentSchema.parse(initial)).toEqual(initial);

    // AND: the versioned envelope carries v === 4 and projectionSequence === 0.
    // Bumped to v:4 in #1359 / PR4 T12 for the canonical task-status
    // vocabulary contract change.
    expect(initial.v).toBe(4);
    expect(initial.projectionSequence).toBe(0);

    // AND: volatile sections are empty containers
    expect(initial.taskProgress).toEqual([]);
    expect(initial.decisions).toEqual([]);
    expect(initial.artifacts).toEqual({});
    expect(initial.blockers).toEqual([]);
    expect(initial.nextAction).toBeUndefined();

    // AND: phasePlaybook is null (v:3 nullable contract — null until T-20
    // populates it live at handler time; not undefined so consumers can
    // distinguish "no playbook" from "field absent").
    expect(initial.phasePlaybook).toBeNull();

    // AND: stable sections carry minimal defaults (strings, possibly empty)
    // Note: behavioralGuidance is NOT present in v:3 (dropped as vestigial).
    expect(typeof initial.workflowState.featureId).toBe('string');
    expect(typeof initial.workflowState.phase).toBe('string');
    expect(typeof initial.workflowState.workflowType).toBe('string');

    // AND: handoff sliding window starts empty
    expect(initial.recentHandoffs).toEqual([]);
    expect(initial.latestHandoff).toBeUndefined();
  });

  it('Rehydration_ReducerIdentity_IsCanonical', () => {
    // The canonical id convention (see types.ts docstring and registry.test.ts
    // "duplicate projection id: rehydration@v1") is `rehydration@v1`.
    expect(rehydrationReducer.id).toBe('rehydration@v1');
    expect(rehydrationReducer.version).toBe(1);
  });

  it('Rehydration_ApplyUnknownEvent_ReturnsStateUnchanged', () => {
    // GIVEN: the initial state and an arbitrary (unhandled) workflow event
    const state = rehydrationReducer.initial;
    // A minimal WorkflowEvent-shaped object; the skeleton reducer in T022 does
    // not interpret any event types yet — it returns state as-is. Later tasks
    // (T023–T025) wire specific event handlers.
    const unknownEvent = {
      type: 'unknown.event.type',
      workflowId: 'wf-test',
      sequence: 1,
      timestamp: '2026-04-24T00:00:00.000Z',
      source: 'model',
      data: {},
    } as unknown as Parameters<typeof rehydrationReducer.apply>[1];

    // WHEN: we fold the event through apply()
    const next = rehydrationReducer.apply(state, unknownEvent);

    // THEN: state is returned unchanged (structural equality — skeleton)
    expect(next).toBe(state);
  });
});

describe('rehydration reducer — task events fold (T023, DR-3)', () => {
  it('Rehydration_Given_TaskStartedCompleted_When_Fold_Then_ProgressShows1Of1', () => {
    // GIVEN: the initial state
    const initial = rehydrationReducer.initial;

    // AND: the canonical "task begins" event per event-store schemas is
    // `task.assigned` (see EVENT_DATA_SCHEMAS → TaskAssignedData), followed by
    // `task.completed` carrying the same `taskId`.
    const assigned = makeEvent('task.assigned', { taskId: '001', title: 'T001' }, 1);
    const completed = makeEvent('task.completed', { taskId: '001' }, 2);

    // WHEN: we fold both events through apply()
    const afterAssigned = rehydrationReducer.apply(initial, assigned);
    const afterCompleted = rehydrationReducer.apply(afterAssigned, completed);

    // THEN: taskProgress contains exactly one entry for task 001 with a
    // terminal "complete" status (canonical vocabulary post #1359 / PR4).
    expect(afterCompleted.taskProgress).toHaveLength(1);
    expect(afterCompleted.taskProgress[0]).toMatchObject({
      id: '001',
      status: 'complete',
    });

    // AND: projectionSequence was incremented once per handled event.
    expect(afterCompleted.projectionSequence).toBe(2);

    // AND: the resulting document still conforms to RehydrationDocumentSchema.
    expect(RehydrationDocumentSchema.safeParse(afterCompleted).success).toBe(true);

    // AND: purity — the initial state was not mutated.
    expect(initial.taskProgress).toEqual([]);
    expect(initial.projectionSequence).toBe(0);
  });

  it('Rehydration_Given_TaskFailed_When_Fold_Then_ProgressShowsFailed', () => {
    // GIVEN: the initial state with an assigned task
    const initial = rehydrationReducer.initial;
    const assigned = makeEvent('task.assigned', { taskId: '002', title: 'T002' }, 1);
    const afterAssigned = rehydrationReducer.apply(initial, assigned);

    // WHEN: the task fails
    const failed = makeEvent(
      'task.failed',
      { taskId: '002', error: 'baseline failed' },
      2,
    );
    const next = rehydrationReducer.apply(afterAssigned, failed);

    // THEN: the taskProgress entry reflects the "failed" terminal status.
    expect(next.taskProgress).toHaveLength(1);
    expect(next.taskProgress[0]).toMatchObject({
      id: '002',
      status: 'failed',
    });
    expect(next.projectionSequence).toBe(2);
  });

  it('Rehydration_Given_DuplicateTaskCompleted_When_Fold_Then_ProgressIdempotent', () => {
    // GIVEN: a state with one task already completed
    const initial = rehydrationReducer.initial;
    const completed = makeEvent('task.completed', { taskId: '003' }, 1);
    const afterFirst = rehydrationReducer.apply(initial, completed);

    // WHEN: the same completion event is folded again
    const afterSecond = rehydrationReducer.apply(afterFirst, completed);

    // THEN: there is still exactly one entry for task 003 (no duplicate).
    expect(afterSecond.taskProgress).toHaveLength(1);
    expect(afterSecond.taskProgress[0]).toMatchObject({
      id: '003',
      status: 'complete',
    });
  });
});

describe('rehydration reducer — workflow events fold (T024, DR-3)', () => {
  it('Rehydration_Given_WorkflowStarted_When_Fold_Then_WorkflowStatePopulated', () => {
    // GIVEN: the initial state
    const initial = rehydrationReducer.initial;

    // AND: a `workflow.started` event whose data matches the registered
    // `WorkflowStartedData` schema — carrying a `featureId` and a
    // `workflowType`. Note: the registered schema does NOT carry a `phase`
    // field (only `workflow.transition` does), so the "starting phase" of the
    // workflow remains the projection's initial string default (`''`) until a
    // subsequent `workflow.transition` event advances it.
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-42', workflowType: 'axiom' },
      1,
    );

    // WHEN: we fold the event through apply()
    const next = rehydrationReducer.apply(initial, started);

    // THEN: the stable workflowState prefix reflects the new feature + type.
    expect(next.workflowState.featureId).toBe('feat-42');
    expect(next.workflowState.workflowType).toBe('axiom');
    // AND: phase remains the initial default — no phase field on the event.
    expect(next.workflowState.phase).toBe('');

    // AND: projectionSequence was incremented once for this handled event.
    expect(next.projectionSequence).toBe(1);

    // AND: the resulting document still conforms to RehydrationDocumentSchema.
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);

    // AND: purity — initial state was not mutated.
    expect(initial.workflowState.featureId).toBe('');
    expect(initial.workflowState.workflowType).toBe('');
    expect(initial.projectionSequence).toBe(0);
  });

  it('Rehydration_Given_WorkflowTransition_When_Fold_Then_PhaseAdvances', () => {
    // GIVEN: state after a `workflow.started` event
    const initial = rehydrationReducer.initial;
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-42', workflowType: 'axiom' },
      1,
    );
    const afterStarted = rehydrationReducer.apply(initial, started);

    // WHEN: we fold a `workflow.transition` event whose `to` field is the
    // target phase (per the registered `WorkflowTransitionData` schema).
    const transition = makeEvent(
      'workflow.transition',
      {
        from: 'baseline',
        to: 'design',
        trigger: 'designComplete',
        featureId: 'feat-42',
      },
      2,
    );
    const next = rehydrationReducer.apply(afterStarted, transition);

    // THEN: phase advances to the `to` value from the event.
    expect(next.workflowState.phase).toBe('design');
    // AND: featureId and workflowType are preserved from the prior state.
    expect(next.workflowState.featureId).toBe('feat-42');
    expect(next.workflowState.workflowType).toBe('axiom');
    // AND: projectionSequence was incremented once per handled event.
    expect(next.projectionSequence).toBe(2);
    // AND: the resulting document still conforms to RehydrationDocumentSchema.
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });
});

describe('rehydration reducer — artifacts fold (T025, DR-3)', () => {
  // The plan references `workflow.set` as the artifacts source, but that event
  // type is NOT registered in the event-store. Artifacts are in fact recorded
  // via `state.patched` events whose `data.patch.artifacts` record mirrors the
  // workflow state's `ArtifactsSchema` (design, plan, pr, …). See
  // `src/workflow/tools.ts` (~L759) where
  // `exarchos_workflow set` appends `state.patched { data: { patch } }`.
  it('Rehydration_Given_StatePatchedWithArtifacts_When_Fold_Then_ArtifactsPopulated', () => {
    // GIVEN: initial state
    const initial = rehydrationReducer.initial;

    // AND: a `state.patched` event carrying an `artifacts` subtree in its patch.
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['artifacts'],
        patch: {
          artifacts: {
            design: 'docs/designs/2026-04-23-rehydrate-foundation.md',
            plan: 'docs/plans/2026-04-23-rehydrate-foundation.md',
          },
        },
      },
      1,
    );

    // WHEN: we fold the event
    const next = rehydrationReducer.apply(initial, patched);

    // THEN: artifacts keys are populated
    expect(next.artifacts).toMatchObject({
      design: 'docs/designs/2026-04-23-rehydrate-foundation.md',
      plan: 'docs/plans/2026-04-23-rehydrate-foundation.md',
    });
    // AND: projectionSequence was incremented
    expect(next.projectionSequence).toBe(1);
    // AND: the document still conforms to the schema
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
    // AND: purity — initial was not mutated
    expect(initial.artifacts).toEqual({});
  });

  it('Rehydration_Given_StatePatchedArtifactsTwice_When_Fold_Then_KeysMergedLastWins', () => {
    // GIVEN: a state with an initial `design` artifact
    const initial = rehydrationReducer.initial;
    const first = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['artifacts'],
        patch: { artifacts: { design: 'old-design.md' } },
      },
      1,
    );
    const afterFirst = rehydrationReducer.apply(initial, first);

    // WHEN: a second patch both overwrites `design` and adds `plan`
    const second = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['artifacts'],
        patch: { artifacts: { design: 'new-design.md', plan: 'plan.md' } },
      },
      2,
    );
    const next = rehydrationReducer.apply(afterFirst, second);

    // THEN: both keys are present, design is overwritten, plan is added
    expect(next.artifacts).toEqual({
      design: 'new-design.md',
      plan: 'plan.md',
    });
    expect(next.projectionSequence).toBe(2);
  });

  it('Rehydration_Given_StatePatchedWithoutArtifacts_When_Fold_Then_Unchanged', () => {
    // GIVEN: initial state
    const initial = rehydrationReducer.initial;
    // WHEN: a `state.patched` without an artifacts subtree is folded
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['tasks'],
        patch: { tasks: [] },
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, patched);
    // THEN: artifacts and projectionSequence are unchanged (no-op)
    expect(next.artifacts).toEqual({});
    expect(next.projectionSequence).toBe(0);
    expect(next).toBe(initial);
  });

  it('Rehydration_Given_StatePatchedArtifactsWithNullEntry_When_Fold_Then_OtherKeysFolded', () => {
    // GIVEN: initial state with no prior artifacts
    const initial = rehydrationReducer.initial;
    // AND: a patch carrying a null artifact alongside a real entry. Null is
    // the workflow-side "clear this artifact" signal (ArtifactsSchema is
    // `string | null`); since `design` is not in state yet, the unset is a
    // no-op and only `plan` materialises in the fold.
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-42',
        fields: ['artifacts'],
        patch: { artifacts: { design: null, plan: 'plan.md' } },
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, patched);
    expect(next.artifacts).toEqual({ plan: 'plan.md' });
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Rehydration_Given_StatePatchedArtifactsNullForExistingKey_When_Fold_Then_KeyDeleted', () => {
    // GIVEN: state already carrying a `design` artifact (from an earlier
    // `state.patched`).
    const initial = rehydrationReducer.initial;
    const seeded = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-99',
          fields: ['artifacts'],
          patch: { artifacts: { design: 'design.md', plan: 'plan.md' } },
        },
        1,
      ),
    );
    expect(seeded.artifacts).toEqual({
      design: 'design.md',
      plan: 'plan.md',
    });

    // WHEN: a later `state.patched` clears `design` with `null`.
    const cleared = rehydrationReducer.apply(
      seeded,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-99',
          fields: ['artifacts'],
          patch: { artifacts: { design: null } },
        },
        2,
      ),
    );

    // THEN: the cleared key is removed from the projection (otherwise
    // downstream `rehydrate`/checkpoint paths would keep returning the
    // stale design path forever — see CodeRabbit review on #1178).
    expect(cleared.artifacts).toEqual({ plan: 'plan.md' });
    expect(cleared.projectionSequence).toBe(seeded.projectionSequence + 1);
    expect(RehydrationDocumentSchema.safeParse(cleared).success).toBe(true);
  });

  it('Rehydration_Given_StatePatchedArtifactsAllUnactionable_When_Fold_Then_NoOp', () => {
    // Non-null, non-string values (objects, arrays, undefined, '') carry no
    // unambiguous "set" or "clear" signal, so the entire patch is treated
    // as a no-op — projectionSequence must NOT bump.
    const initial = rehydrationReducer.initial;
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-77',
        fields: ['artifacts'],
        patch: {
          artifacts: { nested: { x: 1 }, list: [1, 2], empty: '' },
        },
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, patched);
    expect(next).toBe(initial);
    expect(next.projectionSequence).toBe(0);
  });
});

describe('rehydration reducer — blockers fold (T025, DR-3)', () => {
  // The plan references `task.blocked` and `review.failed` as sources. Neither
  // event type is registered. The nearest registered events that capture a
  // blocking condition are:
  //   - `review.completed` with `verdict === 'blocked'` (per ReviewCompletedData)
  //   - `review.escalated` (any occurrence — escalation is inherently a blocker)
  //   - `workflow.guard-failed` (a guard rejection blocks a transition)
  // We fold these three into `blockers`.
  it('Rehydration_Given_ReviewCompletedBlocked_When_Fold_Then_BlockerAppended', () => {
    // GIVEN: initial state
    const initial = rehydrationReducer.initial;
    // AND: a `review.completed` event with a `blocked` verdict
    const reviewed = makeEvent(
      'review.completed',
      {
        stage: 'quality-review',
        verdict: 'blocked',
        findingsCount: 2,
        summary: 'Blocking: missing ADR for new public API',
      },
      1,
    );
    // WHEN: we fold the event
    const next = rehydrationReducer.apply(initial, reviewed);
    // THEN: a blocker entry is appended
    expect(next.blockers).toHaveLength(1);
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Rehydration_Given_ReviewCompletedPass_When_Fold_Then_NoBlockerAdded', () => {
    // GIVEN: initial state
    const initial = rehydrationReducer.initial;
    // AND: a `review.completed` event with a `pass` verdict
    const reviewed = makeEvent(
      'review.completed',
      {
        stage: 'spec-review',
        verdict: 'pass',
        findingsCount: 0,
        summary: 'all good',
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, reviewed);
    // THEN: no blockers appended — pass verdicts are not blockers
    expect(next.blockers).toEqual([]);
    // AND: the event is not handled — projectionSequence stays at 0
    expect(next.projectionSequence).toBe(0);
    expect(next).toBe(initial);
  });

  it('Rehydration_Given_ReviewEscalated_When_Fold_Then_BlockerAppended', () => {
    // GIVEN: initial state
    const initial = rehydrationReducer.initial;
    // AND: a `review.escalated` event (per ReviewEscalatedData)
    const escalated = makeEvent(
      'review.escalated',
      {
        pr: 7,
        reason: 'critical security finding',
        originalScore: 0.3,
        triggeringFinding: 'hardcoded secret',
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, escalated);
    expect(next.blockers).toHaveLength(1);
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Rehydration_Given_WorkflowGuardFailed_When_Fold_Then_BlockerAppended', () => {
    // GIVEN: initial state
    const initial = rehydrationReducer.initial;
    // AND: a `workflow.guard-failed` event (per WorkflowGuardFailedData)
    const guard = makeEvent(
      'workflow.guard-failed',
      {
        guard: 'designApproved',
        from: 'design',
        to: 'plan',
        featureId: 'feat-42',
      },
      1,
    );
    const next = rehydrationReducer.apply(initial, guard);
    expect(next.blockers).toHaveLength(1);
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });
});

// Decisions — no decision-producing event type is registered in the
// event-store (no `decision.*` namespace, and `state.patched` does not surface
// a canonical decisions subtree). Per the task spec, this sub-test is skipped
// and the gap is documented in the completion report. If a decisions event
// type is added later (e.g. `decision.recorded`), a follow-up task should
// extend the reducer.
describe.skip('rehydration reducer — decisions fold (T025, DR-3) — SKIPPED: no registered event source', () => {
  it.skip('no registered event currently produces decisions', () => {
    // placeholder
  });
});

// ─── Fix 2 (T2.1) — state.patched.tasks fold ─────────────────────────────────
//
// Issue #1179: rehydration drops pending tasks. The reducer previously folded
// only the `artifacts` subtree of `state.patched`, ignoring `tasks`. Pending
// tasks (those declared in state.json by the planner but not yet emitted as
// `task.assigned`) were therefore invisible in the rehydration document, so
// agents resuming a delegate phase saw only the in-flight subset.
//
// Contract: `state.patched.patch.tasks` carries the planner's full task list
// (each entry has `id`, `title`, `status`). The reducer must seed taskProgress
// from this list, then let subsequent dedicated `task.*` events override the
// status. Status-aware upsert: events win over plan-state for the same id.
// ─── #1359 / PR4 T11 — canonical task-progress vocabulary ───────────────────
//
// Pre-#1359 the reducer renamed `'complete' → 'completed'` and
// `'in_progress' → 'assigned'`. That divergence from canonical
// `TaskSchema.status` (`pending|in_progress|complete|failed`) meant a
// rehydrate consumer comparing `byId.get(taskId) === 'complete'` against
// canonical state would never match — and the outcome test at
// `tests/outcome/rehydrate-projection-drift.test.ts` stayed RED.
describe('rehydration reducer — canonical vocabulary (#1359 / PR4)', () => {
  it('RehydrationReducer_StatePatchedCompleteTask_SurfacesCanonicalCompleteVocabulary', () => {
    // GIVEN: a `state.patched` event whose `patch.tasks` declares T001 as
    // `'complete'` (canonical TaskSchema vocabulary).
    const initial = rehydrationReducer.initial;
    const patched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-1359',
        fields: ['tasks'],
        patch: {
          tasks: [{ id: 'T001', title: 'first', status: 'complete' }],
        },
      },
      1,
    );

    // WHEN: we fold the event
    const next = rehydrationReducer.apply(initial, patched);

    // THEN: taskProgress surfaces canonical `'complete'` — NOT `'completed'`.
    // Pre-fix this assertion failed because `extractPlanTasks` mapped
    // `'complete' → 'completed'`.
    expect(next.taskProgress[0]?.status).toBe('complete');
    expect(next.taskProgress[0]?.id).toBe('T001');
  });
});

describe('rehydration reducer — state.patched.tasks fold (Fix 2 / #1179)', () => {
  it('Rehydration_StatePatchedTasksWithMixedStatuses_FoldsAllAndAppliesEventOverrides', () => {
    // GIVEN: initial state plus a `workflow.started` event
    const initial = rehydrationReducer.initial;
    const started = makeEvent(
      'workflow.started',
      { featureId: 'feat-1179', workflowType: 'feature' },
      1,
    );
    const afterStarted = rehydrationReducer.apply(initial, started);

    // AND: a `state.patched` event whose patch.tasks declares 5 pending tasks
    // — the canonical TaskSchema status enum is `pending|in_progress|complete|failed`
    // (see workflow/schemas.ts:155). Note the reducer translates these into
    // taskProgress entries (which use a separate but compatible status string).
    const planPatched = makeEvent(
      'state.patched',
      {
        featureId: 'feat-1179',
        fields: ['tasks'],
        patch: {
          tasks: [
            { id: 'T1', title: 'Task 1', status: 'pending' },
            { id: 'T2', title: 'Task 2', status: 'pending' },
            { id: 'T3', title: 'Task 3', status: 'pending' },
            { id: 'T4', title: 'Task 4', status: 'pending' },
            { id: 'T5', title: 'Task 5', status: 'pending' },
          ],
        },
      },
      2,
    );
    const afterPlan = rehydrationReducer.apply(afterStarted, planPatched);

    // AND: dedicated task events for a subset (1 assigned, 2 completed, 1 failed)
    const assignedT1 = makeEvent('task.assigned', { taskId: 'T1', title: 'Task 1' }, 3);
    const completedT2 = makeEvent('task.completed', { taskId: 'T2' }, 4);
    const completedT3 = makeEvent('task.completed', { taskId: 'T3' }, 5);
    const failedT4 = makeEvent('task.failed', { taskId: 'T4', error: 'boom' }, 6);

    let next = rehydrationReducer.apply(afterPlan, assignedT1);
    next = rehydrationReducer.apply(next, completedT2);
    next = rehydrationReducer.apply(next, completedT3);
    next = rehydrationReducer.apply(next, failedT4);

    // THEN: taskProgress contains all 5 tasks (NOT just the ones with events).
    // Pre-fix this returns 4 (the event-derived entries only); post-fix it
    // returns 5 because pending tasks are seeded from state.patched.patch.tasks.
    expect(next.taskProgress).toHaveLength(5);

    // AND: the per-task status reflects event overrides where present, and
    // falls back to the planner-declared "pending" otherwise. Canonical
    // vocabulary post #1359 / PR4 T11: `in_progress` / `complete` / `failed`.
    const byId = new Map(next.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('T1')).toBe('in_progress');
    expect(byId.get('T2')).toBe('complete');
    expect(byId.get('T3')).toBe('complete');
    expect(byId.get('T4')).toBe('failed');
    expect(byId.get('T5')).toBe('pending');

    // AND: the count of complete entries matches the events that fired.
    const completed = next.taskProgress.filter((t) => t.status === 'complete');
    expect(completed).toHaveLength(2);

    // AND: the resulting document still conforms to the schema.
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Rehydration_PlanNarrowedByRevision_RetractsDroppedPendingTasks', () => {
    // GIVEN: a plan-review revision narrows the plan — the planner stamps
    // 4 tasks, then re-stamps only 2. This is the counted plan-review
    // revision edge the HSM explicitly supports, so a narrowed plan is a
    // normal outcome, not a corruption.
    const initial = rehydrationReducer.initial;
    const widePlan = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-narrow',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'T1', title: 'kept', status: 'pending' },
              { id: 'T2', title: 'kept', status: 'pending' },
              { id: 'T3', title: 'dropped by revision', status: 'pending' },
              { id: 'T4', title: 'dropped by revision', status: 'pending' },
            ],
          },
        },
        1,
      ),
    );
    expect(widePlan.taskProgress).toHaveLength(4);

    const narrowPlan = rehydrationReducer.apply(
      widePlan,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-narrow',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'T1', title: 'kept', status: 'pending' },
              { id: 'T2', title: 'kept', status: 'pending' },
            ],
          },
        },
        2,
      ),
    );

    // THEN: the dropped ids are retracted rather than wedged in as
    // permanent pending ghosts. Pre-fix this returned 4 — the fold could
    // only append, so every id ever declared accumulated forever and the
    // document reported the high-water union of all plan revisions.
    expect(narrowPlan.taskProgress).toHaveLength(2);
    expect(narrowPlan.taskProgress.map((t) => t.id).sort()).toEqual(['T1', 'T2']);

    // AND: the resulting document still conforms to the schema.
    expect(RehydrationDocumentSchema.safeParse(narrowPlan).success).toBe(true);
  });

  it('Rehydration_PlanDropsTaskCarryingLifecycleEvidence_RetainsIt', () => {
    // GIVEN: a plan of 3 tasks where one is in flight and one has completed
    const initial = rehydrationReducer.initial;
    const plan = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-evidence',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'KEEP', title: 'stays in plan', status: 'pending' },
              { id: 'WORKED', title: 'dropped while in flight', status: 'pending' },
              { id: 'DONE', title: 'dropped after completing', status: 'pending' },
              { id: 'GHOST', title: 'dropped untouched', status: 'pending' },
            ],
          },
        },
        1,
      ),
    );
    let next = rehydrationReducer.apply(
      plan,
      makeEvent('task.assigned', { taskId: 'WORKED', title: 'w' }, 2),
    );
    next = rehydrationReducer.apply(next, makeEvent('task.completed', { taskId: 'DONE' }, 3));

    // WHEN: a revision drops all three of WORKED / DONE / GHOST
    const narrowed = rehydrationReducer.apply(
      next,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-evidence',
          fields: ['tasks'],
          patch: { tasks: [{ id: 'KEEP', title: 'stays in plan', status: 'pending' }] },
        },
        4,
      ),
    );

    // THEN: only the untouched pending ghost is retracted. Entries carrying
    // lifecycle evidence are retained even though the plan dropped them —
    // real work exists against them, and a plan that drops in-flight or
    // completed work is an anomaly a human should see rather than one the
    // projection silently erases.
    const byId = new Map(narrowed.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('KEEP')).toBe('pending');
    expect(byId.get('WORKED')).toBe('in_progress');
    expect(byId.get('DONE')).toBe('complete');
    expect(byId.has('GHOST')).toBe(false);
    expect(narrowed.taskProgress).toHaveLength(3);

    // AND: the resulting document still conforms to the schema.
    expect(RehydrationDocumentSchema.safeParse(narrowed).success).toBe(true);
  });

  it('Rehydration_StatePatchedWithoutTasksSubtree_LeavesTaskProgressIntact', () => {
    // GIVEN: a stamped plan
    const initial = rehydrationReducer.initial;
    const plan = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-artifacts-only',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'T1', title: 'a', status: 'pending' },
              { id: 'T2', title: 'b', status: 'pending' },
            ],
          },
        },
        1,
      ),
    );

    // WHEN: a later state.patched carries only `artifacts` and no `tasks`
    // subtree — the two subtrees are independent contributions.
    const artifactsOnly = rehydrationReducer.apply(
      plan,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-artifacts-only',
          fields: ['artifacts'],
          patch: { artifacts: { pr: 'https://example.test/pr/1' } },
        },
        2,
      ),
    );

    // THEN: retraction does NOT fire — an absent `tasks` subtree asserts
    // nothing about membership, so it must not be read as "the plan is now
    // empty". Without this, any artifacts-only patch would wipe the plan.
    expect(artifactsOnly.taskProgress).toHaveLength(2);
    expect(artifactsOnly.artifacts['pr']).toBe('https://example.test/pr/1');

    // AND: the resulting document still conforms to the schema.
    expect(RehydrationDocumentSchema.safeParse(artifactsOnly).success).toBe(true);
  });

  it('Rehydration_StatePatchedTasksFollowedByPlanReexpansion_DoesNotResurrectCompleted', () => {
    // GIVEN: a plan was patched and one task completed
    const initial = rehydrationReducer.initial;
    const firstPlan = rehydrationReducer.apply(
      initial,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-x',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'A', title: 'A', status: 'pending' },
              { id: 'B', title: 'B', status: 'pending' },
            ],
          },
        },
        1,
      ),
    );
    const afterCompletion = rehydrationReducer.apply(
      firstPlan,
      makeEvent('task.completed', { taskId: 'A' }, 2),
    );
    expect(
      afterCompletion.taskProgress.find((t) => t.id === 'A')?.status,
    ).toBe('complete');

    // AND: a later task.failed event for B
    const afterFailure = rehydrationReducer.apply(
      afterCompletion,
      makeEvent('task.failed', { taskId: 'B', error: 'boom' }, 3),
    );
    expect(
      afterFailure.taskProgress.find((t) => t.id === 'B')?.status,
    ).toBe('failed');

    // WHEN: a later state.patched re-asserts the same plan (this happens when
    // the planner stamps `tasks` again on a later set call). The patch still
    // marks A and B as `pending` because state.json's TaskSchema is plan-state,
    // not execution-state. The reducer must NOT regress A back to `pending`
    // (completed) or B back to `pending` (failed) — events are authoritative
    // for execution status.
    const secondPlan = rehydrationReducer.apply(
      afterFailure,
      makeEvent(
        'state.patched',
        {
          featureId: 'feat-x',
          fields: ['tasks'],
          patch: {
            tasks: [
              { id: 'A', title: 'A', status: 'pending' },
              { id: 'B', title: 'B', status: 'pending' },
              { id: 'C', title: 'C', status: 'pending' },
            ],
          },
        },
        4,
      ),
    );

    // THEN: A stays complete, B stays failed, C is added pending.
    // Canonical vocabulary post #1359 / PR4 T11.
    const byId = new Map(secondPlan.taskProgress.map((t) => [t.id, t.status]));
    expect(byId.get('A')).toBe('complete');
    expect(byId.get('B')).toBe('failed');
    expect(byId.get('C')).toBe('pending');
    expect(secondPlan.taskProgress).toHaveLength(3);
  });
});

// ─── Worktree-bearing task.completed auto-detour (#1208 / DR-MO-1) ──────────
//
// `content/delivery/skills/delegate/SKILL.md` § "Worktree-Bearing Tasks: Auto-Detour to
// merge-pending" specifies that a `task.completed` event carrying
// `data.worktree` or `data.worktreePath` must drive the workflow into the
// `merge-pending` substate so the rehydration envelope can surface a
// `merge_orchestrate` verb. Pre-fix the reducer ignored worktree fields and
// the substate was never observable from rehydration.
describe('rehydration reducer — worktree auto-detour (#1208)', () => {
  it('Rehydration_TaskCompletedWithWorktreePath_StampsMergePending', () => {
    const seeded = featureInDelegate();
    const completed = makeEvent(
      'task.completed',
      { taskId: '001', worktreePath: '/tmp/wt/001' },
      2,
    );
    const next = rehydrationReducer.apply(seeded, completed);

    expect(next.workflowState.phase).toBe('merge-pending');
    expect(next.workflowState.mergeOrchestrator).toEqual({
      taskId: '001',
      phase: 'pending',
    });
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Rehydration_TaskCompletedWithWorktree_StampsMergePending', () => {
    const seeded = featureInDelegate();
    const completed = makeEvent(
      'task.completed',
      { taskId: '002', worktree: '.worktrees/002' },
      2,
    );
    const next = rehydrationReducer.apply(seeded, completed);

    expect(next.workflowState.phase).toBe('merge-pending');
    expect(next.workflowState.mergeOrchestrator).toEqual({
      taskId: '002',
      phase: 'pending',
    });
  });

  it('Rehydration_TaskCompletedNoWorktree_LeavesPhaseUntouched', () => {
    const seeded = featureInDelegate();
    const completed = makeEvent('task.completed', { taskId: '003' }, 2);
    const next = rehydrationReducer.apply(seeded, completed);

    // No worktree association, no detour — phase stays in `delegate`.
    expect(next.workflowState.phase).toBe('delegate');
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
  });

  it('Rehydration_TaskCompletedWithWorktreeOnRefactorWorkflow_DoesNotDetour', () => {
    // Coderabbit P2-saga: refactor / debug / oneshot / discovery streams
    // do NOT have `merge-pending` in their HSM, so a worktree-bearing
    // task.completed on a non-feature workflow must leave phase untouched.
    let s = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeEvent(
        'workflow.started',
        { featureId: 'rf-1', workflowType: 'refactor' },
        0,
      ),
    );
    s = rehydrationReducer.apply(
      s,
      makeEvent('workflow.transition', { from: '', to: 'delegate' }, 1),
    );
    const next = rehydrationReducer.apply(
      s,
      makeEvent('task.completed', { taskId: 'r1', worktree: '.wt/r1' }, 2),
    );
    expect(next.workflowState.phase).toBe('delegate');
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
  });

  it('Rehydration_TaskCompletedWithWorktreeFeatureOutsideDelegate_DoesNotDetour', () => {
    // Even on a feature workflow, the detour must not fire from a phase
    // outside `delegate` / `merge-pending`. A task.completed during e.g.
    // `synthesize` would otherwise rewrite phase to merge-pending and
    // confuse downstream HSM consumers.
    let s = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeEvent(
        'workflow.started',
        { featureId: 'feat-out', workflowType: 'feature' },
        0,
      ),
    );
    s = rehydrationReducer.apply(
      s,
      makeEvent('workflow.transition', { from: '', to: 'synthesize' }, 1),
    );
    const next = rehydrationReducer.apply(
      s,
      makeEvent('task.completed', { taskId: 'fo', worktree: '.wt/fo' }, 2),
    );
    expect(next.workflowState.phase).toBe('synthesize');
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
  });

  it('Rehydration_MergeExecuted_RevertsPhaseAndStampsTerminal', () => {
    const seeded = featureInDelegate();
    const stampedPending = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '004', worktree: '.wt/004' }, 2),
    );
    const afterMerge = rehydrationReducer.apply(
      stampedPending,
      makeEvent('merge.executed', { taskId: '004', mergeSha: 'abc' }, 3),
    );

    expect(afterMerge.workflowState.phase).toBe('delegate');
    expect(afterMerge.workflowState.mergeOrchestrator).toEqual({
      taskId: '004',
      phase: 'completed',
    });
  });

  it('Rehydration_MergeRollback_RevertsPhaseAndStampsRolledBack', () => {
    const seeded = featureInDelegate();
    const stamped = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '005', worktree: '.wt/005' }, 2),
    );
    const after = rehydrationReducer.apply(
      stamped,
      makeEvent('merge.rollback', { taskId: '005', reason: 'preflight' }, 3),
    );

    expect(after.workflowState.phase).toBe('delegate');
    expect(after.workflowState.mergeOrchestrator?.phase).toBe('rolled-back');
  });

  it('Rehydration_MergeAborted_RevertsPhaseAndStampsAborted', () => {
    const seeded = featureInDelegate();
    const stamped = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '006', worktree: '.wt/006' }, 2),
    );
    const after = rehydrationReducer.apply(
      stamped,
      makeEvent('merge.aborted', { taskId: '006', reason: 'manual' }, 3),
    );

    expect(after.workflowState.phase).toBe('delegate');
    expect(after.workflowState.mergeOrchestrator?.phase).toBe('aborted');
  });

  it('Rehydration_MergeTerminalEventWithoutPriorPending_NoOps', () => {
    // Replay over a partial stream where the merge.* event has no preceding
    // worktree task.completed must not fabricate a mergeOrchestrator entry.
    const seeded = featureInDelegate();
    const next = rehydrationReducer.apply(
      seeded,
      makeEvent('merge.executed', { taskId: '007', mergeSha: 'def' }, 2),
    );
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
    // projectionSequence reflects the seed (started + transition) only — the
    // merge.executed handler returned identity since there was nothing to
    // terminate.
    expect(next.projectionSequence).toBe(seeded.projectionSequence);
  });

  it('Rehydration_TaskCompletedWithWhitespaceWorktree_DoesNotDetour', () => {
    // Sentry HIGH: a whitespace-only `worktree` value is not a real
    // association; predicate must reject it. Without the trim, the rehydration
    // projection would diverge from the HSM guard's predicate, causing live
    // state and rehydrated state to disagree on whether merge-pending fired.
    const seeded = featureInDelegate();
    const completed = makeEvent(
      'task.completed',
      { taskId: 'ws', worktree: '   ' },
      2,
    );
    const next = rehydrationReducer.apply(seeded, completed);
    expect(next.workflowState.phase).toBe('delegate');
    expect(next.workflowState.mergeOrchestrator).toBeUndefined();
  });

  it('Rehydration_TaskCompletedWithDifferentTaskActivePending_DoesNotClobberMergeOrchestrator', () => {
    // Coderabbit P2-saga: when an active pending merge exists for task A and
    // a worktree-bearing task.completed arrives for task B, the existing
    // pending mergeOrchestrator MUST be preserved. Clobbering it would let a
    // subsequent merge.executed / merge.rollback fire against the wrong
    // taskId in applyMergeTerminalEvent.
    const seeded = featureInDelegate();
    const stampedA = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: 'A', worktree: '.wt/A' }, 2),
    );
    expect(stampedA.workflowState.mergeOrchestrator).toEqual({
      taskId: 'A',
      phase: 'pending',
    });

    const afterB = rehydrationReducer.apply(
      stampedA,
      makeEvent('task.completed', { taskId: 'B', worktree: '.wt/B' }, 3),
    );
    // mergeOrchestrator must still point at A, not B.
    expect(afterB.workflowState.mergeOrchestrator).toEqual({
      taskId: 'A',
      phase: 'pending',
    });
    expect(afterB.workflowState.phase).toBe('merge-pending');
    // taskProgress folds B regardless — only the orchestrator stamp is
    // protected from clobber.
    expect(afterB.taskProgress.find((t) => t.id === 'B')?.status).toBe(
      'complete',
    );
  });

  it('Rehydration_TaskCompletedAfterTerminalForOtherTask_StampsForNewTask', () => {
    // Companion to the previous test: once the prior task's merge has
    // terminated, a new worktree-bearing task.completed MUST be allowed to
    // (re)stamp mergeOrchestrator for the new task. Without this, a
    // multi-task feature workflow would deadlock at the first completed
    // merge.
    const seeded = featureInDelegate();
    const stampedA = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: 'A', worktree: '.wt/A' }, 2),
    );
    const mergedA = rehydrationReducer.apply(
      stampedA,
      makeEvent('merge.executed', { taskId: 'A', mergeSha: 'sha-A' }, 3),
    );
    expect(mergedA.workflowState.mergeOrchestrator?.phase).toBe('completed');
    expect(mergedA.workflowState.phase).toBe('delegate');

    // Task B's worktree-bearing completion lands AFTER A's terminal event.
    const afterB = rehydrationReducer.apply(
      mergedA,
      makeEvent('task.completed', { taskId: 'B', worktree: '.wt/B' }, 4),
    );
    expect(afterB.workflowState.mergeOrchestrator).toEqual({
      taskId: 'B',
      phase: 'pending',
    });
    expect(afterB.workflowState.phase).toBe('merge-pending');
  });

  it('Rehydration_RefoldedTerminalMergeEvent_IsNoOp', () => {
    // Sentry LOW: a duplicate merge.* event at the SAME taskId + terminalPhase
    // must not bump projectionSequence — that would diverge replay count from
    // truth-of-events count and produce phantom mutations for snapshot cadence
    // and fingerprint comparisons.
    const seeded = featureInDelegate();
    const stamped = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '009', worktree: '.wt/009' }, 2),
    );
    const merged = rehydrationReducer.apply(
      stamped,
      makeEvent('merge.executed', { taskId: '009', mergeSha: 'abc' }, 3),
    );
    const beforeSequence = merged.projectionSequence;

    // Re-apply the SAME merge.executed (replay scenario or duplicate emission).
    const refolded = rehydrationReducer.apply(
      merged,
      makeEvent('merge.executed', { taskId: '009', mergeSha: 'abc' }, 4),
    );
    expect(refolded.projectionSequence).toBe(beforeSequence);
    expect(refolded.workflowState.mergeOrchestrator?.phase).toBe('completed');
  });

  it('Rehydration_RefoldedSameTaskCompleted_DoesNotRegressTerminalMerge', () => {
    // Idempotency: when replay re-applies a worktree task.completed AFTER the
    // merge has already terminated, the terminal mergeOrchestrator phase must
    // not regress to `pending` (otherwise next_actions would re-surface
    // merge_orchestrate after a successful merge).
    const seeded = featureInDelegate();
    const stamped = rehydrationReducer.apply(
      seeded,
      makeEvent('task.completed', { taskId: '008', worktree: '.wt/008' }, 2),
    );
    const merged = rehydrationReducer.apply(
      stamped,
      makeEvent('merge.executed', { taskId: '008', mergeSha: 'sha' }, 3),
    );
    // Re-apply the same worktree task.completed (replay scenario).
    const refolded = rehydrationReducer.apply(
      merged,
      makeEvent('task.completed', { taskId: '008', worktree: '.wt/008' }, 4),
    );
    expect(refolded.workflowState.phase).toBe('delegate');
    expect(refolded.workflowState.mergeOrchestrator?.phase).toBe('completed');
  });
});

describe('rehydration reducer — workflow.checkpoint handoff fold (T2 / #1240 / #1246)', () => {
  /**
   * Helper — build a synthetic `workflow.checkpoint` event with a `handoff`
   * sub-payload. Matches the registered `WorkflowCheckpointData` shape: the
   * envelope carries `counter`, `phase`, `featureId` (load-bearing for the
   * event-store schema) plus the optional `handoff` payload (#1240) the
   * reducer projects into `latestHandoff` / `recentHandoffs`.
   */
  function makeCheckpoint(
    sequence: number,
    handoff: {
      context?: string;
      nextSteps?: string[];
      suggestions?: string[];
    } | undefined,
    overrides: { phase?: string; counter?: number; timestamp?: string } = {},
  ): WorkflowEvent {
    const phase = overrides.phase ?? 'design';
    const counter = overrides.counter ?? sequence;
    const data: Record<string, unknown> = {
      counter,
      phase,
      featureId: 'wf-test',
    };
    if (handoff !== undefined) {
      data['handoff'] = handoff;
    }
    const evt: WorkflowEvent = {
      streamId: 'wf-test',
      sequence,
      timestamp: overrides.timestamp ?? `2026-05-08T00:00:0${sequence % 10}.000Z`,
      type: 'workflow.checkpoint',
      schemaVersion: '1.0',
      data,
    } as WorkflowEvent;
    return evt;
  }

  it('applyWorkflowCheckpoint_NonEmptyHandoff_SetsLatestHandoff', () => {
    // GIVEN: the initial state
    const initial = rehydrationReducer.initial;

    // AND: a workflow.checkpoint event with a non-empty handoff payload
    const evt = makeCheckpoint(
      7,
      {
        context: 'design phase wrapping up',
        nextSteps: ['run typecheck', 'open PR'],
        suggestions: ['re-read CLAUDE.md'],
      },
      { timestamp: '2026-05-08T12:34:56.000Z' },
    );

    // WHEN: we fold the event through apply()
    const next = rehydrationReducer.apply(initial, evt);

    // THEN: latestHandoff equals the input fields with eventRef keyed by
    // sequence + timestamp (v:2 contract — no `id` key).
    expect(next.latestHandoff).toBeDefined();
    expect(next.latestHandoff?.context).toBe('design phase wrapping up');
    expect(next.latestHandoff?.nextSteps).toEqual(['run typecheck', 'open PR']);
    expect(next.latestHandoff?.suggestions).toEqual(['re-read CLAUDE.md']);
    expect(next.latestHandoff?.eventRef.sequence).toBe(7);
    expect(next.latestHandoff?.eventRef.timestamp).toBe('2026-05-08T12:34:56.000Z');

    // AND: NO `id` key on eventRef (v:2 strict-deprecation per #1246).
    expect(Object.keys(next.latestHandoff!.eventRef).sort()).toEqual([
      'sequence',
      'timestamp',
    ]);

    // AND: recentHandoffs has been seeded with a single entry mirroring
    // latestHandoff (most-recent-first, length 1).
    expect(next.recentHandoffs).toHaveLength(1);
    expect(next.recentHandoffs[0]).toEqual(next.latestHandoff);

    // AND: projectionSequence was bumped exactly once for this handled event.
    expect(next.projectionSequence).toBe(1);

    // AND: purity — the initial state was not mutated.
    expect(initial.latestHandoff).toBeUndefined();
    expect(initial.recentHandoffs).toEqual([]);
    expect(initial.projectionSequence).toBe(0);

    // AND: the resulting document still conforms to RehydrationDocumentSchema.
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('applyWorkflowCheckpoint_EmptyHandoff_NoStateChange', () => {
    // GIVEN: the initial state
    const initial = rehydrationReducer.initial;

    // CASE 1: handoff omitted entirely (legacy / non-handoff checkpoint)
    const evtNoHandoff = makeCheckpoint(1, undefined);
    const next1 = rehydrationReducer.apply(initial, evtNoHandoff);
    expect(next1).toBe(initial);
    expect(next1.projectionSequence).toBe(0);
    expect(next1.latestHandoff).toBeUndefined();
    expect(next1.recentHandoffs).toEqual([]);

    // CASE 2: handoff present but all fields missing
    const evtAllUndef = makeCheckpoint(2, {});
    const next2 = rehydrationReducer.apply(initial, evtAllUndef);
    expect(next2).toBe(initial);
    expect(next2.projectionSequence).toBe(0);

    // CASE 3: handoff present with explicit empty arrays + missing context
    const evtEmptyArrays = makeCheckpoint(3, {
      nextSteps: [],
      suggestions: [],
    });
    const next3 = rehydrationReducer.apply(initial, evtEmptyArrays);
    expect(next3).toBe(initial);
    expect(next3.projectionSequence).toBe(0);
  });

  it('applyWorkflowCheckpoint_MultipleEvents_RecentHandoffsBoundedToThree', () => {
    // GIVEN: an initial state we will fold 5 sequential checkpoint events into
    let state = rehydrationReducer.initial;
    for (let i = 1; i <= 5; i++) {
      state = rehydrationReducer.apply(
        state,
        makeCheckpoint(i, {
          context: `checkpoint ${i}`,
          nextSteps: [`step-${i}`],
        }),
      );
    }

    // THEN: the bounded sliding window holds at most 3 entries
    expect(state.recentHandoffs).toHaveLength(3);

    // AND: ordering is most-recent-first (event 5, 4, 3)
    expect(state.recentHandoffs[0]?.context).toBe('checkpoint 5');
    expect(state.recentHandoffs[1]?.context).toBe('checkpoint 4');
    expect(state.recentHandoffs[2]?.context).toBe('checkpoint 3');

    // AND: eventRef.sequence ordering matches the most-recent-first contract
    expect(state.recentHandoffs[0]?.eventRef.sequence).toBe(5);
    expect(state.recentHandoffs[1]?.eventRef.sequence).toBe(4);
    expect(state.recentHandoffs[2]?.eventRef.sequence).toBe(3);

    // AND: latestHandoff tracks the head of the window (event 5)
    expect(state.latestHandoff?.context).toBe('checkpoint 5');
    expect(state.latestHandoff?.eventRef.sequence).toBe(5);

    // AND: projectionSequence was bumped exactly once per handled event
    expect(state.projectionSequence).toBe(5);

    // AND: the resulting document still conforms to the v:2 envelope schema
    // (the .max(3) constraint on recentHandoffs is enforced at parse time)
    expect(RehydrationDocumentSchema.safeParse(state).success).toBe(true);
  });

  it('applyWorkflowCheckpoint_ReplayFromInitial_ReconstructsLatest', () => {
    // GIVEN: a stream of N=4 sequential checkpoint events with non-empty
    // handoff payloads (DR-3 replay invariant — fold from initial, not from a
    // hand-crafted v:1 doc).
    const events = [1, 2, 3, 4].map((i) =>
      makeCheckpoint(i, {
        context: `phase ${i} done`,
        nextSteps: [`task-${i}`],
        suggestions: [`hint-${i}`],
      }),
    );

    // WHEN: we incrementally fold the stream
    let incremental = rehydrationReducer.initial;
    for (const evt of events) {
      incremental = rehydrationReducer.apply(incremental, evt);
    }

    // AND: when we fully replay the same stream from a fresh initial doc
    let replayed = rehydrationReducer.initial;
    for (const evt of events) {
      replayed = rehydrationReducer.apply(replayed, evt);
    }

    // THEN: the two folds produce identical documents (no replay drift)
    expect(replayed).toEqual(incremental);

    // AND: latestHandoff matches the most recent event (sequence 4)
    expect(replayed.latestHandoff?.eventRef.sequence).toBe(4);
    expect(replayed.latestHandoff?.context).toBe('phase 4 done');

    // AND: recentHandoffs is bounded to 3 in most-recent-first order
    expect(replayed.recentHandoffs.map((e) => e.eventRef.sequence)).toEqual([
      4, 3, 2,
    ]);

    // AND: every entry's eventRef carries only {sequence, timestamp} (no id)
    for (const entry of replayed.recentHandoffs) {
      expect(Object.keys(entry.eventRef).sort()).toEqual([
        'sequence',
        'timestamp',
      ]);
    }

    // AND: the document still parses against the v:2 schema
    expect(RehydrationDocumentSchema.safeParse(replayed).success).toBe(true);
  });

  it('applyWorkflowCheckpoint_EventRefSequenceIsPrimary_NoIdField', () => {
    // GIVEN: a sequence of checkpoint events folded into the initial state
    let state = rehydrationReducer.initial;
    for (let i = 10; i <= 12; i++) {
      state = rehydrationReducer.apply(
        state,
        makeCheckpoint(i, {
          context: `cp-${i}`,
          nextSteps: [`step-${i}`],
        }),
      );
    }

    // THEN: every entry in recentHandoffs has an eventRef that contains ONLY
    // {sequence, timestamp} — no `id` key smuggled in. Per #1246 v:2 strict
    // deprecation, the schema's `.strict()` would already reject an `id`,
    // but assert this directly via Object.keys for defense-in-depth.
    expect(state.recentHandoffs.length).toBeGreaterThan(0);
    for (const entry of state.recentHandoffs) {
      const refKeys = Object.keys(entry.eventRef).sort();
      expect(refKeys).toEqual(['sequence', 'timestamp']);
      expect(refKeys).not.toContain('id');
      // Sanity: types — sequence must be a non-negative integer per the v:2
      // schema; timestamp must be a string.
      expect(typeof entry.eventRef.sequence).toBe('number');
      expect(Number.isInteger(entry.eventRef.sequence)).toBe(true);
      expect(entry.eventRef.sequence).toBeGreaterThanOrEqual(0);
      expect(typeof entry.eventRef.timestamp).toBe('string');
    }

    // AND: latestHandoff carries the same single-key pair when present.
    expect(state.latestHandoff).toBeDefined();
    expect(Object.keys(state.latestHandoff!.eventRef).sort()).toEqual([
      'sequence',
      'timestamp',
    ]);
  });

  it('applyWorkflowCheckpoint_FreshReplayRecoversSnapshotDroppedEntries', () => {
    // C1 audit (snapshot-vs-replay asymmetry, #1246): a hypothetical legacy
    // v:1 snapshot would have been forced to drop a handoff entry whose
    // pre-#1230 eventRef carried only an `id` and no usable `sequence`. Fresh
    // replay-from-events of the SAME `workflow.checkpoint` events recovers
    // that entry's content under v:2 because the underlying event has a valid
    // post-#1230 sequence.
    //
    // This test does not depend on T3 (the read-back / migration path); it
    // simply asserts that the reducer's fresh replay produces a complete
    // recentHandoffs window even for entries a hypothetical legacy snapshot
    // would have lacked.
    //
    // Setup: synthesise three checkpoint events with valid sequences. The
    // middle event (sequence 22) is the one we model as "would have been
    // dropped from a v:1 snapshot" — it's identical in shape to its siblings.
    const evtA = makeCheckpoint(21, {
      context: 'phase A done',
      nextSteps: ['next-A'],
    });
    const evtB = makeCheckpoint(22, {
      context: 'phase B done — entry the legacy snapshot dropped',
      nextSteps: ['next-B'],
    });
    const evtC = makeCheckpoint(23, {
      context: 'phase C done',
      nextSteps: ['next-C'],
    });

    // WHEN: we fold all three events from a fresh initial document (the
    // canonical replay-from-events path).
    let replayed = rehydrationReducer.initial;
    for (const evt of [evtA, evtB, evtC]) {
      replayed = rehydrationReducer.apply(replayed, evt);
    }

    // THEN: the fresh-replay recentHandoffs contains all three entries —
    // including the middle "would-have-been-dropped" entry — with correct
    // eventRef.sequence keys derived from the events themselves (NOT from any
    // v:1 `id` that a snapshot may have lost).
    expect(replayed.recentHandoffs).toHaveLength(3);
    const sequences = replayed.recentHandoffs.map((e) => e.eventRef.sequence);
    expect(sequences).toEqual([23, 22, 21]); // most-recent-first

    // AND: the recovered "dropped" entry carries its full content under v:2.
    const recovered = replayed.recentHandoffs.find(
      (e) => e.eventRef.sequence === 22,
    );
    expect(recovered).toBeDefined();
    expect(recovered?.context).toBe(
      'phase B done — entry the legacy snapshot dropped',
    );
    expect(recovered?.nextSteps).toEqual(['next-B']);
    // AND: its eventRef has no v:1 `id` key (audit invariant).
    expect(Object.keys(recovered!.eventRef).sort()).toEqual([
      'sequence',
      'timestamp',
    ]);

    // AND: the resulting document parses cleanly under the v:2 envelope
    // (the read-side migration is T3's concern; this test asserts the
    // reducer's write-side replay is complete on its own).
    expect(RehydrationDocumentSchema.safeParse(replayed).success).toBe(true);
  });
});

// ─── #1242 — workflow.handoff_summarized fold (operator-precedence) ──────────
describe('rehydration reducer — workflow.handoff_summarized fold (#1242)', () => {
  function makeSummarized(
    sequence: number,
    handoff: { context?: string; nextSteps?: string[]; suggestions?: string[] } | undefined,
    overrides: { phase?: string; timestamp?: string } = {},
  ): WorkflowEvent {
    const data: Record<string, unknown> = {
      featureId: 'wf-test',
      ...(overrides.phase !== undefined ? { phase: overrides.phase } : {}),
    };
    if (handoff !== undefined) data['handoff'] = handoff;
    return {
      streamId: 'wf-test',
      sequence,
      timestamp: overrides.timestamp ?? `2026-05-08T01:00:0${sequence % 10}.000Z`,
      type: 'workflow.handoff_summarized',
      schemaVersion: '1.0',
      data,
    } as WorkflowEvent;
  }

  function makeCheckpoint(
    sequence: number,
    handoff: { context?: string; nextSteps?: string[]; suggestions?: string[] },
    timestamp = `2026-05-08T00:00:0${sequence % 10}.000Z`,
  ): WorkflowEvent {
    return {
      streamId: 'wf-test',
      sequence,
      timestamp,
      type: 'workflow.checkpoint',
      schemaVersion: '1.0',
      data: { counter: sequence, phase: 'design', featureId: 'wf-test', handoff },
    } as WorkflowEvent;
  }

  it('Summarized_NoOperatorHandoff_FillsLatestHandoffWithAutoSource', () => {
    const next = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeSummarized(5, { context: 'auto: wrapping up plan phase', nextSteps: ['dispatch wave 1'] }, { timestamp: '2026-05-08T09:00:00.000Z' }),
    );

    expect(next.latestHandoff?.context).toBe('auto: wrapping up plan phase');
    expect(next.latestHandoff?.nextSteps).toEqual(['dispatch wave 1']);
    expect(next.latestHandoff?.source).toBe('auto');
    expect(next.latestHandoff?.eventRef).toEqual({ sequence: 5, timestamp: '2026-05-08T09:00:00.000Z' });
    expect(next.recentHandoffs).toHaveLength(1);
    expect(next.projectionSequence).toBe(1);
    expect(RehydrationDocumentSchema.safeParse(next).success).toBe(true);
  });

  it('Summarized_DoesNotOverwriteOperatorHandoff_OperatorPrecedence', () => {
    // GIVEN: an operator checkpoint holds the slot.
    const afterOperator = rehydrationReducer.apply(
      rehydrationReducer.initial,
      makeCheckpoint(3, { context: 'operator: hand-written handoff' }),
    );
    expect(afterOperator.latestHandoff?.source).toBe('operator');

    // WHEN: a summarized fallback fires afterward.
    const afterSummary = rehydrationReducer.apply(afterOperator, makeSummarized(4, { context: 'auto: should be suppressed' }));

    // THEN: operator content is preserved; the summary is a no-op (identity).
    expect(afterSummary).toBe(afterOperator);
    expect(afterSummary.latestHandoff?.context).toBe('operator: hand-written handoff');
    expect(afterSummary.latestHandoff?.source).toBe('operator');
    expect(afterSummary.recentHandoffs).toHaveLength(1);
    expect(afterSummary.projectionSequence).toBe(afterOperator.projectionSequence);
  });

  it('OperatorCheckpoint_OverwritesPriorSummary_OperatorAlwaysWins', () => {
    // GIVEN: a summary holds the slot.
    const afterSummary = rehydrationReducer.apply(rehydrationReducer.initial, makeSummarized(1, { context: 'auto: placeholder' }));
    expect(afterSummary.latestHandoff?.source).toBe('auto');

    // WHEN: an operator checkpoint fires.
    const afterOperator = rehydrationReducer.apply(afterSummary, makeCheckpoint(2, { context: 'operator: real handoff' }));

    // THEN: the operator handoff replaces the summary.
    expect(afterOperator.latestHandoff?.context).toBe('operator: real handoff');
    expect(afterOperator.latestHandoff?.source).toBe('operator');
    expect(afterOperator.recentHandoffs[0]?.source).toBe('operator');
  });

  it('Summarized_OverwritesPriorSummary_MostRecentAutoWins', () => {
    const s1 = rehydrationReducer.apply(rehydrationReducer.initial, makeSummarized(1, { context: 'auto v1' }));
    const s2 = rehydrationReducer.apply(s1, makeSummarized(2, { context: 'auto v2' }));
    expect(s2.latestHandoff?.context).toBe('auto v2');
    expect(s2.latestHandoff?.source).toBe('auto');
    expect(s2.recentHandoffs).toHaveLength(2);
  });

  it('Summarized_EmptyHandoff_NoStateChange', () => {
    const initial = rehydrationReducer.initial;
    expect(rehydrationReducer.apply(initial, makeSummarized(1, undefined))).toBe(initial);
    expect(rehydrationReducer.apply(initial, makeSummarized(2, {}))).toBe(initial);
    expect(rehydrationReducer.apply(initial, makeSummarized(3, { nextSteps: [], suggestions: [] }))).toBe(initial);
  });

  it('Summarized_ReplayDeterminism_FoldingTwiceYieldsEqualProjection', () => {
    // INV-1: the stored summary string is the source of truth — replaying the
    // same event sequence reproduces an identical projection (the summarizer is
    // never re-invoked on replay).
    const events = [
      makeSummarized(1, { context: 'auto: phase A summary' }),
      makeCheckpoint(2, { context: 'operator: phase B handoff' }),
      makeSummarized(3, { context: 'auto: suppressed by operator' }),
    ];
    const foldOnce = events.reduce((s, e) => rehydrationReducer.apply(s, e), rehydrationReducer.initial);
    const foldTwice = events.reduce((s, e) => rehydrationReducer.apply(s, e), rehydrationReducer.initial);
    expect(foldOnce).toEqual(foldTwice);
    // Operator (seq 2) wins the slot; the later summary (seq 3) is suppressed.
    expect(foldOnce.latestHandoff?.context).toBe('operator: phase B handoff');
    expect(foldOnce.latestHandoff?.source).toBe('operator');
  });

  it('Summarized_LegacyEntryWithoutSource_TreatedAsOperator', () => {
    // A pre-#1242 latestHandoff carries no `source`. The summary must NOT
    // overwrite it (the only pre-#1242 writer was the operator checkpoint path).
    const legacyState = {
      ...rehydrationReducer.initial,
      latestHandoff: {
        context: 'legacy operator handoff',
        eventRef: { sequence: 9, timestamp: '2026-05-01T00:00:00.000Z' },
      },
    } as typeof rehydrationReducer.initial;

    const next = rehydrationReducer.apply(legacyState, makeSummarized(10, { context: 'auto: should defer to legacy' }));
    expect(next).toBe(legacyState);
    expect(next.latestHandoff?.context).toBe('legacy operator handoff');
  });
});

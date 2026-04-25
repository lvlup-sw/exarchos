import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from './reducer.js';
import { RehydrationDocumentSchema } from './schema.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

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

describe('rehydration reducer — initial state (T022, DR-3)', () => {
  it('Rehydration_NoEvents_ReturnsMinimalInitial', () => {
    // GIVEN: no events
    // WHEN: we read rehydrationReducer.initial
    const initial = rehydrationReducer.initial;

    // THEN: the initial document parses cleanly via RehydrationDocumentSchema
    const result = RehydrationDocumentSchema.safeParse(initial);
    expect(result.success).toBe(true);

    // AND: the versioned envelope carries v === 1 and projectionSequence === 0
    expect(initial.v).toBe(1);
    expect(initial.projectionSequence).toBe(0);

    // AND: volatile sections are empty containers
    expect(initial.taskProgress).toEqual([]);
    expect(initial.decisions).toEqual([]);
    expect(initial.artifacts).toEqual({});
    expect(initial.blockers).toEqual([]);
    expect(initial.nextAction).toBeUndefined();

    // AND: stable sections carry minimal defaults (strings, possibly empty)
    expect(typeof initial.behavioralGuidance.skill).toBe('string');
    expect(typeof initial.behavioralGuidance.skillRef).toBe('string');
    expect(typeof initial.workflowState.featureId).toBe('string');
    expect(typeof initial.workflowState.phase).toBe('string');
    expect(typeof initial.workflowState.workflowType).toBe('string');
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
    // terminal "completed" status.
    expect(afterCompleted.taskProgress).toHaveLength(1);
    expect(afterCompleted.taskProgress[0]).toMatchObject({
      id: '001',
      status: 'completed',
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
      status: 'completed',
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
  // `servers/exarchos-mcp/src/workflow/tools.ts` (~L759) where
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

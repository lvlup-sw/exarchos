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

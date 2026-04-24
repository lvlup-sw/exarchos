import { describe, it, expect } from 'vitest';
import { rehydrationReducer } from './reducer.js';
import { RehydrationDocumentSchema } from './schema.js';

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

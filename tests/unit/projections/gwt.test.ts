/**
 * Tests for the given-when-then harness for projection reducers.
 * `given(events).when(reducer).then(state)` folds the events and compares the result with the expected state.
 */

import { describe, it, expect } from 'vitest';
import { given } from '../../../src/projections/gwt.js';
import { rehydrationReducer } from '../../../src/projections/rehydration/index.js';
import { assertReducerImmutable } from '../../../src/projections/testing.js';
import type { ProjectionReducer } from '../../../src/projections/types.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import type { RehydrationDocument } from '../../../src/projections/rehydration/schema.js';

/** Minimal WorkflowEvent factory — mirrors reducer.test.ts's `makeEvent`. */
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

describe('given-when-then harness (T044, DR-10)', () => {
  /** The expected state comes from a manual fold of the same reducer. A wrong expectation must throw. */
  it('GivenWhenThen_Helper_ReducesFixturesCorrectly', () => {
    const eventA: WorkflowEvent = makeEvent(
      'task.assigned',
      { taskId: '001', title: 'T001' },
      1,
    );
    const eventB: WorkflowEvent = makeEvent(
      'task.completed',
      { taskId: '001' },
      2,
    );

    const expected: RehydrationDocument = rehydrationReducer.apply(
      rehydrationReducer.apply(rehydrationReducer.initial, eventA),
      eventB,
    );

    expect(() =>
      given<RehydrationDocument, WorkflowEvent>([eventA, eventB])
        .when(rehydrationReducer)
        .then(expected),
    ).not.toThrow();

    const wrong: RehydrationDocument = {
      ...expected,
      projectionSequence: expected.projectionSequence + 999,
    };
    expect(() =>
      given<RehydrationDocument, WorkflowEvent>([eventA])
        .when(rehydrationReducer)
        .then(wrong),
    ).toThrow();
  });

  /**
   * A fold must not mutate the initial state or an intermediate state.
   * So the same events must also pass `assertReducerImmutable`.
   * The cast is redundant, because `rehydrationReducer` already has that type.
   */
  it('GivenWhenThen_HelperPreservesImmutability', () => {
    const events: readonly WorkflowEvent[] = [
      makeEvent('task.assigned', { taskId: '001', title: 'T001' }, 1),
      makeEvent('task.completed', { taskId: '001' }, 2),
    ];

    const reducer = rehydrationReducer as unknown as ProjectionReducer<
      RehydrationDocument,
      WorkflowEvent
    >;

    const expected = events.reduce(
      (state, event) => reducer.apply(state, event),
      reducer.initial,
    );

    expect(() =>
      given<RehydrationDocument, WorkflowEvent>(events).when(reducer).then(expected),
    ).not.toThrow();

    expect(() => assertReducerImmutable(reducer, events)).not.toThrow();
  });

  it('GivenWhenThen_ThenSatisfies_AllowsPredicateAssertion', () => {
    const events: readonly WorkflowEvent[] = [
      makeEvent('task.assigned', { taskId: '001', title: 'T001' }, 1),
    ];

    expect(() =>
      given<RehydrationDocument, WorkflowEvent>(events)
        .when(rehydrationReducer)
        .thenSatisfies((state) => state.taskProgress.length === 1),
    ).not.toThrow();

    expect(() =>
      given<RehydrationDocument, WorkflowEvent>(events)
        .when(rehydrationReducer)
        .thenSatisfies((state) => state.taskProgress.length === 99),
    ).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { given } from './gwt.js';
import { rehydrationReducer } from './rehydration/index.js';
import { assertReducerImmutable } from './testing.js';
import type { ProjectionReducer } from './types.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { RehydrationDocument } from './rehydration/schema.js';

/**
 * DR-10 given-when-then harness — ergonomic chainable assertion helper for
 * projection reducers. Tests read as `given(events).when(reducer).then(state)`,
 * folding events through the reducer and asserting deep equality against the
 * expected projected state.
 *
 * Pairs with {@link assertReducerImmutable} (T003): that harness is a purity
 * property check; this one is an end-to-end fold-and-equate assertion.
 */

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
  it('GivenWhenThen_Helper_ReducesFixturesCorrectly', () => {
    // GIVEN: a canonical task.* pair flowing through the rehydration reducer.
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

    // AND: the expected projected state — we derive it by folding manually so
    // the fixture is exactly what the reducer under test must produce.
    const expected: RehydrationDocument = rehydrationReducer.apply(
      rehydrationReducer.apply(rehydrationReducer.initial, eventA),
      eventB,
    );

    // THEN: the happy-path chain passes without throwing.
    expect(() =>
      given<RehydrationDocument, WorkflowEvent>([eventA, eventB])
        .when(rehydrationReducer)
        .then(expected),
    ).not.toThrow();

    // AND: a mismatched expectation throws an assertion error.
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

  it('GivenWhenThen_HelperPreservesImmutability', () => {
    // The harness folds events through the reducer. Folding must not mutate
    // the reducer's initial state or any intermediate — so the same event
    // sequence must also satisfy `assertReducerImmutable`.
    const events: readonly WorkflowEvent[] = [
      makeEvent('task.assigned', { taskId: '001', title: 'T001' }, 1),
      makeEvent('task.completed', { taskId: '001' }, 2),
    ];

    // Cast widening mirrors the rehydration barrel — the registry and the
    // purity harness are generic-in-name-only at the boundary.
    const reducer = rehydrationReducer as unknown as ProjectionReducer<
      RehydrationDocument,
      WorkflowEvent
    >;

    // Compute expected via the same fold semantics the harness uses.
    const expected = events.reduce(
      (state, event) => reducer.apply(state, event),
      reducer.initial,
    );

    // The harness itself must not throw on a pure reducer.
    expect(() =>
      given<RehydrationDocument, WorkflowEvent>(events).when(reducer).then(expected),
    ).not.toThrow();

    // And the underlying reducer passes the T003 immutability property.
    expect(() => assertReducerImmutable(reducer, events)).not.toThrow();
  });

  it('GivenWhenThen_ThenSatisfies_AllowsPredicateAssertion', () => {
    // Optional `.thenSatisfies(predicate)` variant — passes when predicate
    // returns true, throws when it returns false.
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

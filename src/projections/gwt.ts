/**
 * Given-When-Then harness for tests of projection reducers.
 *
 * ```ts
 * given(events).when(reducer).then(expectedState);
 * ```
 *
 * The chain folds `events` through `reducer.apply`, from `reducer.initial`. Then it
 * compares the final state with the expected state. This is a value check. The
 * harness does not freeze intermediate states. `assertReducerImmutable` checks for mutation.
 */
import { expect } from 'vitest';
import type { ProjectionReducer } from './types.js';

/** Terminal stage of the chain, returned from `.when(reducer)`. */
export interface ThenAssertable<State> {
  /** Asserts that the final state deep-equals `expected`, with the `toEqual` of vitest. */
  then(expected: State): void;

  /**
   * Asserts that the final state satisfies `predicate`. On failure, it throws a
   * plain `Error` that holds the state as JSON, when the state can be serialized.
   */
  thenSatisfies(predicate: (state: State) => boolean): void;
}

/** Middle stage of the chain, returned from `given(events)`. It takes the reducer. */
export interface WhenBindable<Event> {
  when<State>(reducer: ProjectionReducer<State, Event>): ThenAssertable<State>;
}

/**
 * Entry point for the chain. It binds an event fixture.
 *
 * @param events - The events to fold. When the list is empty, the fold gives `reducer.initial`.
 */
export function given<State, Event>(
  events: readonly Event[],
): WhenBindable<Event> {
  return {
    when<S>(reducer: ProjectionReducer<S, Event>): ThenAssertable<S> {
      const actual = events.reduce<S>(
        (state, event) => reducer.apply(state, event),
        reducer.initial,
      );
      return {
        then(expected: S): void {
          expect(actual).toEqual(expected);
        },
        thenSatisfies(predicate: (state: S) => boolean): void {
          if (!predicate(actual)) {
            let rendered: string;
            try {
              rendered = JSON.stringify(actual);
            } catch {
              rendered = '<unserializable>';
            }
            throw new Error(
              `given-when-then: predicate returned false for state ${rendered}`,
            );
          }
        },
      };
    },
  };
}

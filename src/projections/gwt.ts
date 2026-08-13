/**
 * Given-When-Then harness for projection reducers (T044, DR-10).
 *
 * Provides an ergonomic, chainable DSL for writing projection-reducer tests in
 * canonical GWT form:
 *
 * ```ts
 * given(events)
 *   .when(reducer)
 *   .then(expectedState);
 * ```
 *
 * The chain folds `events` through `reducer.apply`, seeded with
 * `reducer.initial`, then asserts deep equality of the final state against
 * `expectedState` via vitest's `toEqual`. A mismatch throws an assertion
 * error that surfaces the offending delta to the enclosing `it(...)` block.
 *
 * This harness is the ergonomic sibling of {@link assertReducerImmutable}
 * (T003): that one is a *property* check (reducer must not mutate state);
 * this one is a *value* check (reducer must fold events to the expected
 * state). Tests typically use both — immutability as a sanity property and
 * `given/when/then` to pin specific fixtures.
 *
 * ## Design notes
 *
 * - **Test-framework coupling.** The happy path uses vitest's `expect`
 *   directly so test output integrates with the rest of the suite
 *   (diff display, `--reporter=verbose`, etc.). `.thenSatisfies` throws
 *   a plain `Error` so callers who prefer to keep the helper
 *   framework-agnostic at that call site have an escape hatch.
 * - **Generic parameters.** Fully generic over `<State, Event>`; the test
 *   author pins them at the call site (or lets TypeScript infer from the
 *   `events` array and `reducer.initial`). No `any` appears on the public
 *   surface.
 * - **Immutability.** The harness does not deep-freeze intermediates — that
 *   is {@link assertReducerImmutable}'s job. This helper assumes the reducer
 *   already satisfies DR-1 purity (enforced separately by T003 tests).
 */
import { expect } from 'vitest';
import type { ProjectionReducer } from './types.js';

/**
 * Terminal stage of the GWT chain.
 *
 * Returned from `.when(reducer)` after the reducer has been bound. Provides
 * the two assertion verbs — {@link ThenAssertable.then} for deep equality
 * and {@link ThenAssertable.thenSatisfies} for arbitrary predicates.
 */
export interface ThenAssertable<State> {
  /**
   * Asserts the folded final state deep-equals `expected` via vitest's
   * `toEqual`. Throws an assertion error on mismatch.
   */
  then(expected: State): void;

  /**
   * Asserts the folded final state satisfies `predicate`. Throws a plain
   * `Error` on failure with a descriptive message including the offending
   * state (JSON-stringified, best-effort).
   */
  thenSatisfies(predicate: (state: State) => boolean): void;
}

/**
 * Intermediate stage of the GWT chain.
 *
 * Returned from `given(events)` with the event fixture bound. The caller
 * must supply a reducer via {@link WhenBindable.when} to obtain the
 * terminal {@link ThenAssertable}.
 */
export interface WhenBindable<Event> {
  when<State>(reducer: ProjectionReducer<State, Event>): ThenAssertable<State>;
}

/**
 * Entry point for the GWT chain.
 *
 * Binds an event fixture and returns a {@link WhenBindable} that accepts a
 * reducer. See the module-level docstring for the full chain and design
 * notes.
 *
 * @typeParam State - The reducer's projected state type.
 * @typeParam Event - The event type folded by the reducer.
 * @param events - The event sequence to fold. May be empty (the fold then
 *   yields `reducer.initial` unchanged).
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

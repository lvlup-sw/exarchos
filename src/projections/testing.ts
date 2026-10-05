/**
 * Property-test harness for the purity contract of {@link ProjectionReducer}.
 *
 * {@link assertReducerImmutable} freezes each state before the reducer gets it. In
 * strict mode, which each ESM module uses, a write to a frozen object throws a
 * `TypeError`. So a reducer that mutates its `state` argument fails the test, and a
 * pure reducer passes. The harness does not replace unit tests.
 */

import type { ProjectionReducer } from './types.js';

/**
 * Freezes `value` and its children in place, children first. A primitive, a function,
 * or a frozen value returns unchanged.
 *
 * @internal
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreeze(entry);
    }
  } else {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  Object.freeze(value);
  return value;
}

/**
 * Asserts that `reducer.apply` does not mutate its `state` argument during a fold of
 * `events`. It freezes the initial state and each intermediate result before the next call.
 *
 * @param reducer - The reducer under test.
 * @param events - The events to fold. The list can be empty.
 * @throws `TypeError` if `apply` mutates the `state` argument in place.
 */
export function assertReducerImmutable<State, Event>(
  reducer: ProjectionReducer<State, Event>,
  events: readonly Event[],
): void {
  let state = deepFreeze(reducer.initial);
  for (const event of events) {
    const next = reducer.apply(state, event);
    state = deepFreeze(next);
  }
}

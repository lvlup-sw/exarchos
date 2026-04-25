/**
 * Property-test harness for the `ProjectionReducer` purity contract (DR-1).
 *
 * {@link assertReducerImmutable} deep-freezes the reducer's initial state,
 * folds the provided events through `reducer.apply`, and relies on strict-mode
 * semantics (ESM modules are always strict) to throw a `TypeError` the moment
 * `apply` attempts an in-place mutation of the frozen state. Pure reducers
 * that return new state values pass silently; reducers that mutate their
 * `state` argument surface the violation immediately.
 *
 * This is the runtime companion to the "Purity contract" documented on
 * {@link ProjectionReducer} (see `./types.ts`). It is intentionally not a
 * substitute for thorough unit tests — it is a property harness that every
 * projection's test suite should invoke with a representative event fixture.
 */

import type { ProjectionReducer } from './types.js';

/**
 * Recursively freezes `value` in place. Plain objects and arrays are frozen;
 * primitives, functions, and already-frozen values are returned as-is.
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
  // Freeze children first so parents always observe frozen children.
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
 * Asserts that `reducer.apply` does not mutate its `state` argument across a
 * fold of `events`.
 *
 * The function deep-freezes the reducer's initial state, then folds each
 * event through `apply`, deep-freezing each intermediate result before the
 * next call. Any attempt by `apply` to write to a frozen object throws a
 * `TypeError` under strict mode (which ESM enables automatically), which
 * propagates out of this helper to fail the enclosing test.
 *
 * @param reducer - The reducer under test.
 * @param events - The event sequence to fold (may be empty).
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

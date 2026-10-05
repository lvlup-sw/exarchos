import { describe, it, expect } from 'vitest';
import { assertReducerImmutable } from '../../../src/projections/testing.js';
import type { ProjectionReducer } from '../../../src/projections/types.js';

/**
 * `assertReducerImmutable` deep-freezes the initial state of the reducer and each result of `apply`.
 * A reducer that mutates its state in place then throws a `TypeError`.
 * The one test here proves only that a pure reducer passes.
 */
describe('assertReducerImmutable', () => {
  interface State {
    readonly count: number;
    readonly tags: readonly string[];
    readonly meta: { readonly label: string };
  }
  type Event = { kind: 'inc' } | { kind: 'tag'; value: string };

  const pureReducer: ProjectionReducer<State, Event> = {
    id: 'immutability-fixture@v1',
    version: 1,
    initial: { count: 0, tags: [], meta: { label: 'root' } },
    apply: (state, event) => {
      if (event.kind === 'inc') {
        return { ...state, count: state.count + 1 };
      }
      return { ...state, tags: [...state.tags, event.value] };
    },
  };

  it('Reducer_DeepFrozenInput_DoesNotMutate', () => {
    const events: readonly Event[] = [
      { kind: 'inc' },
      { kind: 'tag', value: 'alpha' },
      { kind: 'inc' },
    ];
    expect(() => assertReducerImmutable(pureReducer, events)).not.toThrow();
  });
});

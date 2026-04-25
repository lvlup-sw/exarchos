import { describe, it, expect } from 'vitest';
import { assertReducerImmutable } from './testing.js';
import type { ProjectionReducer } from './types.js';

/**
 * DR-1 reducer purity contract — property harness.
 *
 * `assertReducerImmutable` deep-freezes the reducer's initial state, folds a
 * sequence of events through `apply`, and surfaces any in-place mutation
 * attempt as a thrown error (via strict-mode frozen-object semantics).
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

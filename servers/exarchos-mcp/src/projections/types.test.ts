import { describe, it, expect, expectTypeOf } from 'vitest';
import type { ProjectionReducer } from './types.js';

describe('ProjectionReducer', () => {
  it('ProjectionReducer_TypeShape_Compiles', () => {
    const reducer: ProjectionReducer<{ count: number }, { type: 'inc' }> = {
      id: 'test@v1',
      version: 1,
      initial: { count: 0 },
      apply: (s, _e) => ({ count: s.count + 1 }),
    };
    expectTypeOf(reducer).toMatchTypeOf<
      ProjectionReducer<{ count: number }, { type: 'inc' }>
    >();
    // Runtime sanity so vitest records a pass
    expect(reducer.apply(reducer.initial, { type: 'inc' })).toEqual({ count: 1 });
  });
});

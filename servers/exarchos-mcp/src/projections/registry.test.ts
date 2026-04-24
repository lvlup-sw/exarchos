import { describe, it, expect, beforeEach } from 'vitest';
import type { ProjectionReducer } from './types.js';
import { createRegistry } from './registry.js';

type CountState = { count: number };
type IncEvent = { type: 'inc' };

function makeReducer(id: string): ProjectionReducer<CountState, IncEvent> {
  return {
    id,
    version: 1,
    initial: { count: 0 },
    apply: (s, _e) => ({ count: s.count + 1 }),
  };
}

describe('projection registry', () => {
  let registry: ReturnType<typeof createRegistry>;

  beforeEach(() => {
    registry = createRegistry();
  });

  it('Registry_RegisterSingle_Stores', () => {
    const reducer = makeReducer('rehydration@v1');
    registry.register(reducer as ProjectionReducer<unknown, unknown>);
    expect(registry.get('rehydration@v1')).toBe(reducer);
  });

  it('Registry_RegisterDuplicate_Throws', () => {
    const first = makeReducer('rehydration@v1');
    const second = makeReducer('rehydration@v1');
    registry.register(first as ProjectionReducer<unknown, unknown>);
    expect(() =>
      registry.register(second as ProjectionReducer<unknown, unknown>),
    ).toThrow(/duplicate projection id: rehydration@v1/);
  });
});

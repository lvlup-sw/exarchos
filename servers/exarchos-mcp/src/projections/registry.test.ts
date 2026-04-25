import { describe, it, expect, beforeEach } from 'vitest';
import type { ProjectionReducer } from './types.js';
import { createRegistry, defaultRegistry } from './registry.js';
// Import the rehydration barrel for its module-load-time side effect:
// `register(rehydrationReducer)` against the process-wide defaultRegistry
// (T026, DR-1, DR-3). Placed at the top so registration is reached before
// any test in this file executes, regardless of describe ordering.
import { rehydrationReducer } from './rehydration/index.js';

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

describe('projection registry — rehydration barrel registration (T026)', () => {
  it('Registry_Get_rehydrationV1_ReturnsReducer', () => {
    // GIVEN: the rehydration barrel has been imported (top-of-file), which
    //   MUST have triggered `defaultRegistry.register(rehydrationReducer)` at
    //   module load (DR-1 contract: concrete projections self-register).
    // WHEN: we look up the reducer by its canonical id.
    const found = defaultRegistry.get('rehydration@v1');
    // THEN: we get back the exact rehydrationReducer instance (identity),
    //   preserving its id and version. Reference equality guards against
    //   accidental rewrapping / cloning during registration.
    expect(found).toBe(rehydrationReducer);
    expect(found?.id).toBe('rehydration@v1');
    expect(found?.version).toBe(1);
  });

  it('Registry_Get_UnknownId_ReturnsUndefined', () => {
    // Sanity: the default registry does not invent entries for unknown ids
    //   (guards against a buggy `get` that falls back to the first reducer).
    expect(defaultRegistry.get('does-not-exist@v1')).toBeUndefined();
  });
});

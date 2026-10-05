/**
 * Tests for the projection registry. The import of the rehydration barrel registers
 * `rehydrationReducer` with `defaultRegistry` at module load, before any test runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ProjectionReducer } from '../../../src/projections/types.js';
import { createRegistry, defaultRegistry } from '../../../src/projections/registry.js';
import { rehydrationReducer } from '../../../src/projections/rehydration/index.js';

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
  /** Reference equality shows that the registration does not wrap or clone the reducer. */
  it('Registry_Get_rehydrationV1_ReturnsReducer', () => {
    const found = defaultRegistry.get('rehydration@v1');
    expect(found).toBe(rehydrationReducer);
    expect(found?.id).toBe('rehydration@v1');
    expect(found?.version).toBe(1);
  });

  /** A `get` that falls back to the first reducer fails this test. */
  it('Registry_Get_UnknownId_ReturnsUndefined', () => {
    expect(defaultRegistry.get('does-not-exist@v1')).toBeUndefined();
  });
});

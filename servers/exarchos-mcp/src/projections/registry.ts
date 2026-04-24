import type { ProjectionReducer } from './types.js';

/**
 * A registry of {@link ProjectionReducer} instances keyed by their unique
 * `id` (DR-1).
 *
 * The registry is the single source of truth for which projections exist in
 * the system. Concrete projections (rehydration, hot-file manifest,
 * time-travel, cross-workflow memory, cost telemetry) each construct their
 * reducer and call {@link ProjectionRegistry.register} at module-load time.
 *
 * Duplicate `id`s are rejected to prevent two reducers from silently
 * clobbering each other and producing divergent replay results.
 */
export interface ProjectionRegistry {
  /**
   * Register a reducer with the registry.
   *
   * @throws Error if a reducer with the same `id` is already registered.
   */
  register(reducer: ProjectionReducer<unknown, unknown>): void;

  /**
   * Look up a registered reducer by its `id`.
   *
   * @returns The reducer, or `undefined` if no reducer with that `id` has been
   *   registered.
   */
  get(id: string): ProjectionReducer<unknown, unknown> | undefined;

  /**
   * List all registered reducers in insertion order.
   *
   * The returned array is a snapshot; mutating it does not affect the
   * registry.
   */
  list(): ReadonlyArray<ProjectionReducer<unknown, unknown>>;
}

/**
 * Create a fresh, empty {@link ProjectionRegistry}.
 *
 * Each call returns an independent registry instance; this is primarily
 * useful for tests that need isolation. Production code typically uses a
 * single process-wide registry.
 */
export function createRegistry(): ProjectionRegistry {
  const reducers = new Map<string, ProjectionReducer<unknown, unknown>>();

  return {
    register(reducer) {
      if (reducers.has(reducer.id)) {
        throw new Error(`duplicate projection id: ${reducer.id}`);
      }
      reducers.set(reducer.id, reducer);
    },
    get(id) {
      return reducers.get(id);
    },
    list() {
      return Array.from(reducers.values());
    },
  };
}

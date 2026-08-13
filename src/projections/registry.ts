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
 * Extract the **domain** of a reducer id. Ids follow the `domain@vN` convention
 * (e.g. `workflow-state@v1` → `workflow-state`); an id without an `@` is its own
 * domain. The domain is the registry-singularity key — at most one reducer may
 * claim a given domain (#1554), so a `workflow-state@v2` cannot silently
 * coexist with `workflow-state@v1` and produce a divergent second left-fold.
 */
function reducerDomain(id: string): string {
  const at = id.lastIndexOf('@');
  return at === -1 ? id : id.slice(0, at);
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
      // Exact-id collision first (preserves the original message + the
      // ES-module idempotency contract for re-imported barrels).
      if (reducers.has(reducer.id)) {
        throw new Error(`duplicate projection id: ${reducer.id}`);
      }
      // Registry singularity (#1554): reject a second reducer claiming the same
      // domain. One canonical left-fold per domain — a versioned successor must
      // replace, not shadow, its predecessor.
      const domain = reducerDomain(reducer.id);
      for (const existing of reducers.values()) {
        if (reducerDomain(existing.id) === domain) {
          throw new Error(
            `duplicate projection domain: ${domain} (already registered as ${existing.id}, cannot also register ${reducer.id})`,
          );
        }
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

/**
 * Process-wide default {@link ProjectionRegistry} (T026, DR-1).
 *
 * Concrete projection barrels (e.g. `projections/rehydration/index.ts`) call
 * {@link ProjectionRegistry.register} against this instance at module-load
 * time so that downstream consumers (projection rebuild/rehydrate runners
 * in T029/T031) can look reducers up by their stable `id`
 * (e.g. `"rehydration@v1"`).
 *
 * Tests that need an isolated registry MUST use {@link createRegistry}
 * instead; mutating `defaultRegistry` inside a test file can leak across
 * test files (vitest's `pool: 'forks'` isolates at the file level, but the
 * same file's describe blocks share module state).
 */
export const defaultRegistry: ProjectionRegistry = createRegistry();

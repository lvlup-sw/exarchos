import type { ProjectionReducer } from './types.js';

/**
 * A registry of {@link ProjectionReducer} instances, keyed by their unique `id`.
 * Concrete projections call {@link ProjectionRegistry.register} at module load.
 * It rejects a duplicate `id`, so two reducers cannot overwrite each other.
 */
export interface ProjectionRegistry {
  /**
   * Register a reducer with the registry.
   *
   * @throws Error if a registered reducer has the same `id` or the same domain.
   */
  register(reducer: ProjectionReducer<unknown, unknown>): void;

  /**
   * Look up a registered reducer by its `id`.
   *
   * @returns The reducer, or `undefined` if no reducer has that `id`.
   */
  get(id: string): ProjectionReducer<unknown, unknown> | undefined;

  /**
   * List all registered reducers in insertion order.
   * The returned array is a copy. A change to it does not change the registry.
   */
  list(): ReadonlyArray<ProjectionReducer<unknown, unknown>>;
}

/**
 * Return the domain of a reducer id: the text before the last `@` in `domain@vN`.
 * An id without an `@` is its own domain.
 * The registry accepts one reducer for each domain, so `workflow-state@v2` cannot shadow `workflow-state@v1`.
 */
function reducerDomain(id: string): string {
  const at = id.lastIndexOf('@');
  return at === -1 ? id : id.slice(0, at);
}

/**
 * Create an empty, independent {@link ProjectionRegistry}.
 * `register` checks an exact `id` collision first, then a domain collision.
 * A versioned successor must replace its predecessor, not shadow it.
 */
export function createRegistry(): ProjectionRegistry {
  const reducers = new Map<string, ProjectionReducer<unknown, unknown>>();

  return {
    register(reducer) {
      if (reducers.has(reducer.id)) {
        throw new Error(`duplicate projection id: ${reducer.id}`);
      }
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
 * Process-wide default {@link ProjectionRegistry}.
 * The projection barrels register with it at module load, and consumers look up reducers by `id`.
 * A test that needs an isolated registry must use {@link createRegistry}.
 * A change to `defaultRegistry` leaks across the `describe` blocks of one test file.
 */
export const defaultRegistry: ProjectionRegistry = createRegistry();

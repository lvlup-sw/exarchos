/**
 * TaskStore projection barrel (Wave 2A.5, #1284).
 *
 * Importing this module has a **side effect**: it registers
 * {@link taskStoreReducer} with the process-wide {@link defaultRegistry}
 * so consumers can resolve the reducer by its stable id `"task-store@v1"`
 * via the per-stream primitives (`decide` / `withSession` / `aggregateStream`).
 *
 * The reducer is `scope: 'stream'`: it folds one workflow stream at a time.
 * The `readProjection<T>(reducerId)` cross-stream reader that this barrel
 * originally fed was removed along with the global scope — folding every
 * stream into one `task-store@v1` state merged distinct features' tasks (see
 * `./types.ts` for the collision and why the scope is not a tuning knob).
 *
 * Mirrors the established pattern from `projections/rehydration/index.ts`.
 *
 * ## Idempotency
 *
 * `defaultRegistry.register` rejects duplicate ids with an error. Because ES
 * modules are cached per specifier, importing this barrel from multiple call
 * sites in a single process resolves to the same module instance and
 * `register` is invoked exactly once. Tests needing an isolated registry MUST
 * use `createRegistry()` rather than re-importing this barrel.
 */
import { defaultRegistry } from '../registry.js';
import { taskStoreReducer } from './reducer.js';

defaultRegistry.register(
  // The reducer is typed `ProjectionReducer<TaskStoreState, WorkflowEvent>`;
  // the registry stores `ProjectionReducer<unknown, unknown>` (it is generic
  // in name only). Widening here is safe — `apply`'s purity contract (DR-1)
  // is a runtime invariant, not a type-system one, so the cast loses no
  // guarantees. Mirrors `projections/rehydration/index.ts`.
  taskStoreReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { taskStoreReducer } from './reducer.js';
export type { TaskRecord, TaskStatus, TaskStoreState } from './types.js';

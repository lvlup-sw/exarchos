/**
 * Rehydration projection barrel (T026, DR-1, DR-3).
 *
 * Importing this module has a **side effect**: it registers
 * {@link rehydrationReducer} with the process-wide {@link defaultRegistry}
 * so the rebuild / rehydrate runners (T029, T031) can resolve the reducer by
 * its stable id `"rehydration@v1"`. This is the DR-1 convention — concrete
 * projections self-register at module load rather than being hand-wired at
 * every call site.
 *
 * Re-exports the reducer and the canonical `RehydrationDocument` type so
 * consumers can import both the runtime value and its schema-derived type
 * from a single entry point.
 *
 * ## Idempotency
 *
 * The registry rejects duplicate `id` registrations with an error (see
 * `registry.ts` — `createRegistry`). Because ES modules are cached per
 * specifier, importing this barrel from multiple call sites in a single
 * process resolves to the same module instance and `register` is invoked
 * exactly once. If a second process-wide registration is ever needed
 * (e.g. after a test clears module state), callers should construct a
 * fresh registry via `createRegistry()` rather than re-importing this
 * barrel.
 */
import { defaultRegistry } from '../registry.js';
import { rehydrationReducer } from './reducer.js';

defaultRegistry.register(
  // The reducer is typed `ProjectionReducer<RehydrationDocument, WorkflowEvent>`;
  // the registry stores `ProjectionReducer<unknown, unknown>` (it is generic in
  // name only). Widening here is safe — `apply`'s purity contract (DR-1) is a
  // runtime invariant, not a type-system one, so the cast loses no guarantees.
  rehydrationReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { rehydrationReducer } from './reducer.js';
export type { RehydrationDocument } from './schema.js';

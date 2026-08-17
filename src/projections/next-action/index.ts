/**
 * `next-action@v1` projection barrel (T060, DR-1, DR-16, DR-17).
 *
 * Importing this module has a **side effect**: it registers
 * {@link nextActionReducer} with the process-wide {@link defaultRegistry} so
 * downstream consumers can resolve the reducer by its stable id
 * `"next-action@v1"`. This is the DR-1 convention — concrete projections
 * self-register at module load rather than being hand-wired at every call
 * site (see `projections/rehydration/index.ts` for the prior art).
 *
 * ## Idempotency
 *
 * The registry rejects duplicate `id` registrations. ES modules are cached
 * per specifier, so importing this barrel from multiple call sites in a
 * single process triggers `register` exactly once. Tests that need an
 * isolated registry should construct a fresh one via `createRegistry()`
 * rather than re-importing this barrel.
 *
 * Re-exports the reducer value + its public types so consumers can pull both
 * from a single entry point.
 */
import { defaultRegistry } from '../registry.js';
import { nextActionReducer } from './reducer.js';

defaultRegistry.register(
  // The reducer is typed `ProjectionReducer<NextAction[], WorkflowEvent>`;
  // the registry stores `ProjectionReducer<unknown, unknown>` (generic in
  // name only). Widening here is safe — `apply`'s purity contract (DR-1) is
  // a runtime invariant, not a type-system one, so the cast loses no
  // guarantees. Mirrors the rehydration barrel's widening pattern.
  nextActionReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { nextActionReducer } from './reducer.js';
export type {
  NextActionReducer,
  NextActionState,
  NextActionDerivationState,
} from './reducer.js';

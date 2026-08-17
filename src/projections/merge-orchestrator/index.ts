/**
 * `merge-orchestrator@v1` projection barrel (Wave 2B.4 / #1304, DR-1).
 *
 * Importing this module has a **side effect**: it registers
 * {@link mergeOrchestratorReducer} with the process-wide {@link defaultRegistry}
 * so the rebuild / rehydrate runners and the Wave 3 `decide` / `aggregateStream`
 * primitives can resolve the reducer by its stable id `"merge-orchestrator@v1"`.
 *
 * This is the DR-1 convention — concrete projections self-register at
 * module load rather than being hand-wired at every call site (mirrors the
 * existing `rehydration` and `next-action` barrels).
 *
 * ## Idempotency
 *
 * The registry rejects duplicate `id` registrations. ES modules are cached
 * per specifier, so importing this barrel from multiple call sites in a
 * single process triggers `register` exactly once. Tests that need an
 * isolated registry should construct a fresh one via `createRegistry()`
 * rather than re-importing this barrel.
 */
import { defaultRegistry } from '../registry.js';
import { mergeOrchestratorReducer } from './reducer.js';

defaultRegistry.register(
  // The reducer is typed `ProjectionReducer<MergeOrchestratorState, WorkflowEvent>`;
  // the registry stores `ProjectionReducer<unknown, unknown>` (generic in
  // name only). Widening here is safe — `apply`'s purity contract (DR-1) is
  // a runtime invariant, not a type-system one, so the cast loses no
  // guarantees. Mirrors the rehydration / next-action barrel pattern.
  mergeOrchestratorReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { mergeOrchestratorReducer } from './reducer.js';
export type {
  MergeOrchestratorState,
  MergeOrchestratorPhase,
  MergePreflightMetadata,
  MergeActionMetadata,
  MergeRecoveryContext,
} from './types.js';

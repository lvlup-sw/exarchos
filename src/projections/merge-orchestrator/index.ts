/**
 * `merge-orchestrator@v1` projection barrel.
 *
 * Importing this module registers {@link mergeOrchestratorReducer} with the
 * process-wide {@link defaultRegistry}, so callers can resolve the reducer by the
 * id `"merge-orchestrator@v1"`. The `rehydration` and `next-action` barrels do the same.
 *
 * The registry rejects a duplicate `id`. ES modules are cached per specifier, so
 * `register` runs once per process. A test that needs an isolated registry must
 * call `createRegistry()`.
 *
 * The cast to the registry parameter type is safe. The registry is generic in name
 * only, and the purity of `apply` is a runtime contract, not a type contract.
 */
import { defaultRegistry } from '../registry.js';
import { mergeOrchestratorReducer } from './reducer.js';

defaultRegistry.register(
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

/**
 * `workflow-state@v1` projection barrel.
 * Importing it registers {@link workflowStateReducer} with {@link defaultRegistry} under the id `"workflow-state@v1"`.
 *
 * The registry rejects a duplicate `id` and a second reducer for the same domain. The module cache runs `register` once in each process.
 * A test that needs a fresh registry must build one with `createRegistry()`.
 * The registry stores `ProjectionReducer<unknown, unknown>`, so the call widens the reducer type.
 * The purity of `apply` is a runtime contract, so the cast loses no guarantee.
 */
import { defaultRegistry } from '../registry.js';
import { workflowStateReducer } from './reducer.js';

defaultRegistry.register(
  workflowStateReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { workflowStateReducer } from './reducer.js';

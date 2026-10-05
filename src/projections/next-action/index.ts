/**
 * Barrel for the `next-action@v1` projection.
 *
 * Importing this module registers {@link nextActionReducer} with {@link defaultRegistry} at module load.
 * The registry rejects a duplicate `id`, and the ES module cache runs `register` once per process.
 * A test that needs an isolated registry must use `createRegistry()`.
 * The registry stores `ProjectionReducer<unknown, unknown>`, so the barrel widens the reducer type.
 * The cast loses no guarantee, because reducer purity is a runtime contract.
 */
import { defaultRegistry } from '../registry.js';
import { nextActionReducer } from './reducer.js';

defaultRegistry.register(
  nextActionReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { nextActionReducer } from './reducer.js';
export type {
  NextActionReducer,
  NextActionState,
  NextActionDerivationState,
} from './reducer.js';

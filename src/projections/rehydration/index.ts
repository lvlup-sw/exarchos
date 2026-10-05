/**
 * The rehydration projection barrel. Importing it registers {@link rehydrationReducer} with
 * {@link defaultRegistry} under the id `"rehydration@v1"`. It also re-exports the reducer and the
 * `RehydrationDocument` type.
 *
 * The registry rejects a duplicate `id`. The module cache runs `register` once in each process.
 * A test that needs a fresh registry must build one with `createRegistry()`.
 * The registry stores `ProjectionReducer<unknown, unknown>`, so the call widens the reducer type.
 * The purity of `apply` is a runtime contract, so the cast loses no guarantee.
 */
import { defaultRegistry } from '../registry.js';
import { rehydrationReducer } from './reducer.js';

defaultRegistry.register(
  rehydrationReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { rehydrationReducer } from './reducer.js';
export type { RehydrationDocument } from './schema.js';

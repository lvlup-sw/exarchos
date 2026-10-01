/**
 * TaskStore projection barrel.
 *
 * Importing this module registers {@link taskStoreReducer} with the process-wide
 * {@link defaultRegistry}, so `decide`, `withSession` and `aggregateStream` can
 * resolve the reducer by the id `"task-store@v1"`.
 *
 * The reducer has `scope: 'stream'` and folds one workflow stream at a time.
 * `./types.ts` tells why one fold over every stream merges the tasks of different features.
 *
 * The registry rejects a duplicate id. ES modules are cached per specifier, so
 * `register` runs once per process. A test that needs an isolated registry must
 * call `createRegistry()`.
 *
 * The cast to the registry parameter type is safe. The registry is generic in name
 * only, and the purity of `apply` is a runtime contract, not a type contract.
 */
import { defaultRegistry } from '../registry.js';
import { taskStoreReducer } from './reducer.js';

defaultRegistry.register(
  taskStoreReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { taskStoreReducer } from './reducer.js';
export type { TaskRecord, TaskStatus, TaskStoreState } from './types.js';

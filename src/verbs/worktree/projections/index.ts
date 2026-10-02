/**
 * The `worktrees@v1` projection barrel.
 * Importing it registers {@link worktreesReducer} with {@link defaultRegistry} as a side effect.
 * The central projections barrel imports this module for that registration.
 *
 * The registry rejects a duplicate id. ES modules load once per specifier, so the registration occurs once per process.
 * A test that needs an isolated registry must call `createRegistry()`.
 * The cast to the registry parameter type is safe, because the purity of `apply` is a runtime contract and not a type contract.
 */
import { defaultRegistry } from '../../../projections/registry.js';
import { worktreesReducer } from './worktrees.js';

defaultRegistry.register(
  worktreesReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { worktreesReducer, createWorktreesReducer } from './worktrees.js';
export type {
  WorktreeEntry,
  WorktreeState,
  WorktreesProjection,
} from './worktrees.js';

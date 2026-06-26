/**
 * `worktrees@v1` projection barrel (WLM foundation, DR-1).
 *
 * Importing this module has a **side effect**: it registers
 * {@link worktreesReducer} with the process-wide {@link defaultRegistry} so the
 * rebuild / rehydrate runners and the per-stream `decide` / `aggregateStream`
 * primitives can resolve the worktree-lifecycle fold by its stable id
 * `"worktrees@v1"`.
 *
 * This is the DR-1 convention — concrete projections self-register at module
 * load (mirrors the `taskstore` / `merge-orchestrator` / `workflow-state`
 * barrels). The central `projections/index.ts` barrel imports this module for
 * that side effect so the registration is live process-wide.
 *
 * ## Idempotency
 *
 * The registry rejects duplicate `id` registrations AND a second reducer
 * claiming the same domain. ES modules are cached per specifier, so importing
 * this barrel from multiple call sites in a single process triggers `register`
 * exactly once. Tests that need an isolated registry should construct a fresh
 * one via `createRegistry()` rather than re-importing this barrel.
 */
import { defaultRegistry } from '../../../projections/registry.js';
import { worktreesReducer } from './worktrees.js';

defaultRegistry.register(
  // The reducer is typed `ProjectionReducer<WorktreesProjection, WorkflowEvent>`;
  // the registry stores `ProjectionReducer<unknown, unknown>` (generic in name
  // only). Widening here is safe — `apply`'s purity contract (DR-1) is a runtime
  // invariant, not a type-system one, so the cast loses no guarantees. Mirrors
  // the sibling barrels.
  worktreesReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { worktreesReducer, createWorktreesReducer } from './worktrees.js';
export type {
  WorktreeEntry,
  WorktreeState,
  WorktreesProjection,
} from './worktrees.js';

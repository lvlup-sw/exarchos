/**
 * `workflow-state@v1` projection barrel (Wave 3 / #1554, DR-1).
 *
 * Importing this module has a **side effect**: it registers
 * {@link workflowStateReducer} with the process-wide {@link defaultRegistry}
 * so the rebuild / rehydrate runners and the per-stream `decide` /
 * `aggregateStream` primitives can resolve the canonical workflow-state fold by
 * its stable id `"workflow-state@v1"`.
 *
 * This is the DR-1 convention — concrete projections self-register at module
 * load (mirrors the `rehydration` / `taskstore` / `merge-orchestrator` /
 * `next-action` barrels).
 *
 * ## Idempotency
 *
 * The registry rejects duplicate `id` registrations AND a second reducer
 * claiming the same domain (registry singularity, #1554). ES modules are cached
 * per specifier, so importing this barrel from multiple call sites in a single
 * process triggers `register` exactly once. Tests that need an isolated
 * registry should construct a fresh one via `createRegistry()` rather than
 * re-importing this barrel.
 */
import { defaultRegistry } from '../registry.js';
import { workflowStateReducer } from './reducer.js';

defaultRegistry.register(
  // The reducer is typed `ProjectionReducer<WorkflowStateView, WorkflowEvent>`;
  // the registry stores `ProjectionReducer<unknown, unknown>` (generic in name
  // only). Widening here is safe — `apply`'s purity contract (DR-1) is a
  // runtime invariant, not a type-system one, so the cast loses no guarantees.
  // Mirrors the sibling barrels.
  workflowStateReducer as unknown as Parameters<typeof defaultRegistry.register>[0],
);

export { workflowStateReducer } from './reducer.js';

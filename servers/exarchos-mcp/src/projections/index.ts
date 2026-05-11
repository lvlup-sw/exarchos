/**
 * Public barrel for the `projections/` module.
 *
 * Re-exports the core reducer contract and the property-test harness used to
 * validate the DR-1 purity invariants across every projection.
 *
 * Side-effect imports below register concrete reducer barrels with the
 * process-wide `defaultRegistry` at module-load time so consumers can resolve
 * reducers by their stable id (e.g. `task-store@v1`) without hand-wiring each
 * call site. New global projections are added here as one side-effect import
 * line per barrel — keep them deliberately separate so wave-merges stay
 * trivial to hand-resolve.
 */

// Wave 2A — TaskStore global projection registration (side-effect import)
import './taskstore/index.js';

export type { ProjectionReducer } from './types.js';
export { assertReducerImmutable } from './testing.js';

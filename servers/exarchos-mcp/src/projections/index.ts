/**
 * Public barrel for the `projections/` module.
 *
 * Re-exports the core reducer contract and the property-test harness used to
 * validate the DR-1 purity invariants across every projection.
 *
 * ## Side-effect imports
 *
 * The per-projection barrels below are imported for their registration side
 * effects (DR-1 convention — concrete projections self-register with
 * `defaultRegistry` at module load). Order is insertion order in the
 * registry's list view; functionally each registration is independent.
 */

// Wave 2B — mergeOrchestrator per-stream projection registration (side-effect import)
import './merge-orchestrator/index.js';

export type { ProjectionReducer } from './types.js';
export { assertReducerImmutable } from './testing.js';

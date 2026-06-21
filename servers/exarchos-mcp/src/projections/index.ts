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
 * `defaultRegistry` at module load). Each new projection adds one
 * side-effect import line per barrel — keep them deliberately separate so
 * wave-merges stay trivial to hand-resolve. Order is insertion order in the
 * registry's list view; functionally each registration is independent.
 */

// Wave 2A — TaskStore global projection registration (side-effect import)
import './taskstore/index.js';

// Wave 2B — mergeOrchestrator per-stream projection registration (side-effect import)
import './merge-orchestrator/index.js';

// Wave 3 (#1554) — canonical workflow-state@v1 reducer registration (side-effect import)
import './workflow-state/index.js';

export type { ProjectionReducer } from './types.js';
export { assertReducerImmutable } from './testing.js';

/**
 * Threshold for surfacing `_meta.projectionLag` on response envelopes
 * (#1359 / PR4 T15). When the delta between `Date.now()` and the
 * projection's `projectionAsOf` exceeds this value, the response builder
 * sets `_meta.projectionLag` to the delta in milliseconds; otherwise the
 * field is omitted (sparse — fresh projections do not carry the field).
 *
 * Five seconds matches the rehydrate audit-event budget used elsewhere in
 * the workflow surface — long enough that normal cold-cache + tail-event
 * folds stay below the bar, short enough that a genuinely stale snapshot
 * (e.g. due to a delayed reducer) surfaces visibly to agents.
 */
export const PROJECTION_LAG_THRESHOLD_MS = 5000;

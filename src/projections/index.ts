/**
 * Public barrel for the `projections/` module.
 *
 * It re-exports the reducer contract and the immutability test helper.
 * The side-effect imports register the concrete projections with `defaultRegistry` at module load.
 * The `taskstore` reducer is stream-scoped, not global.
 */
import './taskstore/index.js';
import './merge-orchestrator/index.js';
import './workflow-state/index.js';
import '../verbs/worktree/projections/index.js';

export type { ProjectionReducer } from './types.js';
export { assertReducerImmutable } from './testing.js';

/**
 * Lag in milliseconds above which a response sets `_meta.projectionLag`.
 * The lag is `Date.now()` minus the projection's `projectionAsOf`. A fresh projection omits the field.
 * Five seconds keeps a normal cold-cache fold below the threshold, and still shows a stale snapshot to agents.
 */
export const PROJECTION_LAG_THRESHOLD_MS = 5000;

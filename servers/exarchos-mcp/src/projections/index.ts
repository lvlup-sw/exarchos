/**
 * Public barrel for the `projections/` module.
 *
 * Re-exports the core reducer contract and the property-test harness used to
 * validate the DR-1 purity invariants across every projection.
 */

export type { ProjectionReducer } from './types.js';
export { assertReducerImmutable } from './testing.js';

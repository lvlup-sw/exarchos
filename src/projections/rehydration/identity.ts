/**
 * The projection-identity pair for rehydration snapshot reads and writes (`projectionId` and `projectionVersion` in `projections/store.ts`).
 * Both values come from the reducer record, so they cannot drift from the `id` and `version` of the registered reducer.
 * If the writer and the reader use different strings, the snapshot lookup misses and the read falls back to a full event replay.
 */

import { rehydrationReducer } from './reducer.js';

export const REHYDRATION_PROJECTION_ID = rehydrationReducer.id;

/**
 * The snapshot record stores `projectionVersion` as a string, but the reducer `version` is a number.
 * This module converts it, so call sites do not have to.
 */
export const REHYDRATION_PROJECTION_VERSION = String(rehydrationReducer.version);

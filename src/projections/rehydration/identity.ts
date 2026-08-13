// Single source of truth for the projection-identity pair used by snapshot
// reads/writes (`projectionId`, `projectionVersion` — see
// `projections/store.ts`). Derived from the reducer record so the strings
// cannot drift away from the registered reducer's `id` / `version` fields.
//
// Until this file existed, `workflow/rehydrate.ts` and `workflow/tools.ts`
// each held module-local copies of the same two literals — flagged by
// sentry[bot] on PR #1178 (discussion_r3142455946) as a drift surface that,
// if violated, would cause snapshot lookups to silently fall back to
// full-event replay instead of using the cached snapshot.

import { rehydrationReducer } from './reducer.js';

export const REHYDRATION_PROJECTION_ID = rehydrationReducer.id;

// `projections/store.ts` records `projectionVersion` as a string on the
// snapshot record (it is a discriminator written into JSONL alongside the
// projection state). The reducer's `version` field is `number` per the
// `ProjectionReducer` interface. Coerce here so call sites do not have to.
export const REHYDRATION_PROJECTION_VERSION = String(rehydrationReducer.version);

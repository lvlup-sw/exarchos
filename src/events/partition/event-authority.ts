// RESERVED(issue: #1876, owner: exarchos, expires: 2027-03-31) — production code
// with no production importer yet. It is the shipped classification, not test
// infrastructure. A doctor check, a retention policy, and an append-path refusal
// will read it, and none of them exist yet.
//
// The first consumer must carry two facts. Telemetry is a fold fact, not a stream
// placement, so a retention policy filters rows and never drops a stream. The
// argument-rewriting path in `projections/telemetry/middleware.ts` becomes
// correctness-bearing with no partition change. It is dormant because every
// dispatcher call passes three arguments.

/**
 * The live governance and telemetry partition over the shipped event catalog. It
 * builds at module load, so a contradictory or stale witness or demotion fails at
 * load. Both sets come from the map, so neither can drift from it.
 */

import { EventTypes, type EventType } from '../schemas.js';
import { ANNOTATED_EVENTS } from '../event-annotations.js';
import { EMISSION_SOURCE_BY_TIER, type EmissionSource } from '../event-registration.js';
import { deriveEventAuthority, partitionByAuthority, type EventAuthority } from './authority.js';
import { CHARTER_DEMOTIONS } from './demotions.js';
import { GOVERNANCE_WITNESSES } from './witnesses.js';

/**
 * The emission source of the tier for an event type, without lifecycle. See
 * `authority.ts` for why authority ignores whether the event is emitted now.
 */
export function tierEmissionSourceOf(eventType: string): EmissionSource | undefined {
  const registration = ANNOTATED_EVENTS.registrationOf(eventType);
  return registration === undefined ? undefined : EMISSION_SOURCE_BY_TIER[registration.tier];
}

const DERIVED: Record<string, EventAuthority> = deriveEventAuthority(
  EventTypes,
  tierEmissionSourceOf,
  GOVERNANCE_WITNESSES,
  CHARTER_DEMOTIONS,
);

/** Built from `EventTypes`, so its key set is the catalog. */
export const EVENT_AUTHORITY: Record<EventType, EventAuthority> = DERIVED;

const PARTITION = partitionByAuthority(DERIVED);

/** Events something depends on: the fold consumes them, or a raw reader does. */
export const GOVERNANCE_EVENTS: ReadonlySet<string> = PARTITION.governance;

/**
 * Events that record what happened, and from which the canonical fold decides nothing.
 *
 * The differential behind this partition covers only `workflowStateProjection`.
 * Five registered views fold telemetry, and two of them derive a verdict from it.
 * This module re-exports those views as {@link VERDICT_BEARING_VIEWS}. Membership
 * bounds what a retention policy can drop from the canonical state only.
 */
export const TELEMETRY_EVENTS: ReadonlySet<string> = PARTITION.telemetry;

export { VERDICT_BEARING_VIEWS, VIEW_TELEMETRY_DEPENDENCE } from './view-dependence.js';

/**
 * The authority of one event type, or `undefined` for a type outside the catalog.
 * A runtime-registered custom type has no tier, so any other answer is a guess.
 */
export function classifyEventAuthority(eventType: string): EventAuthority | undefined {
  return DERIVED[eventType];
}

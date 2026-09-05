// RESERVED(issue: #1876, owner: exarchos, expires: 2027-03-31) — production code
// with no production importer YET. The partition is the map every later consumer
// reads: the doctor check that reports a demotion candidate, the retention policy
// that may drop a telemetry event, and the append path that will refuse to accept
// a governance event on a telemetry channel. None of those exist, and wiring one
// on the strength of a map whose oracles were written in the same change would be
// asserting the map is settled before anything has tried to use it. It is
// deliberately NOT claimed as test infrastructure: this is the shipped
// classification, not gate machinery, and misfiling it would buy a permanent
// exemption for a module that is supposed to become load-bearing.
//
// Two facts the first consumer has to carry, recorded here because no other
// module holds them. (1) Telemetry is a FOLD fact, not a stream placement:
// `subagent.tokens_used` and `stack.submitted` ride feature streams beside
// governance rows, and the SubagentStop append keys its idempotency per stream,
// so a retention policy that drops telemetry is a row filter, never a stream
// drop. (2) The one in-tree reader that would become correctness-bearing with
// no partition change is the telemetry middleware's argument-rewriting path
// (`projections/telemetry/middleware.ts`, `autoCorrectionOptions`), dormant
// today because every dispatcher call passes three arguments; the view-level
// differential the tracker's item 9 asks for should name it.

/**
 * The live governance/telemetry partition over the shipped event catalog.
 *
 * Built EAGERLY at module scope, the way `EVENT_EMISSION_REGISTRY` is, so a
 * population that cannot be partitioned fails at load rather than at whichever
 * consumer happens to ask first — a witness or demotion that contradicts the
 * other table, or names a type the catalog no longer has, is a load failure
 * here, not a quiet winner. The two sets are derived from the map by
 * partition — neither is authored, so neither can drift from it.
 */

import { EventTypes, type EventType } from '../schemas.js';
import { ANNOTATED_EVENTS } from '../event-annotations.js';
import { EMISSION_SOURCE_BY_TIER, type EmissionSource } from '../event-registration.js';
import { deriveEventAuthority, partitionByAuthority, type EventAuthority } from './authority.js';
import { CHARTER_DEMOTIONS } from './demotions.js';
import { GOVERNANCE_WITNESSES } from './witnesses.js';

/**
 * The tier's emission source for an event type, with lifecycle deliberately
 * NOT composed in — see `authority.ts` for why authority reads the weld rather
 * than whether the event is currently emitted.
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

/**
 * Total over the catalog by construction: built FROM `EventTypes`, so its key
 * set cannot differ from the catalog's.
 */
export const EVENT_AUTHORITY: Record<EventType, EventAuthority> = DERIVED;

const PARTITION = partitionByAuthority(DERIVED);

/** Events something depends on: the fold consumes them, or a raw reader does. */
export const GOVERNANCE_EVENTS: ReadonlySet<string> = PARTITION.governance;

/** Events that record what happened and that nothing decides anything from. */
export const TELEMETRY_EVENTS: ReadonlySet<string> = PARTITION.telemetry;

/**
 * The authority of one event type, or `undefined` for a type outside the
 * catalog — a runtime-registered custom type has no tier here, and answering
 * `'telemetry'` for it would be a guess dressed as a derivation.
 */
export function classifyEventAuthority(eventType: string): EventAuthority | undefined {
  return DERIVED[eventType];
}

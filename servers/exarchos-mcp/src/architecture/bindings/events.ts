// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — the composition root for
// DR-3's event-name grammar census and G3's report-coupling ratchet. It inherits their
// disposition: no production importer by design, because it binds instruments that govern the
// event registry rather than participating in it. Its consumers are those censuses' own suites
// and the CI guards that run them. Deleted when both censuses are.
//
/**
 * Bindings lifted from the event subsystem — the registry, the name grammar and
 * the emission-source tables.
 *
 * `events/schemas.ts` is a DR-1 declaration STORE, so this module must not
 * import a contract module (`contract/declaration.ts`,
 * `contract/declaration-seam.ts`). See `./README.md`.
 */
import {
  EVENT_EMISSION_REGISTRY,
  EVENT_NAME_PATTERN,
  EventTypes,
  getValidEventTypes,
  isBuiltInEventType,
} from '../../events/schemas.js';
import { classifyEventName, WORD_SEPARATORS } from '../../events/event-name.js';
import type { WordSeparator } from '../../events/event-name.js';
import {
  ANNOTATED_EVENTS,
  tierSourceDisagreements,
  type DeclaredEmissionSources,
} from '../../events/event-annotations.js';
import { resolveEmissionSource } from '../../events/event-registration.js';
import type { EventAnnotationSource } from '../../events/event-declarations.js';
import {
  censusEventNameGrammar,
  type EventGrammarCensusReport,
  type EventGrammarPorts,
} from '../event-grammar-census.js';
import {
  auditReportCouplingRatchet,
  auditReportCouplingSeed,
  auditReportCouplingSeedIntegrity,
  censusReportCoupling,
  type ReportCouplingCensusReport,
  type ReportCouplingPinAudit,
  type ReportCouplingPorts,
  type ReportCouplingRatchetVerdict,
  type ReportCouplingSeedAudit,
} from '../report-coupling-census.js';

/** The shipped grammar authorities, as ports. */
export const EVENT_GRAMMAR_PORTS: EventGrammarPorts = Object.freeze({
  classify: classifyEventName,
  isBuiltIn: isBuiltInEventType,
});

/** The word separators the shipped grammar concedes. */
export const LIVE_SEPARATORS: readonly WordSeparator[] = WORD_SEPARATORS;

/** The live event-name pattern. */
export const LIVE_EVENT_NAME_PATTERN: RegExp = EVENT_NAME_PATTERN;

/**
 * The event-name grammar census over the live registry.
 *
 * The three leading parameters keep their live defaults so a caller can vary one
 * axis — an emptied subject, a repaired pattern, a narrowed separator set —
 * without restating the others.
 */
export function censusLiveEventNameGrammar(
  names: readonly string[] = getValidEventTypes(),
  shippedPattern: RegExp = EVENT_NAME_PATTERN,
  separators: readonly WordSeparator[] = WORD_SEPARATORS,
): EventGrammarCensusReport {
  return censusEventNameGrammar(names, shippedPattern, separators, EVENT_GRAMMAR_PORTS);
}

/** The shipped emission-source composition and tier-disagreement teeth, as ports. */
export const REPORT_COUPLING_PORTS: ReportCouplingPorts = Object.freeze({
  resolveSource: resolveEmissionSource,
  disagreements: tierSourceDisagreements,
});

/**
 * The report-coupling census over the live registry.
 *
 * The three leading parameters keep their live defaults so the co-located vitest can vary one
 * axis — an emptied subject, a seeded report-coupled type, a seeded tier/source disagreement —
 * without mutating the real registry.
 */
export function censusLiveReportCoupling(
  registeredTypes: readonly string[] = EventTypes,
  annotations: EventAnnotationSource = ANNOTATED_EVENTS,
  declared: DeclaredEmissionSources = EVENT_EMISSION_REGISTRY,
): ReportCouplingCensusReport {
  return censusReportCoupling(registeredTypes, annotations, declared, REPORT_COUPLING_PORTS);
}

/**
 * The composed report-coupling ratchet over the live tree — the verdict CI reads.
 *
 * Both halves default to their live audit so a caller can substitute one (a seeded
 * membership audit, say) and still get the real pin alongside it.
 */
export function auditLiveReportCouplingRatchet(
  membership: ReportCouplingSeedAudit = auditReportCouplingSeed(censusLiveReportCoupling()),
  pin: ReportCouplingPinAudit = auditReportCouplingSeedIntegrity(),
): ReportCouplingRatchetVerdict {
  return auditReportCouplingRatchet(membership, pin);
}

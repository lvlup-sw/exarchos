// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — the composition root for the
// event-name grammar census and the report-coupling ratchet. It has no production importer by
// design, because it binds instruments that govern the event registry. Its consumers are the
// suites of those censuses and the CI guards that run them. Delete it with both censuses.
/**
 * Bindings lifted from the event subsystem: the registry, the name grammar and the
 * emission-source tables.
 *
 * `events/schemas.ts` is a declaration store, so this module must not import a contract
 * module (`contract/declaration.ts`, `contract/declaration-seam.ts`).
 */
import {
  EVENT_EMISSION_REGISTRY,
  EVENT_NAME_PATTERN,
  EventTypes,
  getValidEventTypes,
  isBuiltInEventType,
} from '../../../../src/events/schemas.js';
import { classifyEventName, WORD_SEPARATORS } from '../../../../src/events/event-name.js';
import type { WordSeparator } from '../../../../src/events/event-name.js';
import {
  ANNOTATED_EVENTS,
  tierSourceDisagreements,
  type DeclaredEmissionSources,
} from '../../../../src/events/event-annotations.js';
import { resolveEmissionSource } from '../../../../src/events/event-registration.js';
import type { EventAnnotationSource } from '../../../../src/events/event-declarations.js';
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
 * Each parameter defaults to its live value. A caller can vary one axis, such as a
 * repaired pattern, and keep the others live.
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
 * Each parameter defaults to its live value. A test can vary one axis, such as a seeded
 * tier/source disagreement, and leave the real registry unchanged.
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
  today: string,
  membership: ReportCouplingSeedAudit = auditReportCouplingSeed(today, censusLiveReportCoupling()),
  pin: ReportCouplingPinAudit = auditReportCouplingSeedIntegrity(),
): ReportCouplingRatchetVerdict {
  return auditReportCouplingRatchet(today, membership, pin);
}

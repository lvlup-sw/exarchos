// RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28) — G3, the DR-2 report-coupled
// ratchet. Its verdict is executed by `scripts/report-coupling-ratchet-guard.ts` and its kill
// fixtures by the co-located vitest, both on the UNFILTERED `grep-gates` deps tail; it has no
// production importer by design, because it governs the registry rather than participating in it.
// Deleted when the seed reaches its DR-20 floor.
//
/**
 * G3 — the report-coupling census and ratchet (DR-2, task 013).
 *
 * ── The finding this instrument makes measurable ────────────────────────────
 * A registered event type is REPORT-COUPLED when its DR-2 coupling derives the emission source
 * `'model'`: nothing in the handler tree appends it, so the record exists only if the model
 * remembers to make a dedicated `exarchos_event.append`. That is the weakest possible coupling — a
 * record that survives exactly as long as the model's attention does — and DR-2's whole point is to
 * make the class unwritable at rung 2 (there is no report-coupled VARIANT to construct) while this
 * census shrinks the population that predates the union at rung 3.
 *
 * This module is the rung-3 half. It enumerates the live registry, partitions it by derived
 * coupling, and lays a shrink-only membership ratchet over the measurement. It reuses the existing
 * instrument rather than adding one: the population comes from `events/event-annotations.ts`'s
 * `reportCoupledEventTypes` (task 010), the disagreement tooth from the same module's
 * `tierSourceDisagreements`, and the audit vocabulary and three-teeth shape from
 * `architecture/output-schema-census.ts` (G2, DR-4) — `EMPTY_CENSUS` / `UNTRUSTWORTHY_CENSUS` /
 * a growth code / a `STALE_*` code / `SEED_KEY_SET_DRIFT`. A second vocabulary for the same class
 * of failure would be the multiple-authority defect this program exists to remove.
 *
 * ── Why the verdict is STRUCTURAL, not textual ──────────────────────────────
 * The tempting detector is a scan of `schemas.ts` for `'model'`. This wave has seven recorded
 * occurrences of that mistake — a raw-text scanner standing in for a real parse — and it would be
 * wrong twice over here. A text scan of the registry reads the DECLARED `source` column, which is
 * precisely the representation DR-2 replaces; and it cannot see coupling at all, only the string
 * someone wrote next to an event name.
 *
 * So no text is scanned. The census reads the REGISTRATION OBJECTS and composes their two axes
 * through `resolveEmissionSource`, exactly as the union defines it. There is nothing for a comment,
 * a template literal, or a renamed constant to fool, because none of those are ever parsed.
 *
 * ── The two authorities, and why their agreement is a PRECONDITION ──────────
 * Until task 011 derives `EVENT_EMISSION_REGISTRY` from the tier, two authorities can each answer
 * "is this event report-coupled?": the ANNOTATIONS (derived, this census's input) and the REGISTRY
 * (declared). If they disagree about a type, the population being ratcheted is ambiguous and the
 * seed comparison means nothing — so a disagreement is a census DIAGNOSTIC, not a passing detail.
 * Task 010 recorded exactly one live disagreement with an owner
 * ({@link UNRECONCILED_REGISTRATIONS}); that record is honoured here and, like every other
 * exception in this program, it is checked in the stale direction too, so it cannot rot into cover.
 *
 * ── Why the count is DERIVED, never written down ────────────────────────────
 * No cardinality appears in this module. Every number it returns is computed from the enumerated
 * records on each call, and the seed is a MEMBERSHIP list rather than a threshold. The
 * complementary guard is `EMPTY_CENSUS`: enumerating ZERO registrations is a FAILURE, never a clean
 * run. Without that tooth the instrument reads green precisely when it has stopped working, which
 * is the failure mode a census exists to prevent.
 */
import type { DeclaredEmissionSources } from '../../../src/events/event-annotations.js';
import type { EmissionAxes } from '../../../src/events/event-registration.js';
// Type-only, and deliberately so: the union is the shipped vocabulary this
// census reports in, and re-declaring it here would let the two drift apart
// silently. A `import type` erases at compile time, so it creates no package
// edge and no DR-1 storage read.
import type { EventEmissionSource } from '../../../src/events/schemas.js';
import type { EventAnnotationSource } from '../../../src/events/event-declarations.js';
// The day rule, the expiry verdict and the key-set canonicalisation are one
// authority for every ledger in this tree. This module used to roll its own
// `isExpired`; both are the ledger's now, and with them comes the horizon tooth
// this ratchet lacked.
import {
  auditWaiverLedger,
  measureKeySetPin,
  type WaiverLedgerSubject,
} from './waiver-ledger.js';
import { keySetDigest } from './waiver-ledger-digest.js';

import {
  REPORT_COUPLING_SEED,
  REPORT_COUPLING_SEED_IDS,
  REPORT_COUPLING_RETIRED_IDS,
  type ReportCouplingSeedEntry,
} from './report-coupling-seed.js';
import {
  REPORT_COUPLING_EXPIRY_HORIZON,
  REPORT_COUPLING_SEED_DIGEST_ALGORITHM,
  REPORT_COUPLING_SEED_KEY_SET_DIGEST,
} from './report-coupling-seed-pin.js';

/**
 * The shipped event-subsystem behaviours this census measures against.
 *
 * They arrive as ports rather than imports: this module is conformance code and
 * must not reach into the tree it inspects, and `events/schemas.ts` is a DR-1
 * declaration store besides. The composition root binds the real functions.
 */
export interface ReportCouplingPorts {
  /** Compose an emission source from a registration's two axes. */
  readonly resolveSource: (registration: EmissionAxes) => EventEmissionSource;
  /** The events whose declared source disagrees with their tier. */
  readonly disagreements: (
    declared: DeclaredEmissionSources,
    annotations: EventAnnotationSource,
  ) => readonly { readonly eventType: string }[];
}

/**
 * The two-way partition every registered event type falls into.
 *
 * `report-coupled` — the derived emission source is `'model'`. The model must remember the append.
 * `handler-coupled` — some handler owns the append (`'auto'`), a hook fires it (`'hook'`), or the
 * lifecycle axis says it is not emitted at all (`'planned'` / `'retired'`). None of these depend on
 * the model's attention, which is the property that matters.
 */
export type CouplingClass = 'report-coupled' | 'handler-coupled';

/** One enumerated registration and its verdict. */
export interface ReportCouplingRecord {
  /** The registered event type, e.g. `review.finding`. The ratchet's unit of record. */
  readonly eventType: string;
  readonly classification: CouplingClass;
  /** The source `resolveEmissionSource` composed from the registration's two axes. */
  readonly derivedSource: string;
  /** The tier the annotation declares, carried so a report can be read without a second lookup. */
  readonly tier: string;
}

/**
 * A condition that makes the census itself untrustworthy.
 *
 * Note what is NOT here: the mere EXISTENCE of report-coupled registrations. That is the
 * measurement, not a fault — policy over the measurement belongs to the ratchet below, not to the
 * detector. Mirrors {@link import('./output-schema-census.js').CensusDiagnostic}.
 */
export type ReportCouplingDiagnostic =
  | { readonly code: 'EMPTY_CENSUS'; readonly message: string }
  | {
      readonly code: 'UNANNOTATED_REGISTRATION';
      readonly eventType: string;
      readonly message: string;
    }
  | {
      readonly code: 'TIER_SOURCE_DISAGREEMENT';
      readonly eventType: string;
      readonly message: string;
    };
// `STALE_UNRECONCILED_RECORD` was retired when task 011 landed. It audited
// `UNRECONCILED_REGISTRATIONS` in the stale direction; task 011 deleted that exception list along
// with the second authority that made exceptions possible, so the code had no constructible
// subject. Retiring it is the point, not a loss: the class moved from "audited at rung 3" to
// "unconstructible at rung 2", which is the move this whole wave is about.

export interface ReportCouplingCensusReport {
  /** True when the census enumerated a non-empty subject and could classify all of it. */
  readonly ok: boolean;
  /** Registrations enumerated. The census denominator — zero is a failure. */
  readonly total: number;
  /** Derived: `reportCoupled.length`. Never a literal. */
  readonly reportCoupledCount: number;
  /** Sorted event types whose coupling derives `'model'` — the G3 ratchet's subject. */
  readonly reportCoupled: readonly string[];
  /** Sorted event types some handler, hook or lifecycle state accounts for. */
  readonly handlerCoupled: readonly string[];
  /** Every enumerated registration, sorted by event type. */
  readonly records: readonly ReportCouplingRecord[];
  readonly diagnostics: readonly ReportCouplingDiagnostic[];
}

/**
 * Enumerate the live registry and partition it by DERIVED coupling.
 *
 * All three inputs default to the live triple, so the production call is `censusReportCoupling()`.
 * They are injectable seams for the same reason `censusOutputSchemas` takes `tools`: the co-located
 * vitest has to drive compositions the live tree cannot produce — an emptied subject, a seeded 26th
 * report-coupled type, a seeded tier/source disagreement — without mutating the real registry.
 *
 * `registeredTypes` is the DENOMINATOR and it comes from the registry, not from the annotation
 * table. That direction matters: keying off the annotations would make an un-annotated registration
 * invisible instead of a finding, and "the events we remembered to annotate are all annotated" is
 * true by construction.
 */
export function censusReportCoupling(
  registeredTypes: readonly string[],
  annotations: EventAnnotationSource,
  declared: DeclaredEmissionSources,
  ports: ReportCouplingPorts,
): ReportCouplingCensusReport {
  const records: ReportCouplingRecord[] = [];
  const diagnostics: ReportCouplingDiagnostic[] = [];

  for (const eventType of registeredTypes) {
    const registration = annotations.registrationOf(eventType);
    if (registration === undefined) {
      // Fail CLOSED. An un-annotated registration cannot be shown NOT to be report-coupled, and
      // dropping it would shrink the denominator silently — the cheapest way to make any census
      // report a smaller number than the truth.
      diagnostics.push({
        code: 'UNANNOTATED_REGISTRATION',
        eventType,
        message:
          `'${eventType}' is a registered event type with no DR-2 annotation, so its coupling ` +
          'cannot be derived and the census cannot prove it is not report-coupled. Annotate it in ' +
          'events/event-annotations.ts with a tier and a lifecycle.',
      });
      continue;
    }
    const derivedSource = ports.resolveSource(registration);
    records.push({
      eventType,
      classification: derivedSource === 'model' ? 'report-coupled' : 'handler-coupled',
      derivedSource,
      tier: registration.tier,
    });
  }

  records.sort((a, b) => a.eventType.localeCompare(b.eventType));
  const reportCoupled = records
    .filter((r) => r.classification === 'report-coupled')
    .map((r) => r.eventType);
  const handlerCoupled = records
    .filter((r) => r.classification === 'handler-coupled')
    .map((r) => r.eventType);

  // The two authorities must agree about the population before the seed comparison means anything.
  //
  // Integration note (task 011 landed after this census was written). This block originally ran a
  // TWO-WAY ratchet against `UNRECONCILED_REGISTRATIONS` — task 010's recorded exception list —
  // auditing the stale direction so a record that stopped disagreeing had to be deleted rather than
  // left standing as cover. Task 011 then **removed the second authority entirely**:
  // `EVENT_EMISSION_REGISTRY` is no longer 170 hand-written values, it is
  // `deriveEmissionRegistry(EventTypes, ANNOTATED_EVENTS.registrationOf)`. With no per-event source
  // site left to author, a live declared-vs-derived disagreement is unconstructible, the single
  // recorded exception (`benchmark.completed`) was settled in favour of the measurement, and the
  // exception list was deleted along with the population it covered.
  //
  // The stale-direction half went with it — auditing an exception list that cannot have entries is
  // the vacuity this program exists to remove, and `STALE_UNRECONCILED_RECORD` left the diagnostic
  // vocabulary for the same reason.
  //
  // The forward check STAYS, and is not vacuous: `declared` is a parameter, so a caller that
  // supplies a hand-authored map still gets a real verdict. That is exactly how
  // `ReportCoupling_SeededTierSourceDisagreement_IsReported` seeds one, and it is the guard that
  // fires if a future change re-introduces an independently-authored registry.
  const live = new Set(ports.disagreements(declared, annotations).map((d) => d.eventType));
  for (const eventType of [...live].sort()) {
    diagnostics.push({
      code: 'TIER_SOURCE_DISAGREEMENT',
      eventType,
      message:
        `'${eventType}' derives a different EventEmissionSource from its DR-2 tier than the ` +
        'supplied registry declares for it. Two authorities disagree about whether this event is ' +
        'report-coupled, so the population this ratchet governs is ambiguous. Since task 011 the ' +
        'live registry is DERIVED from the tier, so this can only fire for a caller-supplied map — ' +
        'fix the annotation, or stop hand-authoring the source.',
    });
  }

  // Non-empty-denominator guard. A census over an empty subject is not a clean run — it is a census
  // that lost its subject (module moved, import broken, registry emptied). Without this tooth the
  // instrument reads green exactly when it has stopped working.
  if (records.length === 0) {
    diagnostics.push({
      code: 'EMPTY_CENSUS',
      message:
        'The report-coupling census enumerated ZERO registrations. A census with an empty ' +
        'denominator proves nothing and MUST fail rather than report clean. Check that ' +
        'events/schemas.ts still resolves and still exports a non-empty EventTypes.',
    });
  }

  return Object.freeze({
    ok: diagnostics.length === 0,
    total: records.length,
    reportCoupledCount: reportCoupled.length,
    reportCoupled: Object.freeze(reportCoupled),
    handlerCoupled: Object.freeze(handlerCoupled),
    records: Object.freeze(records),
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * Render the census for a human or an agent.
 *
 * Reports the report-coupled count together with the denominator it was measured against — a
 * proportion without its denominator is the same rubber stamp this module exists to remove.
 */
export function formatReportCouplingCensus(report: ReportCouplingCensusReport): string {
  const share =
    report.total === 0 ? '—' : `${((report.reportCoupledCount / report.total) * 100).toFixed(1)}%`;
  const lines: string[] = [
    `report-coupling census: ${report.reportCoupledCount} report-coupled of ${report.total} ` +
      `registrations (${share}); ${report.handlerCoupled.length} handler-coupled.`,
  ];

  const byTier = new Map<string, number>();
  for (const record of report.records) {
    if (record.classification !== 'report-coupled') continue;
    byTier.set(record.tier, (byTier.get(record.tier) ?? 0) + 1);
  }
  if (byTier.size > 0) {
    lines.push('  report-coupled by tier:');
    for (const [tier, count] of [...byTier.entries()].sort()) {
      lines.push(`    ${String(count).padStart(5)}  ${tier}`);
    }
  }

  if (report.diagnostics.length > 0) {
    lines.push('');
    lines.push(`  ${report.diagnostics.length} diagnostic(s) — the census is NOT trustworthy:`);
    for (const diagnostic of report.diagnostics) {
      const subject = 'eventType' in diagnostic ? ` ${diagnostic.eventType}:` : '';
      lines.push(`    [${diagnostic.code}]${subject} ${diagnostic.message}`);
    }
  }

  return lines.join('\n');
}

// ─── G3's ratchet: the shrink-only seed ─────────────────────────────────────
//
// The census above MEASURES. This is the policy laid over the measurement.
//
// Why membership and not a count: a threshold ("no more than 25 report-coupled types") is satisfied
// by swapping — pay one down, introduce another, and the number never moves. The audit below
// compares SETS in both directions, so a swap surfaces as two findings even though the cardinality
// is unchanged. The subset rule also IMPLIES the count ceiling, so "permits only decrease" is the
// weaker half of what is enforced.

/** A condition that makes the seed and the live census disagree. */
export type ReportCouplingSeedFinding =
  | { readonly code: 'UNREADABLE_CLOCK'; readonly message: string }
  | { readonly code: 'MALFORMED_HORIZON'; readonly message: string }
  | { readonly code: 'EMPTY_CENSUS'; readonly message: string }
  | { readonly code: 'EMPTY_SEED'; readonly message: string }
  | { readonly code: 'UNTRUSTWORTHY_CENSUS'; readonly message: string }
  | {
      readonly code: 'UNSEEDED_REPORT_COUPLING';
      readonly eventType: string;
      readonly message: string;
    }
  | { readonly code: 'STALE_SEED_ENTRY'; readonly eventType: string; readonly message: string }
  | { readonly code: 'MALFORMED_SEED_ENTRY'; readonly eventType: string; readonly message: string }
  | {
      readonly code: 'SEED_ENTRY_BEYOND_HORIZON';
      readonly eventType: string;
      readonly message: string;
    }
  | { readonly code: 'EXPIRED_SEED_ENTRY'; readonly eventType: string; readonly message: string };

export interface ReportCouplingSeedAudit {
  /** True when the seed is EXACTLY the live report-coupled population and nothing has lapsed. */
  readonly ok: boolean;
  /** Registrations enumerated. Zero is a failure, never a clean run. */
  readonly total: number;
  /** The pinned horizon the entries were measured against. */
  readonly horizon: string;
  /** Live report-coupled event types, sorted — the measurement. */
  readonly reportCoupled: readonly string[];
  /** Seeded event types, sorted — the policy. */
  readonly seeded: readonly string[];
  /** Report-coupled today with no seed entry. New coupling; the ratchet's growth tooth. */
  readonly unseeded: readonly string[];
  /** Seeded but no longer report-coupled. Paid-down debt that must MOVE to the graveyard. */
  readonly stale: readonly string[];
  /** Seed entries whose ISO expiry has passed. */
  readonly expired: readonly string[];
  /** Seed entries dated later than the pinned horizon — a self-granted renewal. */
  readonly beyondHorizon: readonly string[];
  /** Seed entries with a blank owner or an unparseable `expires`. Fails closed. */
  readonly malformed: readonly string[];
  readonly findings: readonly ReportCouplingSeedFinding[];
}

/**
 * DR-2's nouns, handed to the shared ledger. Built per call because the
 * `blockedBy` annotation is a function of the seed table under audit, which the
 * co-located vitest replaces.
 */
function seedLedgerSubject(
  seed: Readonly<Record<string, ReportCouplingSeedEntry>>,
): WaiverLedgerSubject {
  return {
    authority: 'DR-2',
    ledger: 'report-coupling seed',
    entry: 'seed entry',
    entries: 'seed entries',
    horizonSource: 'REPORT_COUPLING_EXPIRY_HORIZON in report-coupling-seed-pin.ts',
    paydown:
      'An expiry that lapses quietly is a decoration, not a deadline. Give the event a ' +
      'handler-owned append and MOVE its entry to REPORT_COUPLING_RETIRED.',
    horizonPaydown:
      'Re-couple the event (give it a handler-owned append and MOVE its entry to ' +
      'REPORT_COUPLING_RETIRED)',
    zeroState:
      'If the debt really did reach its DR-20 floor, the seed module, its pin and this audit ' +
      'are DELETED in the same commit.',
    annotate: (eventType: string): string => {
      const blockedBy = seed[eventType]?.blockedBy;
      return blockedBy === undefined ? '' : `, blockedBy: ${blockedBy}`;
    },
  };
}

/**
 * Audit the shrink-only seed against the live census.
 *
 * `today` is REQUIRED and has no default. Nothing in this module reads the wall clock: a library
 * that does turns "the debt came due" into "the test suite stopped working", and a developer who
 * cannot run tests fixes the CLOCK rather than the debt. This module's guard IS its co-located
 * vitest, so an ambient `new Date()` here would have reddened every developer's unit suite on
 * 2027-03-01 for a reason unrelated to their change. The single production clock read lives at
 * `scripts/report-coupling-ratchet-guard.ts`, the entrypoint that blocks the merge. Dates are
 * compared as ISO `YYYY-MM-DD` STRINGS, never as `Date` values — lexicographic order on that format
 * IS calendar order, so the verdict has no timezone, no DST and no millisecond component to flip on.
 *
 * Every OTHER input defaults to the live value, so the production call is
 * `auditReportCouplingSeed(isoDayUtc(new Date()))`. They are injectable for the same reason the
 * census takes `registeredTypes`: the co-located vitest has to drive compositions the live tree
 * cannot produce (an emptied subject, a seeded 26th type, a lapsed expiry) without touching the real
 * registry or the real seed.
 *
 * Seven teeth. The last two arrived with DR-6: this ratchet enforced a per-entry `expires` and
 * capped it with nothing, so a blanket re-date was a legal-looking diff — the renewal hole its two
 * sibling ledgers were built without. The extraction closed it rather than carrying it forward.
 *   0. READABLE CLOCK / HORIZON. A `today` or a horizon that is not a real calendar day makes the
 *      comparison it governs meaningless, so the audit FAILS rather than reporting the seed live
 *      against a nonsense date.
 *   1. NON-EMPTY DENOMINATOR, on both populations: a census over zero registrations and a seed over
 *      zero entries each make "nothing has lapsed" true for the worst possible reason.
 *   2. UNSEEDED_REPORT_COUPLING. An event that is report-coupled today and not on the list. This is
 *      the runtime mirror of DR-2's compile-time tooth, and it is what catches coupling that
 *      entered through a path the union does not govern — a runtime-registered custom type, or an
 *      annotation edited to a tier that derives `'model'`.
 *   3. STALE_SEED_ENTRY. A seed entry whose event is no longer report-coupled — re-coupled, or
 *      deleted outright. There is no way to park a paid-down entry: the moment the debt is paid,
 *      the entry MOVES to the graveyard. That is what makes the list shrink-only rather than merely
 *      bounded.
 *   4. MALFORMED_SEED_ENTRY. A blank owner or an `expires` that is not a real calendar day fails
 *      closed rather than reading as "in date".
 *   5. SEED_ENTRY_BEYOND_HORIZON. An entry dated past {@link REPORT_COUPLING_EXPIRY_HORIZON}. An
 *      entry may not name its own deadline, so extending the debt collapses to moving ONE pinned
 *      constant in a file of frozen values.
 *   6. EXPIRED_SEED_ENTRY. An entry past its ISO date. The spec rejects "wave-scoped" labels
 *      because they are not mechanically evaluable; enforcing the date is what makes this an expiry
 *      rather than a decoration.
 */
export function auditReportCouplingSeed(
  today: string,
  report: ReportCouplingCensusReport,
  seed: Readonly<Record<string, ReportCouplingSeedEntry>> = REPORT_COUPLING_SEED,
  horizon: string = REPORT_COUPLING_EXPIRY_HORIZON,
): ReportCouplingSeedAudit {
  const findings: ReportCouplingSeedFinding[] = [];

  // The ledger returns the temporal verdict; this maps it onto G3's names. The
  // ledger-wide findings lead (they say the audit itself cannot be trusted); the
  // per-entry ones are held back so the report still reads membership-first.
  const ledger = auditWaiverLedger(today, seed, horizon, seedLedgerSubject(seed));
  const perEntry: ReportCouplingSeedFinding[] = [];
  for (const finding of ledger.findings) {
    const eventType = finding.id ?? '';
    switch (finding.code) {
      case 'UNREADABLE_CLOCK':
        findings.push({ code: 'UNREADABLE_CLOCK', message: finding.message });
        break;
      case 'MALFORMED_HORIZON':
        findings.push({ code: 'MALFORMED_HORIZON', message: finding.message });
        break;
      case 'EMPTY_LEDGER':
        findings.push({ code: 'EMPTY_SEED', message: finding.message });
        break;
      case 'MALFORMED_ENTRY':
        perEntry.push({ code: 'MALFORMED_SEED_ENTRY', eventType, message: finding.message });
        break;
      case 'BEYOND_HORIZON':
        perEntry.push({ code: 'SEED_ENTRY_BEYOND_HORIZON', eventType, message: finding.message });
        break;
      case 'EXPIRED':
        perEntry.push({ code: 'EXPIRED_SEED_ENTRY', eventType, message: finding.message });
        break;
      default: {
        // A `switch` with no `default` compiles fine when the union grows, so a
        // seventh ledger code would have been dropped here in silence — by a
        // mapping whose comment claims it carries every verdict across. The
        // `never` assignment makes that a COMPILE error instead.
        const unmapped: never = finding.code;
        throw new Error(
          `report-coupling-census: unmapped waiver-ledger finding code ${String(unmapped)}. ` +
            'Every ledger verdict must be given a G3 name, or the audit silently drops it.',
        );
      }
    }
  }

  if (report.total === 0) {
    findings.push({
      code: 'EMPTY_CENSUS',
      message:
        'The report-coupling census enumerated ZERO registrations, so this audit has an empty ' +
        'denominator and proves nothing. An audit that reports clean against no subject is the ' +
        'instrument dying green — the exact failure mode G3 exists to prevent. Check that the ' +
        'event registry still resolves and still declares event types.',
    });
  } else if (!report.ok) {
    findings.push({
      code: 'UNTRUSTWORTHY_CENSUS',
      message:
        `The census raised ${report.diagnostics.length} diagnostic(s), so its report-coupled ` +
        'partition cannot be trusted as the audit input. Resolve the census diagnostics before ' +
        'reading this verdict.',
    });
  }

  const reportCoupled = [...report.reportCoupled].sort();
  const seeded = [...new Set(Object.keys(seed))].sort();
  const coupledSet = new Set(reportCoupled);
  const seededSet = new Set(seeded);
  const registered = new Set(report.records.map((r) => r.eventType));

  const unseeded = reportCoupled.filter((eventType) => !seededSet.has(eventType));
  const stale = seeded.filter((eventType) => !coupledSet.has(eventType));

  for (const eventType of unseeded) {
    findings.push({
      code: 'UNSEEDED_REPORT_COUPLING',
      eventType,
      message:
        `'${eventType}' is report-coupled today — its DR-2 coupling derives 'model', so the ` +
        'record exists only when the model remembers a dedicated append — and it carries no seed ' +
        'entry. Give it a handler-owned append and annotate the tier that follows. Adding an ' +
        'entry to report-coupling-seed.ts is NOT the fix: the seed may only shrink, and the ' +
        'frozen key-set pin makes an addition a red build.',
    });
  }
  for (const eventType of stale) {
    findings.push({
      code: 'STALE_SEED_ENTRY',
      eventType,
      message: registered.has(eventType)
        ? `'${eventType}' is seeded in the report-coupling ratchet but is no longer ` +
          'report-coupled. The debt is paid — MOVE its line from REPORT_COUPLING_SEED to ' +
          'REPORT_COUPLING_RETIRED with a retiredAt date. Deleting it outright breaks the key-set ' +
          'pin, which is deliberate.'
        : `'${eventType}' is seeded in the report-coupling ratchet but no such event type is ` +
          'registered any more. MOVE its line to REPORT_COUPLING_RETIRED with a retiredAt date.',
    });
  }
  findings.push(...perEntry);

  return Object.freeze({
    ok: findings.length === 0,
    total: report.total,
    horizon: ledger.horizon,
    reportCoupled: Object.freeze(reportCoupled),
    seeded: Object.freeze(seeded),
    unseeded: Object.freeze(unseeded),
    stale: Object.freeze(stale),
    expired: ledger.expired,
    beyondHorizon: ledger.beyondHorizon,
    malformed: ledger.malformed,
    findings: Object.freeze(findings),
  });
}

// ─── G3's third tooth: the seed key set is pinned ───────────────────────────
//
// `auditReportCouplingSeed` above compares the seed against TODAY, in both directions. What it
// structurally cannot see is an IN-PLACE SWAP: drop `a` (genuinely re-coupled) and add `c` (newly
// report-coupled) in the same edit, and every comparison against today's registry agrees. The
// cardinality is unchanged, so a count cannot see it either.
//
// Detecting "only removals happened" requires PRIOR STATE, and prior state is not derivable — it is
// written down once, in `report-coupling-seed-pin.ts`. The quantity pinned is the union of the live
// seed and the retirement graveyard, which is INVARIANT under the one legal edit (a paydown MOVES
// an entry from one map to the other). So the pin never changes for legitimate work, and any change
// to it is by construction someone re-seeding.

/** A condition that means the SEED's key set is no longer the one that was pinned. */
export type ReportCouplingPinFinding =
  | { readonly code: 'SEED_KEY_SET_DRIFT'; readonly message: string }
  | { readonly code: 'RETIRED_AND_SEEDED'; readonly eventType: string; readonly message: string };

export interface ReportCouplingPinAudit {
  /** True when the live key set hashes to the pinned digest and the two maps are disjoint. */
  readonly ok: boolean;
  /** `|seed ∪ retired|` — the seed's size, which legal edits do not change. */
  readonly keySetSize: number;
  /** Digest computed from the live key set. */
  readonly digest: string;
  /** Digest recorded when the seed was frozen. */
  readonly pinnedDigest: string;
  /** Event types present in BOTH maps. A paydown is a MOVE, never a copy. */
  readonly overlapping: readonly string[];
  readonly findings: readonly ReportCouplingPinFinding[];
}

/**
 * The seed key set's digest: `sha256` over the sorted, deduplicated ids joined by newlines.
 *
 * Order- and duplicate-insensitive on purpose — the pinned quantity is a SET, so re-sorting the
 * seed literal or writing an id twice must not move the digest. Only membership does. Both halves
 * of that rule live in the DR-6 ledger; only the algorithm label is G3's.
 */
export function reportCouplingSeedDigest(ids: readonly string[]): string {
  return keySetDigest(ids, REPORT_COUPLING_SEED_DIGEST_ALGORITHM);
}

/**
 * Audit the seed's key set against its frozen pin.
 *
 * All three inputs are injectable for the same reason the census takes its population: the
 * co-located vitest has to pose an in-place swap, and a swap cannot be posed against the real seed
 * without editing the real seed.
 *
 * Two findings:
 *   • `SEED_KEY_SET_DRIFT` — the union of seeded + retired ids no longer hashes to the pin. Adding
 *     an id trips it; so does deleting one outright instead of retiring it. The message says what
 *     the legal edit is, because the tempting "fix" (regenerate the pin) is the failure this tooth
 *     exists to prevent.
 *   • `RETIRED_AND_SEEDED` — an id in both maps. Harmless to the digest (a set union absorbs it)
 *     and therefore worth catching separately: it means a paydown was recorded as a copy rather
 *     than a move, which leaves a live seed entry for an event someone believes is retired.
 */
export function auditReportCouplingSeedIntegrity(
  seeded: readonly string[] = REPORT_COUPLING_SEED_IDS,
  retired: readonly string[] = REPORT_COUPLING_RETIRED_IDS,
  pinnedDigest: string = REPORT_COUPLING_SEED_KEY_SET_DIGEST,
): ReportCouplingPinAudit {
  const findings: ReportCouplingPinFinding[] = [];

  const pin = measureKeySetPin(seeded, retired, pinnedDigest, reportCouplingSeedDigest);
  const { keySet, overlapping, digest } = pin;

  if (pin.drifted) {
    findings.push({
      code: 'SEED_KEY_SET_DRIFT',
      message:
        `The report-coupling seed's key set no longer matches its frozen pin: ${keySet.length} ` +
        `id(s) hash to ${digest}, pinned ${pinnedDigest}. The key set is SEED ∪ RETIRED, and it is ` +
        'invariant under every legal edit — re-coupling an event MOVES its entry from ' +
        'REPORT_COUPLING_SEED to REPORT_COUPLING_RETIRED, it does not delete it. A drift therefore ' +
        'means an id was ADDED (new report-coupling smuggled in as a swap, which no comparison ' +
        "against today's registry can see) or DELETED (a paydown recorded as a deletion, which " +
        'destroys the prior state this tooth is made of). Do NOT regenerate the pin to go green.',
    });
  }

  for (const eventType of overlapping) {
    findings.push({
      code: 'RETIRED_AND_SEEDED',
      eventType,
      message:
        `'${eventType}' is in BOTH the report-coupling seed and the retirement record. A paydown ` +
        'is a MOVE, not a copy — delete the REPORT_COUPLING_SEED line. Left as is, the event reads ' +
        'as retired while still holding a live seed entry.',
    });
  }

  return Object.freeze({
    ok: findings.length === 0,
    keySetSize: pin.keySetSize,
    digest,
    pinnedDigest,
    overlapping: Object.freeze([...overlapping]),
    findings: Object.freeze(findings),
  });
}

/** Every finding G3's ratchet can raise, from either half. */
export type ReportCouplingRatchetFinding = ReportCouplingSeedFinding | ReportCouplingPinFinding;

export interface ReportCouplingRatchetVerdict {
  readonly ok: boolean;
  readonly membership: ReportCouplingSeedAudit;
  readonly pin: ReportCouplingPinAudit;
  readonly findings: readonly ReportCouplingRatchetFinding[];
}

/**
 * G3's ratchet, whole: membership + expiry against today, PLUS the seed key set against its pin.
 *
 * `today` is REQUIRED here for the same reason it is required on the membership half — see
 * {@link auditReportCouplingSeed}. Everything else defaults to the live artifact, so the production
 * call is `auditReportCouplingRatchet(isoDayUtc(new Date()))`.
 *
 * The two halves are complementary, and neither is sufficient:
 *   • membership alone is blind to a swap that edits the seed;
 *   • the pin alone is blind to a seeded event that stopped being report-coupled.
 * Together the only green path is: re-couple the event, then move the entry.
 */
export function auditReportCouplingRatchet(
  today: string,
  membership: ReportCouplingSeedAudit,
  pin: ReportCouplingPinAudit = auditReportCouplingSeedIntegrity(),
): ReportCouplingRatchetVerdict {
  void today;
  const findings: ReportCouplingRatchetFinding[] = [...membership.findings, ...pin.findings];
  return Object.freeze({
    ok: membership.ok && pin.ok,
    membership,
    pin,
    findings: Object.freeze(findings),
  });
}

/** Render the seed audit for a human or an agent. */
export function formatReportCouplingSeedAudit(audit: ReportCouplingSeedAudit): string {
  const lines: string[] = [
    `report-coupling seed: ${audit.seeded.length} seeded, ${audit.reportCoupled.length} ` +
      `report-coupled of ${audit.total} registrations — ${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      const subject = 'eventType' in finding ? ` ${finding.eventType}:` : '';
      lines.push(`    [${finding.code}]${subject} ${finding.message}`);
    }
  }
  return lines.join('\n');
}

/** Render the key-set pin audit for a human or an agent. */
export function formatReportCouplingPinAudit(audit: ReportCouplingPinAudit): string {
  const lines: string[] = [
    `report-coupling seed key set: ${audit.keySetSize} id(s), digest ${audit.digest} vs pinned ` +
      `${audit.pinnedDigest} — ${audit.ok ? 'OK' : 'FAILED'}.`,
  ];
  if (audit.findings.length > 0) {
    lines.push(`  ${audit.findings.length} finding(s):`);
    for (const finding of audit.findings) {
      const subject = 'eventType' in finding ? ` ${finding.eventType}:` : '';
      lines.push(`    [${finding.code}]${subject} ${finding.message}`);
    }
  }
  return lines.join('\n');
}

/** Render the whole G3 verdict — census, membership and pin — as one report. */
export function formatReportCouplingRatchet(
  verdict: ReportCouplingRatchetVerdict,
  census: ReportCouplingCensusReport,
): string {
  return [
    formatReportCouplingCensus(census),
    formatReportCouplingSeedAudit(verdict.membership),
    formatReportCouplingPinAudit(verdict.pin),
    `G3 report-coupling ratchet: ${verdict.ok ? 'PASS' : 'FAIL'} — ${verdict.findings.length} finding(s).`,
  ].join('\n');
}

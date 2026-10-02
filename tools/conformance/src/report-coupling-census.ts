/**
 * RESERVED(issue: #1473, owner: exarchos, expires: 2027-02-28)
 *
 * The report-coupling census and its shrink-only ratchet. The guard
 * `tools/audit/core/report-coupling-ratchet-guard.ts` runs the verdict, and the co-located vitest
 * runs the kill fixtures. No production code imports this module, because it governs the registry.
 * Delete it when the seed reaches its floor.
 *
 * A registered event type is report-coupled when its coupling derives the emission source
 * `'model'`. No handler appends it, so the record exists only if the model makes a dedicated
 * `exarchos_event.append`. The census reads the registration objects and composes their two axes
 * through `resolveEmissionSource`. It scans no text. Every import from `src/events` is
 * `import type`, so it adds no runtime edge. An empty census is a failure, not a clean run.
 */
import type { DeclaredEmissionSources } from '../../../src/events/event-annotations.js';
import type { EmissionAxes } from '../../../src/events/event-registration.js';
import type { EventEmissionSource } from '../../../src/events/schemas.js';
import type { EventAnnotationSource } from '../../../src/events/event-declarations.js';
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
 * The shipped event-subsystem functions that this census measures against. They arrive as ports,
 * because conformance code must not import the tree that it inspects, and `events/schemas.ts` is a
 * declaration store. The composition root binds the real functions.
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
 * The two classes of a registered event type. `report-coupled`: the derived emission source is
 * `'model'`, so the model must remember the append. `handler-coupled`: any other source, such as a
 * handler (`'auto'`), a hook (`'hook'`), or a lifecycle that does not emit (`'planned'`,
 * `'retired'`).
 */
export type CouplingClass = 'report-coupled' | 'handler-coupled';

/** One enumerated registration and its verdict. */
export interface ReportCouplingRecord {
  /** The registered event type, for example `review.finding`. The unit of record for the ratchet. */
  readonly eventType: string;
  readonly classification: CouplingClass;
  /** The source `resolveEmissionSource` composed from the registration's two axes. */
  readonly derivedSource: string;
  /** The tier the annotation declares, carried so a report can be read without a second lookup. */
  readonly tier: string;
}

/**
 * A condition that makes the census itself untrustworthy. A report-coupled registration is a
 * measurement, not a fault. Mirrors {@link import('./output-schema-census.js').CensusDiagnostic}.
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

export interface ReportCouplingCensusReport {
  /** True when the census enumerated a non-empty subject and classified all of it. */
  readonly ok: boolean;
  /** Registrations enumerated. The census denominator — zero is a failure. */
  readonly total: number;
  /** Derived: `reportCoupled.length`. Never a literal. */
  readonly reportCoupledCount: number;
  /** Sorted event types whose coupling derives `'model'`. This is the subject of the ratchet. */
  readonly reportCoupled: readonly string[];
  /** Sorted event types some handler, hook or lifecycle state accounts for. */
  readonly handlerCoupled: readonly string[];
  /** Every enumerated registration, sorted by event type. */
  readonly records: readonly ReportCouplingRecord[];
  readonly diagnostics: readonly ReportCouplingDiagnostic[];
}

/**
 * Enumerates the live registry and partitions it by derived coupling. Every input is a parameter.
 * Thus the co-located vitest can drive an empty subject, an extra report-coupled type or a tier and
 * source disagreement. The composition root binds the live values.
 *
 * `registeredTypes` is the denominator, and it comes from the registry, not from the annotations.
 * An unannotated registration fails closed as a diagnostic, so it cannot shrink the denominator. A
 * tier and source disagreement is a diagnostic, because the ratcheted population is then
 * ambiguous. A caller can pass a hand-written `declared` map to seed one. An empty subject raises
 * `EMPTY_CENSUS`.
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

/** Renders the census for a human or an agent. The report-coupled count appears with its denominator. */
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
  /** Report-coupled today with no seed entry. This is the growth check. */
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
 * The nouns of this ledger, for the shared waiver ledger. It is built per call, because the
 * `blockedBy` annotation reads the seed table under audit, and the co-located vitest replaces it.
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
 * Audits the shrink-only seed against the live census. It compares sets in both directions. When
 * the tree re-couples one seeded event and adds a new report-coupled event, the audit gives two
 * findings at the same count. `today` has no default, because this module reads no wall clock.
 * The guard reads the clock and blocks the merge. Dates compare as ISO `YYYY-MM-DD` strings.
 *
 * The findings come in this order: ledger-wide, census, membership, then per-entry. A new ledger
 * finding code is a compile error at the `never` assignment, not a silent drop.
 */
export function auditReportCouplingSeed(
  today: string,
  report: ReportCouplingCensusReport,
  seed: Readonly<Record<string, ReportCouplingSeedEntry>> = REPORT_COUPLING_SEED,
  horizon: string = REPORT_COUPLING_EXPIRY_HORIZON,
): ReportCouplingSeedAudit {
  const findings: ReportCouplingSeedFinding[] = [];

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
 * The digest of the seed key set: `sha256` over the sorted, deduplicated ids joined by newlines.
 * The pinned quantity is a set, so the order of the ids and a duplicate id do not change it.
 */
export function reportCouplingSeedDigest(ids: readonly string[]): string {
  return keySetDigest(ids, REPORT_COUPLING_SEED_DIGEST_ALGORITHM);
}

/**
 * Audits the seed key set against its frozen pin. The membership audit cannot see an in-place swap
 * at the same count. The pin covers the union of the seed and the retired map, which the one legal
 * edit (a move from seed to retired) leaves unchanged.
 *
 * `SEED_KEY_SET_DRIFT` means that an id was added, or deleted instead of moved. `RETIRED_AND_SEEDED`
 * means that an id is in both maps. The union hides that overlap, so this audit reports it.
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
 * The whole ratchet: membership and expiry against today, and the seed key set against its pin.
 * Membership alone misses a swap. The pin alone misses a seeded event that is not report-coupled
 * any more. The function does not read `today`, because `membership` already applied the date.
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

/** Renders the census, the membership audit and the pin audit as one report. */
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

// G3's assertions live here. The census module is a pure library; this file IS the guard, which is
// why `ci.yml` runs it as a named step on the UNFILTERED `grep-gates` deps tail rather than relying
// on the path-filtered `test-mcp` job (#1711: a gate in a path-filtered job is skipped-as-passed on
// exactly the PRs it polices). DR-24's "each guard's self-test runs in the same CI job as the
// guard" is satisfied for free by that arrangement — the kill fixtures below run in the same step.
//
// The set-equality assertions below compare THREE MUTUALLY UNREACHABLE authorities, which is what
// makes them falsifiable rather than a restatement of one representation:
//
//   1. `../events/event-annotations.ts` — the LIVE event-store graph. Both halves of the
//      "two authorities" argument in the census header live under this one root: the registration
//      objects, and the `source` column `schemas.ts` declares. They are two REPRESENTATIONS that
//      DR-2 is collapsing, but the DR-30 detector is right that they are ONE static-import
//      authority, so only the root is declared here. (An earlier revision of this header named all
//      three modules and DR-30 rejected it — "one authority wearing two names". The correction is
//      recorded rather than quietly applied, because the distinction is the whole point of the
//      rule: their agreement is a finding about the TREE, not about two independent oracles.)
//   2. `./report-coupling-seed.ts` — the frozen membership list. Imports nothing.
//   3. `./report-coupling-seed-pin.ts` — the frozen key-set digest. Imports nothing, deliberately,
//      so it cannot observe the thing it pins.
//
// @oracle-sources: ../../../servers/exarchos-mcp/src/events/event-annotations.ts, ./report-coupling-seed.ts, ./report-coupling-seed-pin.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { EVENT_EMISSION_REGISTRY, EventTypes } from '../../../servers/exarchos-mcp/src/events/schemas.js';
import { ANNOTATED_EVENTS, EVENT_ANNOTATIONS } from '../../../servers/exarchos-mcp/src/events/event-annotations.js';
import type { EventAnnotationSource } from '../../../servers/exarchos-mcp/src/events/event-declarations.js';
import type { EventRegistration } from '../../../servers/exarchos-mcp/src/events/event-registration.js';
import {
  auditLiveReportCouplingRatchet,
  censusLiveReportCoupling,
} from './bindings/events.js';
import {
  auditReportCouplingSeed,
  auditReportCouplingSeedIntegrity,
  formatReportCouplingCensus,
  formatReportCouplingRatchet,
  reportCouplingSeedDigest,
} from './report-coupling-census.js';
import {
  REPORT_COUPLING_SEED,
  REPORT_COUPLING_SEED_IDS,
  REPORT_COUPLING_RETIRED_IDS,
  type ReportCouplingSeedEntry,
} from './report-coupling-seed.js';
import { REPORT_COUPLING_SEED_KEY_SET_DIGEST } from './report-coupling-seed-pin.js';

// ─── Fixture helpers ────────────────────────────────────────────────────────
//
// Every fixture composes an annotation SOURCE, never a source-text string. The census reads
// registration objects, so the only honest way to pose a counterfactual is to hand it a different
// object graph.

/** An annotation source over an explicit table, defaulting to the live one for untouched keys. */
function sourceOver(overrides: Readonly<Record<string, EventRegistration>>): EventAnnotationSource {
  const table: Readonly<Record<string, EventRegistration>> = { ...EVENT_ANNOTATIONS, ...overrides };
  return { registrationOf: (eventType: string): EventRegistration | undefined => table[eventType] };
}

/** A registration whose coupling derives `'model'` — i.e. report-coupled. */
const REPORT_COUPLED: EventRegistration = {
  lifecycle: 'active',
  tier: 'judgment',
  gate: 'review-verdict',
  contentSchema: z.object({ note: z.string() }),
};

/** A registration whose coupling derives `'auto'` — i.e. NOT report-coupled. */
const HANDLER_COUPLED: EventRegistration = {
  lifecycle: 'active',
  tier: 'substrate',
  rationale: 'transition-record',
};

/** A seed table shaped like the real one, for the counterfactuals the live seed cannot pose. */
function seedOver(
  ids: readonly string[],
  entry: ReportCouplingSeedEntry = { owner: 'test', expires: '2999-01-01' },
): Readonly<Record<string, ReportCouplingSeedEntry>> {
  return Object.fromEntries(ids.map((id) => [id, entry]));
}

describe('G3 report-coupling census (DR-2, task 013)', () => {
  it('ReportCouplingCensus_LiveRegistry_IsCleanAndNonEmpty', () => {
    const census = censusLiveReportCoupling();

    // NON-EMPTY DENOMINATOR, asserted on the live subject and not only in the seeded case below.
    // A census reporting "0 report-coupled of 0" is what a moved module looks like.
    expect(census.total).toBeGreaterThan(0);
    expect(census.total).toBe(EventTypes.length);
    expect(census.diagnostics, formatReportCouplingCensus(census)).toEqual([]);
    expect(census.ok).toBe(true);

    // The population is non-vacuous. A seed of zero would make G3 trivially satisfied forever.
    expect(census.reportCoupledCount).toBeGreaterThan(0);
    expect(census.reportCoupledCount).toBe(census.reportCoupled.length);
    expect(census.reportCoupledCount + census.handlerCoupled.length).toBe(census.total);
  });

  it('ReportCouplingCensus_SeedEqualsTheLivePopulation_DerivedNotTranscribed', () => {
    const census = censusLiveReportCoupling();

    // The seed is the measurement, not a transcription of it. Re-derived on every run, so a
    // hand-edited seed key that names no report-coupled registration turns this red.
    expect([...REPORT_COUPLING_SEED_IDS]).toEqual([...census.reportCoupled]);

    // THIRD DIRECTION. `EVENT_EMISSION_REGISTRY` is an independent authority (the declared `source`
    // column). It agrees on the SET, not merely the count — which is what makes the seed a fact
    // about coupling rather than a copy of one representation.
    const declaredModelEmitted = EventTypes.filter(
      (eventType) => EVENT_EMISSION_REGISTRY[eventType] === 'model',
    ).sort();
    expect([...census.reportCoupled]).toEqual(declaredModelEmitted);
  });

  it('ReportCouplingRatchet_LiveTree_Passes', () => {
    const verdict = auditLiveReportCouplingRatchet();
    // Render the failure through the module's own composite formatter rather than re-deriving a
    // message here. It exists to print exactly this verdict (census + membership + pin), and a
    // second hand-rolled rendering is a second authority on what the guard says when it fails.
    // It was also this module's only unreferenced export — knip flagged it, correctly, as the
    // R-11 shape: shipped and called by nothing.
    expect(verdict.findings, formatReportCouplingRatchet(verdict, censusLiveReportCoupling())).toEqual(
      [],
    );
    expect(verdict.ok).toBe(true);

    // The pin covers the whole seed on the landing branch: nothing has been retired yet, so the key
    // set and the seed coincide.
    expect(verdict.pin.keySetSize).toBe(REPORT_COUPLING_SEED_IDS.length);
    expect(verdict.pin.digest).toBe(REPORT_COUPLING_SEED_KEY_SET_DIGEST);
  });
});

describe('G3 kill fixtures — the ratchet must be able to go red', () => {
  // THE KILL FIXTURE THE TASK NAMES. The seeded population is the subject; a 26th report-coupled
  // registration is the falsifier. Both cardinalities are asserted, so a ratchet that silently
  // widened its seed could not pass this by reporting the same verdict against a bigger list.
  it('ReportCouplingRatchet_SeededAdditionalReportCoupling_IsRejected', () => {
    const seededType = 'zz.seeded.report_coupled';
    const census = censusLiveReportCoupling(
      [...EventTypes, seededType],
      sourceOver({ [seededType]: REPORT_COUPLED }),
      { ...EVENT_EMISSION_REGISTRY, [seededType]: 'model' },
    );

    // BOTH numbers, so "the count moved" is asserted rather than inferred.
    expect(censusLiveReportCoupling().reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length);
    expect(census.reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length + 1);

    const audit = auditReportCouplingSeed(census);
    expect(audit.ok).toBe(false);
    expect(audit.unseeded).toEqual([seededType]);
    expect(audit.findings.map((f) => f.code)).toContain('UNSEEDED_REPORT_COUPLING');

    // And the composed verdict — the thing CI reads — is red, not merely the sub-audit.
    expect(auditLiveReportCouplingRatchet(audit).ok).toBe(false);
  });

  it('ReportCouplingCensus_ZeroRegistrations_FailsRatherThanReportingClean', () => {
    const census = censusLiveReportCoupling([], sourceOver({}), {});
    expect(census.total).toBe(0);
    expect(census.ok).toBe(false);
    expect(census.diagnostics.map((d) => d.code)).toContain('EMPTY_CENSUS');

    // The failure must survive into the audit, which is what CI actually reads. An audit that
    // reported "0 unseeded — clean" against no subject is the instrument dying green.
    const audit = auditReportCouplingSeed(census);
    expect(audit.ok).toBe(false);
    expect(audit.findings.map((f) => f.code)).toContain('EMPTY_CENSUS');
    expect(auditLiveReportCouplingRatchet(audit).ok).toBe(false);
  });

  it('ReportCouplingCensus_UnannotatedRegistration_FailsClosed', () => {
    // An event the annotation table does not know cannot be shown NOT to be report-coupled.
    const census = censusLiveReportCoupling([...EventTypes, 'zz.unannotated'], ANNOTATED_EVENTS);
    expect(census.ok).toBe(false);
    expect(census.diagnostics.map((d) => d.code)).toContain('UNANNOTATED_REGISTRATION');

    // Fail-closed means it is EXCLUDED from the denominator rather than silently counted clean,
    // and the audit refuses to read an untrustworthy partition.
    expect(census.total).toBe(EventTypes.length);
    expect(auditReportCouplingSeed(census).findings.map((f) => f.code)).toContain(
      'UNTRUSTWORTHY_CENSUS',
    );
  });

  it('ReportCouplingCensus_SeededTierSourceDisagreement_IsRejected', () => {
    // G3 self-test (1): a seeded disagreement between the declared source and the tier-derived one.
    const census = censusLiveReportCoupling(EventTypes, ANNOTATED_EVENTS, {
      ...EVENT_EMISSION_REGISTRY,
      'workflow.started': 'model',
    });
    expect(census.ok).toBe(false);
    const disagreements = census.diagnostics.filter((d) => d.code === 'TIER_SOURCE_DISAGREEMENT');
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toMatchObject({ eventType: 'workflow.started' });
  });

  // `ReportCouplingCensus_StaleUnreconciledRecord_IsRejected` was RETIRED when task 011 landed.
  //
  // It asserted `UNRECONCILED_REGISTRATIONS.length > 0` and then proved that a record which stopped
  // disagreeing was reported as stale cover. Its own comment anticipated the end: "so it cannot rot
  // into cover once task 011 resolves it." Task 011 resolved it — `EVENT_EMISSION_REGISTRY` is now
  // derived from the tier rather than hand-written, the one recorded disagreement
  // (`benchmark.completed`) was settled in favour of the measurement, and the exception list was
  // deleted with the population it covered.
  //
  // The test is removed rather than weakened because its subject is gone, not because it became
  // inconvenient: with no exception list there is no stale record to construct, and a test whose
  // precondition cannot hold is the vacuity this wave exists to delete. The forward direction is
  // still covered by `ReportCoupling_SeededTierSourceDisagreement_IsReported`, which supplies a
  // hand-authored map and is therefore still constructible.

  it('ReportCouplingSeed_PaidDownEntry_MustMoveRatherThanLinger', () => {
    // Re-couple one seeded event: its seed entry is now stale and must be RETIRED, not parked.
    const paidDown = REPORT_COUPLING_SEED_IDS[0] ?? '';
    const census = censusLiveReportCoupling(
      EventTypes,
      sourceOver({ [paidDown]: HANDLER_COUPLED }),
      { ...EVENT_EMISSION_REGISTRY, [paidDown]: 'auto' },
    );

    expect(census.reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length - 1);
    const audit = auditReportCouplingSeed(census);
    expect(audit.stale).toEqual([paidDown]);
    expect(audit.findings.map((f) => f.code)).toContain('STALE_SEED_ENTRY');
    expect(audit.ok).toBe(false);
  });

  it('ReportCouplingSeed_LapsedExpiry_Fails', () => {
    const census = censusLiveReportCoupling();
    const lapsed = seedOver(REPORT_COUPLING_SEED_IDS, { owner: 'test', expires: '2020-01-01' });

    const audit = auditReportCouplingSeed(census, lapsed, new Date('2026-08-07T00:00:00Z'));
    expect(audit.expired).toEqual([...REPORT_COUPLING_SEED_IDS]);
    expect(audit.findings.map((f) => f.code)).toContain('EXPIRED_SEED_ENTRY');
    expect(audit.ok).toBe(false);

    // The same seed one day BEFORE its expiry is clean — so the tooth measures the date, not merely
    // the presence of an `expires` field.
    const future = seedOver(REPORT_COUPLING_SEED_IDS, { owner: 'test', expires: '2026-08-07' });
    expect(auditReportCouplingSeed(census, future, new Date('2026-08-07T23:59:00Z')).ok).toBe(true);
  });

  it('ReportCouplingSeedIntegrity_InPlaceSwap_TripsThePin', () => {
    // The swap no comparison against today can see: drop one id, add another, same cardinality.
    const swapped = [...REPORT_COUPLING_SEED_IDS.slice(1), 'zz.newly.coupled'];
    expect(swapped).toHaveLength(REPORT_COUPLING_SEED_IDS.length);

    const audit = auditReportCouplingSeedIntegrity(swapped, REPORT_COUPLING_RETIRED_IDS);
    expect(audit.ok).toBe(false);
    expect(audit.findings.map((f) => f.code)).toContain('SEED_KEY_SET_DRIFT');
  });

  it('ReportCouplingSeedIntegrity_LegalPaydownMove_LeavesThePinUnchanged', () => {
    // The one legal edit: MOVE an id from the seed to the graveyard. The union is invariant, so the
    // pin must not move — otherwise the pin would have to be regenerated on every paydown, which
    // would make it carry no information at all.
    const moved = REPORT_COUPLING_SEED_IDS[0] ?? '';
    const audit = auditReportCouplingSeedIntegrity(
      REPORT_COUPLING_SEED_IDS.filter((id) => id !== moved),
      [...REPORT_COUPLING_RETIRED_IDS, moved],
    );
    expect(audit.ok).toBe(true);
    expect(audit.digest).toBe(REPORT_COUPLING_SEED_KEY_SET_DIGEST);
  });

  it('ReportCouplingSeedIntegrity_PaydownRecordedAsACopy_IsCaught', () => {
    const copied = REPORT_COUPLING_SEED_IDS[0] ?? '';
    const audit = auditReportCouplingSeedIntegrity(REPORT_COUPLING_SEED_IDS, [copied]);
    expect(audit.overlapping).toEqual([copied]);
    expect(audit.findings.map((f) => f.code)).toContain('RETIRED_AND_SEEDED');
    expect(audit.ok).toBe(false);
  });
});

describe('G3 measures coupling, not the declared source column', () => {
  // The measure-the-wrong-property class this wave has hit seven times. A census that read
  // `EVENT_EMISSION_REGISTRY[eventType] === 'model'` would pass every test above, because the two
  // authorities agree on the live tree. These two cases separate them, and only the structural
  // derivation gets both right.

  it('ReportCouplingCensus_DerivedModelWithDeclaredAuto_CountsAsReportCoupled', () => {
    const seededType = 'zz.derived.model';
    const census = censusLiveReportCoupling(
      [...EventTypes, seededType],
      sourceOver({ [seededType]: REPORT_COUPLED }),
      { ...EVENT_EMISSION_REGISTRY, [seededType]: 'auto' },
    );

    // A column-reader would classify this handler-coupled and report the seeded count unchanged.
    expect(census.reportCoupled).toContain(seededType);
    expect(census.reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length + 1);
    // …and it is a disagreement, because the declared column now contradicts the tier.
    expect(census.diagnostics.map((d) => d.code)).toContain('TIER_SOURCE_DISAGREEMENT');
  });

  it('ReportCouplingCensus_DerivedAutoWithDeclaredModel_IsNotReportCoupled', () => {
    const seededType = 'zz.declared.model';
    const census = censusLiveReportCoupling(
      [...EventTypes, seededType],
      sourceOver({ [seededType]: HANDLER_COUPLED }),
      { ...EVENT_EMISSION_REGISTRY, [seededType]: 'model' },
    );

    // A column-reader would count 26 here. The structural derivation counts 25.
    expect(census.reportCoupled).not.toContain(seededType);
    expect(census.reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length);
    expect(census.handlerCoupled).toContain(seededType);
  });
});

describe('G3 policy is data the guard reads', () => {
  it('ReportCouplingSeed_EveryEntry_CarriesAnOwnerAndAnIsoExpiry', () => {
    expect(REPORT_COUPLING_SEED_IDS.length).toBeGreaterThan(0);
    for (const eventType of REPORT_COUPLING_SEED_IDS) {
      const entry = REPORT_COUPLING_SEED[eventType];
      expect(entry, eventType).toBeDefined();
      expect(entry?.owner ?? '', eventType).not.toBe('');
      expect(entry?.expires ?? '', eventType).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('ReportCouplingSeed_BlockedByExemption_IsPinnedAtTheTwoTeamTypes', () => {
    // R-8: the #1473 exemption is ratchet-pinned at 2 so it cannot widen unnoticed. A third
    // `blockedBy` entry is a visible, reviewable act — this assertion is what makes it visible.
    const blocked = REPORT_COUPLING_SEED_IDS.filter(
      (eventType) => REPORT_COUPLING_SEED[eventType]?.blockedBy !== undefined,
    );
    expect(blocked).toEqual(['team.disbanded', 'team.spawned']);
    for (const eventType of blocked) {
      expect(REPORT_COUPLING_SEED[eventType]?.blockedBy).toBe('#1473');
    }
  });

  it('ReportCouplingSeedDigest_IsSetValued_NotOrderOrDuplicateSensitive', () => {
    const ids = [...REPORT_COUPLING_SEED_IDS];
    const shuffled = [...ids].reverse();
    expect(reportCouplingSeedDigest(shuffled)).toBe(reportCouplingSeedDigest(ids));
    expect(reportCouplingSeedDigest([...ids, ids[0] ?? ''])).toBe(reportCouplingSeedDigest(ids));
  });
});

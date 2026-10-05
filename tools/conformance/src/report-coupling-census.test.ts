// Self-tests for the report-coupling ratchet. `ci.yml` runs this file in the unfiltered
// `grep-gates` job, next to `tools/audit/core/report-coupling-ratchet-guard.ts`. A path-filtered
// job skips a gate on the PRs that it polices.
//
// The set-equality assertions compare three authorities that cannot reach each other:
//   1. `src/events/event-annotations.ts`, the live event-store graph. The registration objects and
//      the `source` column are two representations under this one static-import root.
//   2. `./report-coupling-seed.ts`, the frozen membership list. It imports nothing.
//   3. `./report-coupling-seed-pin.ts`, the frozen key-set digest. It imports nothing, so it cannot
//      observe what it pins.
//
// @oracle-sources: ../../../src/events/event-annotations.ts, ./report-coupling-seed.ts, ./report-coupling-seed-pin.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EVENT_EMISSION_REGISTRY, EventTypes } from '../../../src/events/schemas.js';
import { ANNOTATED_EVENTS, EVENT_ANNOTATIONS } from '../../../src/events/event-annotations.js';
import type { EventAnnotationSource } from '../../../src/events/event-declarations.js';
import type { EventRegistration } from '../../../src/events/event-registration.js';
import { auditLiveReportCouplingRatchet, censusLiveReportCoupling } from './bindings/events.js';
import {
  auditReportCouplingRatchet,
  auditReportCouplingSeed,
  auditReportCouplingSeedIntegrity,
  formatReportCouplingCensus,
  formatReportCouplingRatchet,
  formatReportCouplingSeedAudit,
  reportCouplingSeedDigest,
} from './report-coupling-census.js';
import {
  REPORT_COUPLING_SEED,
  REPORT_COUPLING_SEED_IDS,
  REPORT_COUPLING_RETIRED_IDS,
  type ReportCouplingSeedEntry,
} from './report-coupling-seed.js';
import {
  REPORT_COUPLING_EXPIRY_HORIZON,
  REPORT_COUPLING_SEED_KEY_SET_DIGEST,
} from './report-coupling-seed-pin.js';
import { isIsoDay, isoDayUtc } from './event-grammar-census.js';
import {
  LIVE_SUBJECT,
  resolveToday,
  runGuard,
} from '../../audit/core/report-coupling-ratchet-guard.js';

/**
 * The day that every counterfactual below uses. It is a fixed literal, not `isoDayUtc(new Date())`.
 * These fixtures test seed membership, so the day must not vary.
 */
const TODAY = '2026-08-09';

/** The frozen half of the ratchet: the digest and the horizon. */
const PIN_SRC = fileURLToPath(new URL('./report-coupling-seed-pin.ts', import.meta.url));
/** The policy data. Read as text only to prove it cannot see its own cap. */
const SEED_SRC = fileURLToPath(new URL('./report-coupling-seed.ts', import.meta.url));

/** Drive the shipped gate and capture its streams, so a verdict is an EXIT CODE. */
function invokeGuard(options: Parameters<typeof runGuard>[0] = {}): {
  code: number;
  out: string;
  err: string;
} {
  let out = '';
  let err = '';
  const code = runGuard({
    ...options,
    stdout: (chunk) => {
      out += chunk;
    },
    stderr: (chunk) => {
      err += chunk;
    },
  });
  return { code, out, err };
}

/**
 * An annotation source over an explicit table, with the live table for untouched keys.
 * The census reads registration objects, so a counterfactual is a different object graph, not source text.
 */
function sourceOver(overrides: Readonly<Record<string, EventRegistration>>): EventAnnotationSource {
  const table: Readonly<Record<string, EventRegistration>> = { ...EVENT_ANNOTATIONS, ...overrides };
  return { registrationOf: (eventType: string): EventRegistration | undefined => table[eventType] };
}

/** A registration whose coupling derives `'model'`, so it is report-coupled. */
const REPORT_COUPLED: EventRegistration = {
  lifecycle: 'active',
  tier: 'judgment',
  gate: 'review-verdict',
  contentSchema: z.object({ note: z.string() }),
};

/** A registration whose coupling derives `'auto'`, so it is not report-coupled. */
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
  /**
   * The live census must be non-empty, because "0 report-coupled of 0" is what a moved module gives.
   * The report-coupled population must also be non-empty, or the ratchet passes forever.
   */
  it('ReportCouplingCensus_LiveRegistry_IsCleanAndNonEmpty', () => {
    const census = censusLiveReportCoupling();

    expect(census.total).toBeGreaterThan(0);
    expect(census.total).toBe(EventTypes.length);
    expect(census.diagnostics, formatReportCouplingCensus(census)).toEqual([]);
    expect(census.ok).toBe(true);

    expect(census.reportCoupledCount).toBeGreaterThan(0);
    expect(census.reportCoupledCount).toBe(census.reportCoupled.length);
    expect(census.reportCoupledCount + census.handlerCoupled.length).toBe(census.total);
  });

  /**
   * The seed must equal the live report-coupled population, so a hand-edited seed key fails.
   * `EVENT_EMISSION_REGISTRY`, the declared `source` column, must agree on the same set, not only the count.
   */
  it('ReportCouplingCensus_SeedEqualsTheLivePopulation_DerivedNotTranscribed', () => {
    const census = censusLiveReportCoupling();

    expect([...REPORT_COUPLING_SEED_IDS]).toEqual([...census.reportCoupled]);

    const declaredModelEmitted = EventTypes.filter(
      (eventType) => EVENT_EMISSION_REGISTRY[eventType] === 'model',
    ).sort();
    expect([...census.reportCoupled]).toEqual(declaredModelEmitted);
  });

  /**
   * Evaluates at the fixed `TODAY`, so the test fails for membership and not for the passage of time.
   * The failure message comes from `formatReportCouplingRatchet`, the formatter that the guard uses.
   * The pin covers the union of the seed and the retired ids.
   */
  it('ReportCouplingRatchet_LiveTree_Passes', () => {
    const verdict = auditLiveReportCouplingRatchet(TODAY);
    expect(verdict.findings, formatReportCouplingRatchet(verdict, censusLiveReportCoupling())).toEqual(
      [],
    );
    expect(verdict.ok).toBe(true);

    expect(verdict.pin.keySetSize).toBe(REPORT_COUPLING_SEED_IDS.length + REPORT_COUPLING_RETIRED_IDS.length);
    expect(verdict.pin.digest).toBe(REPORT_COUPLING_SEED_KEY_SET_DIGEST);
  });
});

describe('G3 kill fixtures — the ratchet must be able to go red', () => {
  /**
   * A seeded extra report-coupled registration must fail the ratchet.
   * The test asserts both counts, so a ratchet that widened its seed cannot pass with the same verdict.
   * The composed verdict, which CI reads, must also fail.
   */
  it('ReportCouplingRatchet_SeededAdditionalReportCoupling_IsRejected', () => {
    const seededType = 'zz.seeded.report_coupled';
    const census = censusLiveReportCoupling(
      [...EventTypes, seededType],
      sourceOver({ [seededType]: REPORT_COUPLED }),
      { ...EVENT_EMISSION_REGISTRY, [seededType]: 'model' },
    );

    expect(censusLiveReportCoupling().reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length);
    expect(census.reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length + 1);

    const audit = auditReportCouplingSeed(TODAY, census);
    expect(audit.ok).toBe(false);
    expect(audit.unseeded).toEqual([seededType]);
    expect(audit.findings.map((f) => f.code)).toContain('UNSEEDED_REPORT_COUPLING');

    expect(auditReportCouplingRatchet(TODAY, audit).ok).toBe(false);
  });

  /** An empty census must fail, and the failure must reach the audit that CI reads. */
  it('ReportCouplingCensus_ZeroRegistrations_FailsRatherThanReportingClean', () => {
    const census = censusLiveReportCoupling([], sourceOver({}), {});
    expect(census.total).toBe(0);
    expect(census.ok).toBe(false);
    expect(census.diagnostics.map((d) => d.code)).toContain('EMPTY_CENSUS');

    const audit = auditReportCouplingSeed(TODAY, census);
    expect(audit.ok).toBe(false);
    expect(audit.findings.map((f) => f.code)).toContain('EMPTY_CENSUS');
    expect(auditReportCouplingRatchet(TODAY, audit).ok).toBe(false);
  });

  /**
   * An event that the annotation table does not know cannot be shown to be not report-coupled.
   * The census excludes it from the denominator, and the audit refuses the partition.
   */
  it('ReportCouplingCensus_UnannotatedRegistration_FailsClosed', () => {
    const census = censusLiveReportCoupling([...EventTypes, 'zz.unannotated'], ANNOTATED_EVENTS);
    expect(census.ok).toBe(false);
    expect(census.diagnostics.map((d) => d.code)).toContain('UNANNOTATED_REGISTRATION');

    expect(census.total).toBe(EventTypes.length);
    expect(auditReportCouplingSeed(TODAY, census).findings.map((f) => f.code)).toContain(
      'UNTRUSTWORTHY_CENSUS',
    );
  });

  /** A seeded disagreement between the declared source and the tier-derived source must fail the census. */
  it('ReportCouplingCensus_SeededTierSourceDisagreement_IsRejected', () => {
    const census = censusLiveReportCoupling(EventTypes, ANNOTATED_EVENTS, {
      ...EVENT_EMISSION_REGISTRY,
      'workflow.started': 'model',
    });
    expect(census.ok).toBe(false);
    const disagreements = census.diagnostics.filter((d) => d.code === 'TIER_SOURCE_DISAGREEMENT');
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0]).toMatchObject({ eventType: 'workflow.started' });
  });

  /** A re-coupled seeded event leaves a stale seed entry, which must move to the graveyard. */
  it('ReportCouplingSeed_PaidDownEntry_MustMoveRatherThanLinger', () => {
    const paidDown = REPORT_COUPLING_SEED_IDS[0] ?? '';
    const census = censusLiveReportCoupling(
      EventTypes,
      sourceOver({ [paidDown]: HANDLER_COUPLED }),
      { ...EVENT_EMISSION_REGISTRY, [paidDown]: 'auto' },
    );

    expect(census.reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length - 1);
    const audit = auditReportCouplingSeed(TODAY, census);
    expect(audit.stale).toEqual([paidDown]);
    expect(audit.findings.map((f) => f.code)).toContain('STALE_SEED_ENTRY');
    expect(audit.ok).toBe(false);
  });

  /** A lapsed `expires` fails. The same seed on its expiry day passes, so the check reads the date. */
  it('ReportCouplingSeed_LapsedExpiry_Fails', () => {
    const census = censusLiveReportCoupling();
    const lapsed = seedOver(REPORT_COUPLING_SEED_IDS, { owner: 'test', expires: '2020-01-01' });

    const audit = auditReportCouplingSeed('2026-08-07', census, lapsed);
    expect(audit.expired).toEqual([...REPORT_COUPLING_SEED_IDS]);
    expect(audit.findings.map((f) => f.code)).toContain('EXPIRED_SEED_ENTRY');
    expect(audit.ok).toBe(false);

    const future = seedOver(REPORT_COUPLING_SEED_IDS, { owner: 'test', expires: '2026-08-07' });
    expect(auditReportCouplingSeed('2026-08-07', census, future).ok).toBe(true);
  });

  /**
   * An entry dated past the pinned horizon fails, even by one day, and even when no entry is expired.
   * An earlier date stays legal, because it shortens the debt.
   * On a blanket re-date, the guard fails with the horizon finding only, so the renewal is the one cause.
   * The pin module declares the horizon and imports nothing, and the seed file does not name it.
   * The test reads code lines only, because the prose of the pin contains the word "imports".
   * The live seed is within the horizon, and the guard output states the horizon.
   */
  it('ReportCouplingSeed_SelfRenewedEntry_FailsAgainstThePinnedHorizon', () => {
    const census = censusLiveReportCoupling();

    const bumped = auditReportCouplingSeed(
      TODAY,
      census,
      seedOver(REPORT_COUPLING_SEED_IDS, { owner: 'test', expires: '2099-01-01' }),
    );
    expect(bumped.expired).toEqual([]);
    expect(bumped.beyondHorizon).toEqual([...REPORT_COUPLING_SEED_IDS]);
    expect(bumped.ok).toBe(false);
    expect(bumped.findings.map((f) => f.code)).toContain('SEED_ENTRY_BEYOND_HORIZON');
    expect(formatReportCouplingSeedAudit(bumped)).toContain('may not name its own deadline');
    expect(formatReportCouplingSeedAudit(bumped)).toContain(
      'REPORT_COUPLING_EXPIRY_HORIZON in report-coupling-seed-pin.ts',
    );

    const oneDayOver = auditReportCouplingSeed(
      TODAY,
      census,
      seedOver(REPORT_COUPLING_SEED_IDS, { owner: 'test', expires: '2027-03-01' }),
    );
    expect(oneDayOver.beyondHorizon).toEqual([...REPORT_COUPLING_SEED_IDS]);
    expect(oneDayOver.ok).toBe(false);

    const earlier = auditReportCouplingSeed(
      TODAY,
      census,
      seedOver(REPORT_COUPLING_SEED_IDS, { owner: 'test', expires: '2026-09-01' }),
    );
    expect(earlier.beyondHorizon).toEqual([]);
    expect(earlier.ok).toBe(true);

    const red = invokeGuard({
      today: TODAY,
      seed: seedOver(REPORT_COUPLING_SEED_IDS, { owner: 'test', expires: '2099-01-01' }),
    });
    expect(red.code).toBe(1);
    expect(red.err).toContain('SEED_ENTRY_BEYOND_HORIZON');
    expect(red.err).not.toContain('SEED_KEY_SET_DRIFT');
    expect(red.err).not.toContain('UNSEEDED_REPORT_COUPLING');

    const pinCode = readFileSync(PIN_SRC, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(
      pinCode.filter((l) => l.includes('export const REPORT_COUPLING_EXPIRY_HORIZON')),
    ).toHaveLength(1);
    expect(pinCode.filter((l) => /^\s*import\b/.test(l))).toEqual([]);
    expect(isIsoDay(REPORT_COUPLING_EXPIRY_HORIZON)).toBe(true);
    expect(readFileSync(SEED_SRC, 'utf8')).not.toContain('REPORT_COUPLING_EXPIRY_HORIZON');

    const live = auditReportCouplingSeed(TODAY, census);
    expect(live.horizon).toBe(REPORT_COUPLING_EXPIRY_HORIZON);
    expect(live.beyondHorizon).toEqual([]);
    expect(live.malformed).toEqual([]);
    expect(live.seeded.length).toBeGreaterThan(0);

    const green = invokeGuard({ today: TODAY });
    expect(green.code).toBe(0);
    expect(green.err).toBe('');
    expect(green.out).toContain(`within the pinned horizon ${REPORT_COUPLING_EXPIRY_HORIZON}`);
  });

  /**
   * An empty seed fails, because "nothing has lapsed" is then true for the wrong reason.
   * A blank owner or an impossible date fails. `2027-02-31` matches the ISO pattern but does not exist.
   * An unreadable horizon disables the renewal check, so it fails closed.
   */
  it('ReportCouplingSeed_ZeroEntriesOrMalformedEntry_FailsClosed', () => {
    const census = censusLiveReportCoupling();

    const noEntries = auditReportCouplingSeed(TODAY, census, {});
    expect(noEntries.ok).toBe(false);
    expect(noEntries.findings.map((f) => f.code)).toContain('EMPTY_SEED');

    for (const entry of [
      { owner: '   ', expires: '2027-02-28' },
      { owner: 'test', expires: '2027-02-31' },
      { owner: 'test', expires: 'next wave' },
    ]) {
      const audit = auditReportCouplingSeed(
        TODAY,
        census,
        seedOver(REPORT_COUPLING_SEED_IDS, entry),
      );
      expect(audit.malformed, entry.expires).toEqual([...REPORT_COUPLING_SEED_IDS]);
      expect(audit.findings.map((f) => f.code), entry.expires).toContain('MALFORMED_SEED_ENTRY');
      expect(audit.ok, entry.expires).toBe(false);
    }

    const badHorizon = auditReportCouplingSeed(TODAY, census, REPORT_COUPLING_SEED, 'eventually');
    expect(badHorizon.ok).toBe(false);
    expect(badHorizon.findings.map((f) => f.code)).toContain('MALFORMED_HORIZON');
  });

  /** The swap that no comparison with today can see: one id out, one id in, and the same count. */
  it('ReportCouplingSeedIntegrity_InPlaceSwap_TripsThePin', () => {
    const swapped = [...REPORT_COUPLING_SEED_IDS.slice(1), 'zz.newly.coupled'];
    expect(swapped).toHaveLength(REPORT_COUPLING_SEED_IDS.length);

    const audit = auditReportCouplingSeedIntegrity(swapped, REPORT_COUPLING_RETIRED_IDS);
    expect(audit.ok).toBe(false);
    expect(audit.findings.map((f) => f.code)).toContain('SEED_KEY_SET_DRIFT');
  });

  /** A move of an id from the seed to the graveyard keeps the union, so the pin does not change. */
  it('ReportCouplingSeedIntegrity_LegalPaydownMove_LeavesThePinUnchanged', () => {
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

/**
 * The library takes `today` as a required parameter and reads no clock.
 * The one clock read is in the gate that blocks the merge, so an expired seed fails the gate, not the unit suite.
 * `FIRST_DEAD_DAY` is the day after the `expires` of each live seed entry, as a literal.
 */
describe('G3 reads no clock; the gate does', () => {
  const CENSUS_SRC = fileURLToPath(new URL('./report-coupling-census.ts', import.meta.url));
  const FIRST_DEAD_DAY = '2027-03-01';

  function invoke(options: Parameters<typeof runGuard>[0] = {}): {
    code: number;
    out: string;
    err: string;
  } {
    let out = '';
    let err = '';
    const code = runGuard({
      ...options,
      stdout: (chunk) => {
        out += chunk;
      },
      stderr: (chunk) => {
        err += chunk;
      },
    });
    return { code, out, err };
  }

  /**
   * The code lines of the census library hold no clock read.
   * An unreadable `today` gives one `UNREADABLE_CLOCK` finding and does not expire the seed.
   * The guard passes on the last day of the seed and fails the day after, with the real seeded ids.
   * `resolveToday` must agree with an independent UTC day. The test never pins a verdict to the wall clock.
   */
  it('AuditReportCouplingSeed_TodayParameter_IsRequiredNotAmbient', () => {
    const censusCode = readFileSync(CENSUS_SRC, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(censusCode.length).toBeGreaterThan(300);
    expect(censusCode.filter((l) => l.includes('new Date('))).toEqual([]);
    expect(censusCode.filter((l) => l.includes('Date.now('))).toEqual([]);

    const nonsense = auditReportCouplingSeed('not-a-day', censusLiveReportCoupling());
    expect(nonsense.ok).toBe(false);
    expect(nonsense.findings.map((f) => f.code)).toContain('UNREADABLE_CLOCK');
    expect(nonsense.expired).toEqual([]);

    expect(invoke({ today: '2027-02-28' }).code).toBe(0);

    const dead = invoke({ today: FIRST_DEAD_DAY });
    expect(dead.code).toBe(1);
    expect(dead.err).toContain('EXPIRED_SEED_ENTRY');
    expect(dead.err).toContain(REPORT_COUPLING_SEED_IDS[0] ?? '');

    const now = new Date();
    const independent = `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    expect(resolveToday(now)).toBe(independent);
    expect(resolveToday(new Date(Date.UTC(2027, 1, 28, 23, 59, 59)))).toBe('2027-02-28');
    expect(resolveToday(new Date(Date.UTC(2027, 2, 1, 0, 0, 0)))).toBe(FIRST_DEAD_DAY);
    expect(isoDayUtc(now)).toBe(resolveToday(now));
  });

  /**
   * The live defaults of the guard are the real modules, checked by identity.
   * The guard also fails on a structural finding on a day when nothing is expired.
   */
  it('ReportCouplingRatchetGuard_LiveDefaults_AreTheLiveArtifacts', () => {
    expect(LIVE_SUBJECT.seed).toBe(REPORT_COUPLING_SEED);
    expect(LIVE_SUBJECT.seeded).toBe(REPORT_COUPLING_SEED_IDS);
    expect(LIVE_SUBJECT.retired).toBe(REPORT_COUPLING_RETIRED_IDS);
    expect(LIVE_SUBJECT.pinnedDigest).toBe(REPORT_COUPLING_SEED_KEY_SET_DIGEST);

    const swapped = invoke({
      today: TODAY,
      seeded: [...REPORT_COUPLING_SEED_IDS.slice(1), 'zz.newly.coupled'],
    });
    expect(swapped.code).toBe(1);
    expect(swapped.err).toContain('SEED_KEY_SET_DRIFT');

    expect(invoke({ today: TODAY }).code).toBe(0);
  });
});

/**
 * A census that read `EVENT_EMISSION_REGISTRY[eventType] === 'model'` passes every test above, because both authorities agree on the live tree.
 * These two cases separate them.
 */
describe('G3 measures coupling, not the declared source column', () => {
  /** A column reader classifies this event as handler-coupled. The census counts it and reports the disagreement. */
  it('ReportCouplingCensus_DerivedModelWithDeclaredAuto_CountsAsReportCoupled', () => {
    const seededType = 'zz.derived.model';
    const census = censusLiveReportCoupling(
      [...EventTypes, seededType],
      sourceOver({ [seededType]: REPORT_COUPLED }),
      { ...EVENT_EMISSION_REGISTRY, [seededType]: 'auto' },
    );

    expect(census.reportCoupled).toContain(seededType);
    expect(census.reportCoupledCount).toBe(REPORT_COUPLING_SEED_IDS.length + 1);
    expect(census.diagnostics.map((d) => d.code)).toContain('TIER_SOURCE_DISAGREEMENT');
  });

  /** A column reader counts this event as report-coupled. The structural derivation does not. */
  it('ReportCouplingCensus_DerivedAutoWithDeclaredModel_IsNotReportCoupled', () => {
    const seededType = 'zz.declared.model';
    const census = censusLiveReportCoupling(
      [...EventTypes, seededType],
      sourceOver({ [seededType]: HANDLER_COUPLED }),
      { ...EVENT_EMISSION_REGISTRY, [seededType]: 'model' },
    );

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

  /** The #1473 exemption is pinned at the two team types, so a third `blockedBy` entry is a visible change. */
  it('ReportCouplingSeed_BlockedByExemption_IsPinnedAtTheTwoTeamTypes', () => {
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

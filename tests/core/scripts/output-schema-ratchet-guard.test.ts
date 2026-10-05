/**
 * Tests for the executable `outputSchema` vacuity ratchet guard. The guard enforces the waiver
 * deadlines, and CI runs it as a gate.
 *
 * The guard compares two sources that cannot observe each other. The generated data file
 * `src/output-schema-vacuity-allowlist.ts` holds `{ owner, expires }` records and imports nothing.
 * The frozen pin `tools/conformance/src/output-schema-seed-pin.ts` holds the anchor, the step and
 * the runway budget, and it also imports nothing.
 *
 * The deadline schedule is per owner and derives from the seed. The tests check that it is
 * staggered, that a paydown moves no slot, and that the runway budget bounds the anchor.
 *
 * Each verdict uses a named day that the test passes as data, so no test fails because time
 * passed. The membership and seed-digest checks are in
 * `tests/unit/output-schema-vacuity-allowlist.test.ts`.
 */
// @oracle-sources: ../src/output-schema-vacuity-allowlist.ts, ../../../tools/conformance/src/output-schema-seed-pin.ts, the Zod schema objects the live tool registry constructs at module-import time and the census walks structurally
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  LIVE_SUBJECT,
  auditVacuityStagger,
  deriveOwnerCohorts,
  formatVacuityStaggerAudit,
  resolveToday,
  runGuard,
  type GuardOptions,
  type OwnerCohort,
} from '../../../tools/audit/core/output-schema-ratchet-guard.js';
import {
  formatVacuityExpiryAudit,
  isIsoDay,
  isoDayUtc,
  type CensusableAction,
  type CensusableTool,
  auditVacuityExpiry,
} from '../../../tools/conformance/src/output-schema-census.js';
import {
  auditLiveVacuityAllowlist,
  auditLiveVacuityExpiry,
  auditLiveVacuityRatchet,
  auditLiveVacuityRatchetAsOf,
  auditLiveVacuitySeedIntegrity,
  censusLiveOutputSchemas,
} from '../../../tools/conformance/src/bindings/output-schema.js';
import { daysBetween } from '../../../tools/conformance/src/waiver-ledger.js';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED,
  VACUITY_RETIRED_IDS,
  type VacuityRetiredEntry,
  type VacuityWaiverEntry,
} from '../../../src/output-schema-vacuity-allowlist.js';
import {
  VACUITY_EXPIRY_HORIZON,
  VACUITY_RUNWAY_BUDGET_DAYS,
  VACUITY_SEED_KEY_SET_DIGEST,
  VACUITY_STAGGER_STEP_DAYS,
} from '../../../tools/conformance/src/output-schema-seed-pin.js';
import {
  unregisteredActionOutputSchema,
  withCappedShape,
} from '../../../src/output-schema-declaration.js';
import { EnvelopeSchema } from '../../../src/contract/schemas/envelope.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The source of the census module. One test reads it as text. */
const CENSUS_SRC = resolve(HERE, '../../../tools/conformance/src/output-schema-census.ts');
const PIN_SRC = resolve(HERE, '../../../tools/conformance/src/output-schema-seed-pin.ts');

/** The day the seed was written. Every "before any deadline" verdict uses it. */
const SEEDED_ON = '2026-08-07';
/** The anchor — the LAST slot, and the last day the LAST cohort is live. */
const LAST_LIVE_DAY = VACUITY_EXPIRY_HORIZON;
/** The first day after the anchor. Every seeded waiver is dead here. */
const FIRST_DEAD_DAY = '2027-03-01';

/**
 * The live schedule, derived once from the shipped artifacts. The schedule tests thus hold no slot
 * date and no owner name that needs maintenance with the seed.
 */
const LIVE_COHORTS = deriveOwnerCohorts(
  VACUITY_ALLOWLIST,
  VACUITY_RETIRED,
  VACUITY_EXPIRY_HORIZON,
  VACUITY_STAGGER_STEP_DAYS,
);

/**
 * The calendar day after `day`. The test does its own arithmetic, because the schedule arithmetic
 * of the guard is under test. `isoDayUtc` only formats the result.
 */
function dayAfter(day: string): string {
  const parts = day.split('-').map(Number);
  return isoDayUtc(
    new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]) + 1)),
  );
}

/** The cohort at a given slot. Throws rather than returning a sentinel: a fixture
 * that cannot be posed must FAIL, not silently assert nothing. */
function slot(rank: number): OwnerCohort {
  const cohort = LIVE_COHORTS[rank];
  if (cohort === undefined) {
    throw new Error(
      `the derived schedule has no slot ${rank} (it has ${LIVE_COHORTS.length}). This fixture ` +
        'cannot be posed, so it must FAIL rather than silently assert nothing.',
    );
  }
  return cohort;
}

/** Every live waiver of `cohort`, keyed by id. */
function liveEntriesOf(cohort: OwnerCohort): Readonly<Record<string, VacuityWaiverEntry>> {
  const out: Record<string, VacuityWaiverEntry> = {};
  for (const [id, entry] of Object.entries(VACUITY_ALLOWLIST)) {
    if (entry.owner === cohort.owner) out[id] = entry;
  }
  return out;
}

/** Any live waiver of `cohort` — the id the single-entry fixtures re-date. */
function anyLiveIdOf(cohort: OwnerCohort): string {
  const ids = Object.keys(liveEntriesOf(cohort)).sort();
  const first = ids[0];
  if (first === undefined) {
    throw new Error(
      `the ${cohort.owner} cohort holds no live waiver, so the per-owner fixture cannot be ` +
        'posed. If that cohort really was paid off, retarget the fixture rather than deleting it.',
    );
  }
  return first;
}

/** The live allowlist with ONE id re-dated. The single-entry attack, as data. */
function withReDatedEntry(
  id: string,
  expires: string,
): Readonly<Record<string, VacuityWaiverEntry>> {
  const found = Object.entries(VACUITY_ALLOWLIST).find(([key]) => key === id);
  if (found === undefined) {
    throw new Error(`'${id}' is not a live waiver, so this fixture cannot be posed.`);
  }
  return { ...VACUITY_ALLOWLIST, [id]: { owner: found[1].owner, expires } };
}

function action(name: string, outputSchema: z.ZodType): CensusableAction {
  return { name, outputSchema };
}
function tool(name: string, actions: readonly CensusableAction[]): CensusableTool {
  return { name, actions };
}
const vacuous = (): z.ZodType => unregisteredActionOutputSchema();
const substantive = (): z.ZodType =>
  withCappedShape(EnvelopeSchema(z.object({ items: z.array(z.string()) })));

/** Drive the CLI entrypoint and capture what it wrote, so exit code AND report are observable. */
function invoke(options: GuardOptions): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = runGuard({
    ...options,
    stdout: (chunk: string) => {
      out += chunk;
    },
    stderr: (chunk: string) => {
      err += chunk;
    },
  });
  return { code, out, err };
}

/** Re-date every live waiver — the "bump them all in one commit" attack, as data. */
function reDated(expires: string): Readonly<Record<string, VacuityWaiverEntry>> {
  const out: Record<string, VacuityWaiverEntry> = {};
  for (const [id, entry] of Object.entries(VACUITY_ALLOWLIST)) {
    out[id] = { owner: entry.owner, expires };
  }
  return out;
}

describe('DR-4: the vacuity allowlist expiry is enforced, not advisory', () => {
  /**
   * The kill fixture. The test produces the failing subject two ways: the live seed one day after
   * the anchor, and one planted entry that expired the day before.
   *
   * - The live run injects only the day, so the entries come from the live allowlist. The entry
   *   count equals the live id count and is not zero.
   * - The report names the legal repair, and the guard exits 1 and names an expired id.
   * - One expired waiver is sufficient to fail.
   * - A waiver is still live on its expiry day. The boundary is inclusive.
   */
  it('OutputSchemaExpiry_PastExpiryEntry_FailsTheGuard', () => {
    const live = auditLiveVacuityExpiry(FIRST_DEAD_DAY);
    expect(live.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(live.entryCount).toBeGreaterThan(0);
    expect(live.ok).toBe(false);
    expect(live.expired).toEqual([...VACUITY_ALLOWLIST_IDS]);
    expect(live.findings.every((f) => f.code === 'EXPIRED_WAIVER')).toBe(true);
    const first = live.findings[0];
    expect(first).toBeDefined();
    expect(first?.code).toBe('EXPIRED_WAIVER');
    expect(formatVacuityExpiryAudit(live)).toContain('FAILED');
    expect(formatVacuityExpiryAudit(live)).toContain('MOVE its entry to VACUITY_RETIRED');
    expect(formatVacuityExpiryAudit(live)).toContain('Bumping the date is not the fix');

    const red = invoke({ today: FIRST_DEAD_DAY });
    expect(red.code).toBe(1);
    expect(red.out).toBe('');
    expect(red.err).toContain('EXPIRED_WAIVER');
    expect(red.err).toContain('exarchos_workflow.init');
    expect(red.err).toContain(FIRST_DEAD_DAY);

    const plantedEntries: Readonly<Record<string, VacuityWaiverEntry>> = {
      'exarchos_view.tasks': { owner: 'views', expires: '2026-08-06' },
    };
    const planted = auditLiveVacuityExpiry(SEEDED_ON, plantedEntries);
    expect(planted.entryCount).toBe(1);
    expect(planted.ok).toBe(false);
    expect(planted.expired).toEqual(['exarchos_view.tasks']);
    const plantedRun = invoke({ today: SEEDED_ON, entries: plantedEntries });
    expect(plantedRun.code).toBe(1);
    expect(plantedRun.err).toContain("'exarchos_view.tasks' (owner: views) expired on 2026-08-06");

    const onTheDay = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: SEEDED_ON },
    });
    expect(onTheDay.expired).toEqual([]);
    expect(onTheDay.ok).toBe(true);
  });

  /**
   * The green side of the kill fixture: the same live seed and code path, before any deadline.
   *
   * - The schedule is staggered, so the last day on which every waiver is live is the slot of the
   *   first cohort. The test derives that day from the schedule.
   * - `205` is the count of days from `SEEDED_ON` to the pinned anchor. A new anchor changes it.
   * - The report states its denominator. Both counts come from the live artifacts, because a
   *   paydown or a new action changes a literal count.
   * - The report names each cohort with its live count over its seeded count.
   * - One day after the first slot the guard is red, and only that cohort is due. On the anchor
   *   the guard is red too.
   */
  it('OutputSchemaExpiry_UnexpiredEntry_PassesTheGuard', () => {
    const firstSlot = slot(0);
    const wholeSeedLive = auditLiveVacuityExpiry(firstSlot.horizon);
    expect(wholeSeedLive.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(wholeSeedLive.ok).toBe(true);
    expect(wholeSeedLive.expired).toEqual([]);
    expect(wholeSeedLive.beyondHorizon).toEqual([]);
    expect(wholeSeedLive.malformed).toEqual([]);

    const lastLive = auditLiveVacuityExpiry(LAST_LIVE_DAY, liveEntriesOf(slot(LIVE_COHORTS.length - 1)));
    expect(lastLive.entryCount).toBeGreaterThan(0);
    expect(lastLive.ok).toBe(true);
    expect(lastLive.expired).toEqual([]);
    expect(lastLive.daysToHorizon).toBe(0);

    const atSeeding = auditLiveVacuityExpiry(SEEDED_ON);
    expect(atSeeding.ok).toBe(true);
    expect(atSeeding.daysToHorizon).toBe(205);
    expect(formatVacuityExpiryAudit(atSeeding)).toContain('OK');

    const green = invoke({ today: SEEDED_ON });
    expect(green.code).toBe(0);
    expect(green.err).toBe('');
    expect(green.out).toContain('OK as of 2026-08-07');
    const liveWaived = VACUITY_ALLOWLIST_IDS.length;
    const liveTotal = censusLiveOutputSchemas().total;
    expect(liveWaived).toBeGreaterThan(0);
    expect(liveTotal).toBeGreaterThan(liveWaived);
    expect(green.out).toContain(`${liveWaived} waived of ${liveTotal} declaration(s)`);
    expect(green.out).toContain(`horizon ${VACUITY_EXPIRY_HORIZON}`);

    for (const cohort of LIVE_COHORTS) {
      expect(green.out, cohort.owner).toContain(cohort.owner);
      expect(green.out, cohort.owner).toContain(
        `${String(cohort.live).padStart(3)} of ${String(cohort.seeded).padStart(3)}`,
      );
      expect(green.out, cohort.owner).toContain(`due ${cohort.horizon}`);
    }
    const seededTotal = LIVE_COHORTS.reduce((sum, cohort) => sum + cohort.seeded, 0);
    const liveTotalByOwner = LIVE_COHORTS.reduce((sum, cohort) => sum + cohort.live, 0);
    expect(liveTotalByOwner).toBe(liveWaived);
    expect(seededTotal).toBe(VACUITY_ALLOWLIST_IDS.length + VACUITY_RETIRED_IDS.length);
    expect(seededTotal).toBeGreaterThan(liveTotalByOwner);

    expect(invoke({ today: firstSlot.horizon }).code).toBe(0);
    const afterFirstSlot = invoke({ today: dayAfter(firstSlot.horizon) });
    expect(afterFirstSlot.code).toBe(1);
    expect(afterFirstSlot.err).toContain('EXPIRED_WAIVER');
    const expiredIds = Object.keys(liveEntriesOf(firstSlot)).sort();
    expect(expiredIds.length).toBeGreaterThan(0);
    expect(expiredIds.length).toBeLessThan(VACUITY_ALLOWLIST_IDS.length);
    const stillLive = auditLiveVacuityExpiry(dayAfter(firstSlot.horizon));
    expect([...stillLive.expired].sort()).toEqual(expiredIds);

    expect(invoke({ today: LAST_LIVE_DAY }).code).toBe(1);
    expect(invoke({ today: FIRST_DEAD_DAY }).code).toBe(1);
  });

  /**
   * The renewal tooth. A check of `expires` alone is weak, because one edit can add a year to
   * every date. So one pinned horizon, in a module that imports nothing, caps every entry.
   *
   * - Every live entry re-dated to 2099 fails with `WAIVER_BEYOND_HORIZON`, and none is expired.
   *   The census and the seed pin stay clean, so the renewal is the only cause.
   * - One entry one day past the horizon fails too.
   * - An earlier date is legal, because it only shortens the life of the debt.
   * - The pin module declares the horizon and has no import. The test reads only its code lines,
   *   because its prose holds the word "import".
   */
  it('OutputSchemaExpiry_EntryDatedBeyondThePinnedHorizon_FailsTheGuard', () => {
    const bumped = auditLiveVacuityExpiry(SEEDED_ON, reDated('2099-01-01'));
    expect(bumped.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(bumped.expired).toEqual([]);
    expect(bumped.beyondHorizon).toEqual([...VACUITY_ALLOWLIST_IDS]);
    expect(bumped.ok).toBe(false);
    expect(formatVacuityExpiryAudit(bumped)).toContain('WAIVER_BEYOND_HORIZON');
    expect(formatVacuityExpiryAudit(bumped)).toContain('may not name its own deadline');

    const oneDayOver = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: '2027-03-01' },
    });
    expect(oneDayOver.beyondHorizon).toEqual(['exarchos_view.tasks']);
    expect(oneDayOver.ok).toBe(false);

    const earlier = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: '2026-09-01' },
    });
    expect(earlier.ok).toBe(true);
    expect(earlier.beyondHorizon).toEqual([]);

    const red = invoke({ today: SEEDED_ON, entries: reDated('2099-01-01') });
    expect(red.code).toBe(1);
    expect(red.err).toContain('WAIVER_BEYOND_HORIZON');
    expect(red.err).toContain('VACUITY_EXPIRY_HORIZON in output-schema-seed-pin.ts');
    expect(red.err).not.toContain('SEED_KEY_SET_DRIFT');
    expect(red.err).not.toContain('UNWAIVED_VACUITY');

    const pinCode = readFileSync(PIN_SRC, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(pinCode.filter((l) => l.includes('export const VACUITY_EXPIRY_HORIZON'))).toHaveLength(
      1,
    );
    expect(pinCode.filter((l) => /^\s*import\b/.test(l))).toEqual([]);
    expect(LIVE_SUBJECT.horizon).toBe(VACUITY_EXPIRY_HORIZON);
    expect(isIsoDay(VACUITY_EXPIRY_HORIZON)).toBe(true);
  });

  /**
   * The kill fixture for the per-owner schedule. An entry of the first cohort moves to the anchor,
   * a date that the global cap accepts. The anchor comes from the pin, not from the schedule.
   *
   * - Red: the global expiry audit is clean on this input, so only the per-owner slot can fail
   *   the guard. The report holds no drift, unwaived or expired finding.
   * - Green: the same guard on the same day passes with the entry on its shipped date.
   * - The entries of the last cohort sit on the anchor and pass, so the finding is about the
   *   owner and not about the date. An earlier date is legal here too.
   * - Each live owner has a slot, so no waiver skips the comparison.
   */
  it('OutputSchemaExpiry_EntryDatedBeyondItsOwnerHorizon_FailsTheGuard', () => {
    const early = slot(0);
    const last = slot(LIVE_COHORTS.length - 1);
    expect(last.horizon).toBe(VACUITY_EXPIRY_HORIZON);
    expect(early.horizon < last.horizon).toBe(true);

    const victim = anyLiveIdOf(early);
    const reDated = withReDatedEntry(victim, VACUITY_EXPIRY_HORIZON);

    const globalHalf = auditLiveVacuityExpiry(SEEDED_ON, reDated);
    expect(globalHalf.ok).toBe(true);
    expect(globalHalf.beyondHorizon).toEqual([]);
    expect(globalHalf.expired).toEqual([]);

    const red = invoke({ today: SEEDED_ON, entries: reDated });
    expect(red.code).toBe(1);
    expect(red.out).toBe('');
    expect(red.err).toContain('WAIVER_BEYOND_OWNER_HORIZON');
    expect(red.err).toContain(victim);
    expect(red.err).toContain(`later than the ${early.owner} cohort's slot ${early.horizon}`);
    expect(red.err).not.toContain('SEED_KEY_SET_DRIFT');
    expect(red.err).not.toContain('UNWAIVED_VACUITY');
    expect(red.err).not.toContain('EXPIRED_WAIVER');

    const green = invoke({ today: SEEDED_ON });
    expect(green.code).toBe(0);
    expect(green.err).toBe('');

    const lastCohortEntries = liveEntriesOf(last);
    expect(Object.keys(lastCohortEntries).length).toBeGreaterThan(0);
    for (const entry of Object.values(lastCohortEntries)) {
      expect(entry.expires).toBe(VACUITY_EXPIRY_HORIZON);
    }
    expect(
      auditVacuityStagger(
        SEEDED_ON,
        lastCohortEntries,
        VACUITY_RETIRED,
        VACUITY_EXPIRY_HORIZON,
        VACUITY_STAGGER_STEP_DAYS,
        VACUITY_RUNWAY_BUDGET_DAYS,
      ).ok,
    ).toBe(true);

    const earlier = auditVacuityStagger(
      SEEDED_ON,
      withReDatedEntry(victim, SEEDED_ON),
      VACUITY_RETIRED,
      VACUITY_EXPIRY_HORIZON,
      VACUITY_STAGGER_STEP_DAYS,
      VACUITY_RUNWAY_BUDGET_DAYS,
    );
    expect(earlier.ok).toBe(true);

    const scheduledOwners = new Set(LIVE_COHORTS.map((cohort) => cohort.owner));
    const liveOwners = new Set(Object.values(VACUITY_ALLOWLIST).map((entry) => entry.owner));
    expect(liveOwners.size).toBeGreaterThan(0);
    expect([...liveOwners].filter((owner) => !scheduledOwners.has(owner))).toEqual([]);
  });

  /**
   * - Shape: each slot is a real day, the slots are in strict order one step apart, and the last
   *   slot is the anchor. `daysBetween` measures what the guard shifts, so this is a cross-check.
   * - Order: the seeded cohort sizes do not decrease, so the smallest cohort comes due first.
   * - Stability: a paydown moves an entry to the retired map and moves no slot. Only the live
   *   count changes. A schedule that ranks the live list alone gives different seeded counts.
   * - Runway: the live anchor is inside the budget. An anchor one year later fails with
   *   `RUNWAY_BEYOND_BUDGET`, and an anchor one day later gets no such finding.
   * - A malformed anchor, step or budget fails closed. A seed with no owner gives zero slots,
   *   and that fails with `EMPTY_SCHEDULE`.
   */
  it('OutputSchemaSchedule_DerivedFromTheSeed_IsStaggeredAndUnmovedByAPaydown', () => {
    expect(LIVE_COHORTS.length).toBeGreaterThan(1);
    for (const [rank, cohort] of LIVE_COHORTS.entries()) {
      expect(isIsoDay(cohort.horizon), cohort.owner).toBe(true);
      expect(cohort.rank, cohort.owner).toBe(rank);
    }
    const dates = LIVE_COHORTS.map((cohort) => cohort.horizon);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
    expect(dates[dates.length - 1]).toBe(VACUITY_EXPIRY_HORIZON);
    for (let rank = 1; rank < LIVE_COHORTS.length; rank += 1) {
      expect(daysBetween(slot(rank - 1).horizon, slot(rank).horizon)).toBe(
        VACUITY_STAGGER_STEP_DAYS,
      );
    }

    const seededByOwner = new Map<string, number>();
    for (const entry of [
      ...Object.values(VACUITY_ALLOWLIST),
      ...Object.values(VACUITY_RETIRED),
    ]) {
      seededByOwner.set(entry.owner, (seededByOwner.get(entry.owner) ?? 0) + 1);
    }
    expect(LIVE_COHORTS.length).toBe(seededByOwner.size);
    for (const cohort of LIVE_COHORTS) {
      expect(cohort.seeded, cohort.owner).toBe(seededByOwner.get(cohort.owner));
    }
    const sizes = LIVE_COHORTS.map((cohort) => cohort.seeded);
    expect([...sizes].sort((left, right) => left - right)).toEqual(sizes);

    const paidId = anyLiveIdOf(slot(0));
    const afterPaydown = deriveOwnerCohorts(
      Object.fromEntries(Object.entries(VACUITY_ALLOWLIST).filter(([id]) => id !== paidId)),
      { ...VACUITY_RETIRED, [paidId]: { owner: slot(0).owner, retiredAt: SEEDED_ON } },
      VACUITY_EXPIRY_HORIZON,
      VACUITY_STAGGER_STEP_DAYS,
    );
    expect(afterPaydown.map((cohort) => [cohort.owner, cohort.horizon, cohort.seeded])).toEqual(
      LIVE_COHORTS.map((cohort) => [cohort.owner, cohort.horizon, cohort.seeded]),
    );
    expect(afterPaydown[0]?.live).toBe(slot(0).live - 1);

    const rankedOnLive = deriveOwnerCohorts(
      Object.fromEntries(Object.entries(VACUITY_ALLOWLIST).filter(([id]) => id !== paidId)),
      {},
      VACUITY_EXPIRY_HORIZON,
      VACUITY_STAGGER_STEP_DAYS,
    );
    expect(rankedOnLive.map((cohort) => cohort.seeded)).not.toEqual(
      LIVE_COHORTS.map((cohort) => cohort.seeded),
    );

    const liveStagger = auditVacuityStagger(
      SEEDED_ON,
      VACUITY_ALLOWLIST,
      VACUITY_RETIRED,
      VACUITY_EXPIRY_HORIZON,
      VACUITY_STAGGER_STEP_DAYS,
      VACUITY_RUNWAY_BUDGET_DAYS,
    );
    expect(liveStagger.ok).toBe(true);
    expect(liveStagger.runwayDays).toBeLessThanOrEqual(VACUITY_RUNWAY_BUDGET_DAYS);
    expect(liveStagger.runwayDays).toBeGreaterThan(0);
    expect(formatVacuityStaggerAudit(liveStagger)).toContain('OK');

    const bumpedByAYear = auditVacuityStagger(
      SEEDED_ON,
      VACUITY_ALLOWLIST,
      VACUITY_RETIRED,
      dayAfter('2028-02-27'),
      VACUITY_STAGGER_STEP_DAYS,
      VACUITY_RUNWAY_BUDGET_DAYS,
    );
    expect(bumpedByAYear.findings.map((f) => f.code)).toContain('RUNWAY_BEYOND_BUDGET');
    expect(bumpedByAYear.ok).toBe(false);
    expect(formatVacuityStaggerAudit(bumpedByAYear)).toContain('FAILED');
    expect(formatVacuityStaggerAudit(bumpedByAYear)).toContain('wave-scoped');

    const smallBump = auditVacuityStagger(
      SEEDED_ON,
      VACUITY_ALLOWLIST,
      VACUITY_RETIRED,
      dayAfter(VACUITY_EXPIRY_HORIZON),
      VACUITY_STAGGER_STEP_DAYS,
      VACUITY_RUNWAY_BUDGET_DAYS,
    );
    expect(smallBump.findings.map((f) => f.code)).not.toContain('RUNWAY_BEYOND_BUDGET');

    const broken: readonly { anchor: string; step: number; budget: number }[] = [
      { anchor: 'someday', step: VACUITY_STAGGER_STEP_DAYS, budget: VACUITY_RUNWAY_BUDGET_DAYS },
      { anchor: '2027-02-31', step: VACUITY_STAGGER_STEP_DAYS, budget: VACUITY_RUNWAY_BUDGET_DAYS },
      { anchor: VACUITY_EXPIRY_HORIZON, step: 0, budget: VACUITY_RUNWAY_BUDGET_DAYS },
      { anchor: VACUITY_EXPIRY_HORIZON, step: -7, budget: VACUITY_RUNWAY_BUDGET_DAYS },
      { anchor: VACUITY_EXPIRY_HORIZON, step: 1.5, budget: VACUITY_RUNWAY_BUDGET_DAYS },
      { anchor: VACUITY_EXPIRY_HORIZON, step: VACUITY_STAGGER_STEP_DAYS, budget: 1.5 },
      { anchor: VACUITY_EXPIRY_HORIZON, step: VACUITY_STAGGER_STEP_DAYS, budget: -1 },
    ];
    for (const { anchor, step, budget } of broken) {
      const label = `${anchor}/${step}/${budget}`;
      const audit = auditVacuityStagger(
        SEEDED_ON,
        VACUITY_ALLOWLIST,
        VACUITY_RETIRED,
        anchor,
        step,
        budget,
      );
      expect(audit.findings.map((f) => f.code), label).toContain('MALFORMED_SCHEDULE');
      expect(audit.ok, label).toBe(false);
    }

    const noOwners = auditVacuityStagger(
      SEEDED_ON,
      {},
      {},
      VACUITY_EXPIRY_HORIZON,
      VACUITY_STAGGER_STEP_DAYS,
      VACUITY_RUNWAY_BUDGET_DAYS,
    );
    expect(noOwners.cohorts).toEqual([]);
    expect(noOwners.ok).toBe(false);
    expect(noOwners.findings.map((f) => f.code)).toContain('EMPTY_SCHEDULE');
  });

  /**
   * An allowlist with zero entries makes "no expired waiver" true, and a census with zero
   * declarations makes "no unwaived vacuity" true. A moved module or a broken import gives each
   * of these states, so both must fail. One entry passes the expiry audit, and a census of two
   * declarations is not empty. The check is about emptiness, not about size.
   */
  it('OutputSchemaExpiry_EmptyAllowlistOrEmptyCensus_FailsClosed', () => {
    const noEntries = auditLiveVacuityExpiry(SEEDED_ON, {});
    expect(noEntries.entryCount).toBe(0);
    expect(noEntries.expired).toEqual([]);
    expect(noEntries.ok).toBe(false);
    expect(noEntries.findings.map((f) => f.code)).toEqual(['EMPTY_ALLOWLIST']);

    const emptyThroughTheGuard = invoke({ today: SEEDED_ON, entries: {} });
    expect(emptyThroughTheGuard.code).toBe(1);
    expect(emptyThroughTheGuard.err).toContain('EMPTY_ALLOWLIST');

    const emptyCensus = invoke({ today: SEEDED_ON, tools: [] });
    expect(emptyCensus.code).toBe(1);
    expect(emptyCensus.err).toContain('EMPTY_CENSUS');

    const one = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: LAST_LIVE_DAY },
    });
    expect(one.entryCount).toBe(1);
    expect(one.ok).toBe(true);
    expect(
      invoke({
        today: SEEDED_ON,
        tools: [tool('t', [action('a', vacuous()), action('b', substantive())])],
        waived: ['t.a'],
        retired: [],
        pinnedDigest: 'unused-because-the-seed-half-is-driven-separately',
      }).err,
    ).not.toContain('EMPTY_CENSUS');
  });

  /**
   * A waiver with a blank owner or a date that cannot be compared must fail, not read as in date.
   * `2027-02-31` matches the `YYYY-MM-DD` pattern and is not a real day, so a pattern check is
   * not sufficient. An unreadable clock or horizon disables the comparison, so both fail closed.
   * The live seed is well-formed, and its entry count is derived and not zero.
   */
  it('OutputSchemaExpiry_MalformedOwnerOrDate_FailsClosed', () => {
    const unowned = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: '   ', expires: LAST_LIVE_DAY },
    });
    expect(unowned.malformed).toEqual(['exarchos_view.tasks']);
    expect(unowned.ok).toBe(false);

    expect(isIsoDay('2027-02-31')).toBe(false);
    expect(isIsoDay('2027-13-01')).toBe(false);
    expect(isIsoDay('2027-2-8')).toBe(false);
    expect(isIsoDay('next wave')).toBe(false);
    expect(isIsoDay('2028-02-29')).toBe(true);
    expect(isIsoDay('2027-02-28')).toBe(true);

    for (const bad of ['2027-02-31', '2027-13-01', 'next wave', '']) {
      const audit = auditLiveVacuityExpiry(SEEDED_ON, {
        'exarchos_view.tasks': { owner: 'views', expires: bad },
      });
      expect(audit.malformed, bad).toEqual(['exarchos_view.tasks']);
      expect(audit.ok, bad).toBe(false);
    }

    expect(auditLiveVacuityExpiry('someday').findings.map((f) => f.code)).toContain(
      'UNREADABLE_CLOCK',
    );
    expect(auditLiveVacuityExpiry(SEEDED_ON, VACUITY_ALLOWLIST, 'eventually').ok).toBe(false);
    expect(
      auditLiveVacuityExpiry(SEEDED_ON, VACUITY_ALLOWLIST, 'eventually').findings.map((f) => f.code),
    ).toContain('MALFORMED_HORIZON');
    expect(isoDayUtc(new Date(Number.NaN))).toBe('');

    const liveWellFormed = auditLiveVacuityExpiry(SEEDED_ON);
    expect(liveWellFormed.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(liveWellFormed.entryCount).toBeGreaterThan(0);
    expect(liveWellFormed.malformed).toEqual([]);
  });

  /**
   * The other tests inject their inputs, so they do not show what the defaults are. This test
   * pins the defaults by reference identity to the modules that own them. With only the day
   * injected, the guard also reports real live ids.
   *
   * The clock check compares `resolveToday(now)` with a UTC day that the test computes itself.
   * It asserts no verdict from the wall clock.
   */
  it('OutputSchemaRatchetGuard_ProductionDefaultsAreTheLiveArtifacts', () => {
    expect(LIVE_SUBJECT.entries).toBe(VACUITY_ALLOWLIST);
    expect(LIVE_SUBJECT.retiredEntries).toBe(VACUITY_RETIRED);
    expect(LIVE_SUBJECT.waived).toBe(VACUITY_ALLOWLIST_IDS);
    expect(LIVE_SUBJECT.retired).toBe(VACUITY_RETIRED_IDS);
    expect(LIVE_SUBJECT.pinnedDigest).toBe(VACUITY_SEED_KEY_SET_DIGEST);
    expect(LIVE_SUBJECT.horizon).toBe(VACUITY_EXPIRY_HORIZON);
    expect(LIVE_SUBJECT.stepDays).toBe(VACUITY_STAGGER_STEP_DAYS);
    expect(LIVE_SUBJECT.runwayBudgetDays).toBe(VACUITY_RUNWAY_BUDGET_DAYS);

    const red = invoke({ today: FIRST_DEAD_DAY });
    for (const id of ['exarchos_workflow.init', 'exarchos_view.tasks', 'exarchos_event.append']) {
      expect(red.err, id).toContain(id);
    }

    const now = new Date();
    const independent = `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    expect(resolveToday(now)).toBe(independent);
    expect(isIsoDay(resolveToday())).toBe(true);
    expect(resolveToday(new Date(Date.UTC(2027, 1, 28, 23, 59, 59)))).toBe('2027-02-28');
    expect(resolveToday(new Date(Date.UTC(2027, 2, 1, 0, 0, 0)))).toBe('2027-03-01');
  });

  /**
   * The membership and seed audits are pure functions of the registry and the seed, and they run
   * with no clock. The test pins that property, because a `new Date()` default for `today`
   * removes it. The census module holds no clock read, and the test reads only its code lines.
   *
   * The whole ratchet at a named day holds all three audits and joins their findings. The failing
   * case has a paid-down id that is still waived (`t.a`) and a new vacuous id (`t.c`). It also
   * has a wrong digest and an expired entry. Each of the four codes must appear.
   */
  it('OutputSchemaRatchet_StructuralHalvesStayTimeFree', () => {
    const structural = auditLiveVacuityRatchet();
    expect(structural.expiry).toBeUndefined();
    expect(structural.ok).toBe(true);
    expect(structural.findings).toEqual([]);

    const censusCode = readFileSync(CENSUS_SRC, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(censusCode.length).toBeGreaterThan(300);
    expect(censusCode.filter((l) => l.includes('new Date()'))).toEqual([]);
    expect(censusCode.filter((l) => l.includes('Date.now('))).toEqual([]);

    const whole = auditLiveVacuityRatchetAsOf(SEEDED_ON);
    expect(whole.expiry).toBeDefined();
    expect(whole.expiry?.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(whole.expiry?.entryCount).toBeGreaterThan(0);
    expect(whole.ok).toBe(true);
    expect(whole.findings).toEqual([]);

    const swappedRegistry = censusLiveOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', vacuous())]),
    ]);
    const failing = auditLiveVacuityRatchetAsOf(
      FIRST_DEAD_DAY,
      auditLiveVacuityAllowlist(swappedRegistry, ['t.a', 't.b']),
      auditLiveVacuitySeedIntegrity(['t.a', 't.b'], [], 'a-digest-that-is-not-theirs'),
      auditLiveVacuityExpiry(FIRST_DEAD_DAY, {
        'exarchos_view.tasks': { owner: 'views', expires: '2026-01-01' },
      }),
    );
    expect(failing.ok).toBe(false);
    const codes = new Set(failing.findings.map((f) => f.code));
    expect(codes.has('UNWAIVED_VACUITY')).toBe(true);
    expect(codes.has('STALE_WAIVER')).toBe(true);
    expect(codes.has('SEED_KEY_SET_DRIFT')).toBe(true);
    expect(codes.has('EXPIRED_WAIVER')).toBe(true);
  });
});

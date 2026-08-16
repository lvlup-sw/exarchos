// DR-4 (task 017): the `outputSchema` vacuity allowlist's expiry is ENFORCED,
// not advisory — and the ratchet is an EXECUTABLE gate, not a library nothing
// calls.
//
// ── What task 055/060 already proved, and is NOT re-proved here ─────────────
// Vacuity is unconstructible at compile time; membership is checked in both
// directions; an in-place swap fails against the frozen seed digest. Those live
// in `src/output-schema-vacuity-allowlist.test.ts`
// (`OutputSchema_AllowlistEntrySwapped_FailsRatchet`,
// `OutputSchema_AllowlistIdSwappedInPlace_FailsTheShrinkOnlyCheck`) and are not
// duplicated. This file covers the half those tasks left open: the deadline.
//
// ── TWO AUTHORITIES ────────────────────────────────────────────────────────
// Authority A is the GENERATED DATA FILE `src/output-schema-vacuity-allowlist.ts`
// — `{ owner, expires }` records in a module that imports nothing. Authority B
// is the FROZEN PIN `src/output-schema-seed-pin.ts`, which likewise imports
// nothing and holds the anchor, the step and the budget those deadlines are
// measured against. Neither can observe the other; the guard compares them, and
// the comparison is what this file drives.
//
// ── WHAT TASK 093 ADDED ────────────────────────────────────────────────────
// The cap used to be one date for every entry, so the whole seed came due on one
// morning. It is now a per-OWNER schedule DERIVED from the seed, and the tests
// below cover the three things that derivation has to be: staggered (a non-last
// cohort dated on the anchor FAILS), stable (a paydown moves no slot), and
// bounded (the anchor itself cannot be pushed past the runway budget).
//
// ── THE CLOCK ──────────────────────────────────────────────────────────────
// Every verdict below is taken at a NAMED day passed in as data. Not one
// assertion reads the wall clock, so no test here can start failing because time
// passed — the deadline reddens the CI gate (`runGuard()` with its default
// clock, wired into the unfiltered grep-gates lane), which is the artifact that
// blocks a merge. The one thing asserted ABOUT the wall clock is that it is
// really wired (`resolveToday()` agrees with an independently computed UTC day),
// never what verdict it produces.
//
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
/** Extracted to `tools/conformance/` by task 018a; the guard still reads its source. */
const CENSUS_SRC = resolve(HERE, '../../../tools/conformance/src/output-schema-census.ts');
const PIN_SRC = resolve(HERE, '../../../tools/conformance/src/output-schema-seed-pin.ts');

/** The day the seed was written. Every "before any deadline" verdict uses it. */
const SEEDED_ON = '2026-08-07';
/** The anchor — the LAST slot, and the last day the LAST cohort is live. */
const LAST_LIVE_DAY = VACUITY_EXPIRY_HORIZON;
/** The first day after the anchor. Every seeded waiver is dead here. */
const FIRST_DEAD_DAY = '2027-03-01';

/**
 * The live schedule, derived once. Read from the shipped artifacts rather than
 * written down, so nothing below carries a date or a team name that would have
 * to be maintained alongside the seed.
 */
const LIVE_COHORTS = deriveOwnerCohorts(
  VACUITY_ALLOWLIST,
  VACUITY_RETIRED,
  VACUITY_EXPIRY_HORIZON,
  VACUITY_STAGGER_STEP_DAYS,
);

/**
 * The calendar day after `day`.
 *
 * Written here rather than imported on purpose: the guard's own schedule
 * arithmetic is one of the things under test, so a fixture that borrowed it
 * would agree with it by construction. `isoDayUtc` is used only to FORMAT, and
 * is exercised independently below against a hand-computed UTC day.
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
  it('OutputSchemaExpiry_PastExpiryEntry_FailsTheGuard', () => {
    // THE KILL FIXTURE. A guard with no failing subject has not been shown to
    // work, so the subject is produced twice — once from the LIVE seed carried
    // past its own deadline, and once from a single planted entry.

    // (1) The live allowlist (112 as seeded, 111 since task 069's paydown), one
    // day after the horizon. Nothing synthetic: these are the real waivers, the
    // real owners and the real dates, read from the generated data file. The
    // denominator is the live list, not an empty filter — asserted below against
    // `VACUITY_ALLOWLIST_IDS.length` and `toBeGreaterThan(0)`.
    const live = auditLiveVacuityExpiry(FIRST_DEAD_DAY);
    expect(live.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(live.entryCount).toBeGreaterThan(0);
    expect(live.ok).toBe(false);
    expect(live.expired).toEqual([...VACUITY_ALLOWLIST_IDS]);
    expect(live.findings.every((f) => f.code === 'EXPIRED_WAIVER')).toBe(true);
    // The finding names the owner the debt comes due for and the legal repair,
    // because a red gate without a repair is a gate people delete.
    const first = live.findings[0];
    expect(first).toBeDefined();
    expect(first?.code).toBe('EXPIRED_WAIVER');
    expect(formatVacuityExpiryAudit(live)).toContain('FAILED');
    expect(formatVacuityExpiryAudit(live)).toContain('MOVE its entry to VACUITY_RETIRED');
    expect(formatVacuityExpiryAudit(live)).toContain('Bumping the date is not the fix');

    // …and the GUARD — the thing CI runs — exits non-zero on it, with the
    // expired ids in its report. The default `entries` seam is exercised here:
    // nothing was injected but the day, so the 112 above came from the live
    // allowlist and not from a fixture the test handed in.
    const red = invoke({ today: FIRST_DEAD_DAY });
    expect(red.code).toBe(1);
    expect(red.out).toBe('');
    expect(red.err).toContain('EXPIRED_WAIVER');
    expect(red.err).toContain('exarchos_workflow.init');
    expect(red.err).toContain(FIRST_DEAD_DAY);

    // (2) One planted entry, expired yesterday, against an otherwise clean day.
    // The single-entry form proves the tooth bites on ONE stale waiver and does
    // not need the whole list to lapse at once.
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

    // The boundary is INCLUSIVE of the expiry day, matching the field's
    // documented meaning ("the date after which the waiver is expired"). An
    // off-by-one here silently buys or destroys a day of every waiver's life.
    const onTheDay = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: SEEDED_ON },
    });
    expect(onTheDay.expired).toEqual([]);
    expect(onTheDay.ok).toBe(true);
  });

  it('OutputSchemaExpiry_UnexpiredEntry_PassesTheGuard', () => {
    // The other side of the kill fixture, and the reason it is evidence: the
    // guard is not simply red. The SAME live seed, the SAME code path, before
    // any deadline — green.
    //
    // The schedule is staggered now, so the last day the WHOLE seed is live is
    // the FIRST cohort's slot, not the last. Derived from the schedule rather
    // than written, because the day this assertion needs is a consequence of
    // the seed and would otherwise have to be maintained alongside it.
    const firstSlot = slot(0);
    const wholeSeedLive = auditVacuityExpiry(firstSlot.horizon);
    expect(wholeSeedLive.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(wholeSeedLive.ok).toBe(true);
    expect(wholeSeedLive.expired).toEqual([]);
    expect(wholeSeedLive.beyondHorizon).toEqual([]);
    expect(wholeSeedLive.malformed).toEqual([]);

    // The anchor is still the last day the LAST cohort is live, and it is still
    // the date the global horizon check measures against.
    const lastLive = auditVacuityExpiry(LAST_LIVE_DAY, liveEntriesOf(slot(LIVE_COHORTS.length - 1)));
    expect(lastLive.entryCount).toBeGreaterThan(0);
    expect(lastLive.ok).toBe(true);
    expect(lastLive.expired).toEqual([]);
    expect(lastLive.daysToHorizon).toBe(0);

    // …and on the seeding day, with the countdown derived rather than written.
    const atSeeding = auditLiveVacuityExpiry(SEEDED_ON);
    expect(atSeeding.ok).toBe(true);
    expect(atSeeding.daysToHorizon).toBe(205);
    expect(formatVacuityExpiryAudit(atSeeding)).toContain('OK');

    // The whole guard, end to end, at a named day: exit 0 and a report that
    // states its denominator. A proportion without its denominator is the rubber
    // stamp DR-4 exists to remove.
    const green = invoke({ today: SEEDED_ON });
    expect(green.code).toBe(0);
    expect(green.err).toBe('');
    expect(green.out).toContain('OK as of 2026-08-07');
    // 111, not the 112 that were seeded: task 069 paid
    // `exarchos_orchestrate.check_invariant_conformance` down. The denominator
    // is unchanged at 122 — a paydown moves a declaration between the two
    // classes, it does not remove the declaration.
    // DERIVED on BOTH sides, not written as literals. This line has now been
    // broken twice by correct changes: task 068 grew the denominator (a new
    // action with a substantive schema, 122 -> 123) and task 069 shrank the
    // numerator (paying `check_invariant_conformance` off the allowlist,
    // 112 -> 111). Neither had anything to do with the deadline this test is
    // about, and each read as a guard failure. A count written as a literal
    // inside a guard's own self-test is the defect this wave removes everywhere
    // else; the proportion is what matters here, so both terms are read from
    // the live artifacts and the assertion tracks the tree.
    const liveWaived = VACUITY_ALLOWLIST_IDS.length;
    const liveTotal = censusLiveOutputSchemas().total;
    expect(liveWaived).toBeGreaterThan(0);
    expect(liveTotal).toBeGreaterThan(liveWaived);
    expect(green.out).toContain(`${liveWaived} waived of ${liveTotal} declaration(s)`);
    expect(green.out).toContain(`horizon ${VACUITY_EXPIRY_HORIZON}`);

    // THE PER-OWNER TREND (task 093). The report names every cohort with its
    // live count over its seeded count, on the GREEN path, so a paydown is
    // visible in the log of the PR that did it rather than only at the cliff.
    // Both terms are read from the live artifacts; a literal here would be the
    // trip-wire this file has already had to remove twice.
    for (const cohort of LIVE_COHORTS) {
      expect(green.out, cohort.owner).toContain(cohort.owner);
      expect(green.out, cohort.owner).toContain(
        `${String(cohort.live).padStart(3)} of ${String(cohort.seeded).padStart(3)}`,
      );
      expect(green.out, cohort.owner).toContain(`due ${cohort.horizon}`);
    }
    // …and the trend is a real one: the seeded total exceeds the live total,
    // because entries have actually been paid down since the seed was written.
    const seededTotal = LIVE_COHORTS.reduce((sum, cohort) => sum + cohort.seeded, 0);
    const liveTotalByOwner = LIVE_COHORTS.reduce((sum, cohort) => sum + cohort.live, 0);
    expect(liveTotalByOwner).toBe(liveWaived);
    expect(seededTotal).toBe(VACUITY_ALLOWLIST_IDS.length + VACUITY_RETIRED_IDS.length);
    expect(seededTotal).toBeGreaterThan(liveTotalByOwner);

    // Exactly one day separates green from red at the FIRST slot, and both were
    // produced by this test — the guard's verdict really is a function of the
    // date, and the pressure really does arrive before the anchor. Under task
    // 017's single horizon the earlier of these two days was green.
    expect(invoke({ today: firstSlot.horizon }).code).toBe(0);
    const afterFirstSlot = invoke({ today: dayAfter(firstSlot.horizon) });
    expect(afterFirstSlot.code).toBe(1);
    expect(afterFirstSlot.err).toContain('EXPIRED_WAIVER');
    // …and only THAT cohort is due. Incremental pressure is the whole claim; if
    // every cohort expired together the stagger would be decoration.
    const expiredIds = Object.keys(liveEntriesOf(firstSlot)).sort();
    expect(expiredIds.length).toBeGreaterThan(0);
    expect(expiredIds.length).toBeLessThan(VACUITY_ALLOWLIST_IDS.length);
    const stillLive = auditVacuityExpiry(dayAfter(firstSlot.horizon));
    expect([...stillLive.expired].sort()).toEqual(expiredIds);

    // And the anchor is no longer a day the whole seed survives.
    expect(invoke({ today: LAST_LIVE_DAY }).code).toBe(1);
    expect(invoke({ today: FIRST_DEAD_DAY }).code).toBe(1);
  });

  it('OutputSchemaExpiry_EntryDatedBeyondThePinnedHorizon_FailsTheGuard', () => {
    // THE RENEWAL TOOTH — the question "what stops a future author bumping every
    // date in one commit", answered mechanically.
    //
    // Enforcing `expires` alone would be theatre: on the day it bites, the
    // cheapest green is a sed over the 112-line sorted literal adding a year to
    // every date, and that diff looks exactly like the paydown diffs the file
    // already receives. So a waiver may not name its own deadline. Every entry
    // is capped by ONE pinned horizon that lives in a different file — one that
    // imports nothing, contains only frozen values, and is headed with the
    // instruction not to edit it to go green.

    // The blanket bump, as data: every live entry re-dated far into the future.
    // Not one of them is expired at any plausible `today`, and every one fails.
    const bumped = auditLiveVacuityExpiry(SEEDED_ON, reDated('2099-01-01'));
    expect(bumped.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(bumped.expired).toEqual([]);
    expect(bumped.beyondHorizon).toEqual([...VACUITY_ALLOWLIST_IDS]);
    expect(bumped.ok).toBe(false);
    expect(formatVacuityExpiryAudit(bumped)).toContain('WAIVER_BEYOND_HORIZON');
    expect(formatVacuityExpiryAudit(bumped)).toContain('may not name its own deadline');

    // A SINGLE entry inching one day past the horizon fails just as hard — the
    // tooth is not a "most of them moved" heuristic.
    const oneDayOver = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: '2027-03-01' },
    });
    expect(oneDayOver.beyondHorizon).toEqual(['exarchos_view.tasks']);
    expect(oneDayOver.ok).toBe(false);

    // Pulling a date FORWARD is always legal: it only shortens the debt's life,
    // which is the direction the ratchet wants. Without this the tooth would be
    // "no edits", not "no renewals".
    const earlier = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: '2026-09-01' },
    });
    expect(earlier.ok).toBe(true);
    expect(earlier.beyondHorizon).toEqual([]);

    // And the guard exits non-zero on the blanket bump — with the live census
    // and the live seed pin still clean, so the ONLY reason it is red is the
    // renewal. That isolation is the claim.
    const red = invoke({ today: SEEDED_ON, entries: reDated('2099-01-01') });
    expect(red.code).toBe(1);
    expect(red.err).toContain('WAIVER_BEYOND_HORIZON');
    expect(red.err).toContain('VACUITY_EXPIRY_HORIZON in output-schema-seed-pin.ts');
    expect(red.err).not.toContain('SEED_KEY_SET_DRIFT');
    expect(red.err).not.toContain('UNWAIVED_VACUITY');

    // The horizon is the SEPARATION, so it has to live somewhere the entries
    // cannot reach. Structural facts, not prose: the pin module declares it, and
    // the generated data file neither declares nor imports it.
    // Read from the CODE lines only. The prose in that file says "the static
    // import graph", and a `not.toContain('import ')` over the raw text reports
    // that sentence as an import — the measure-a-text-proxy defect this program
    // has hit seven times, reproduced by this very assertion on its first run.
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

  it('OutputSchemaExpiry_EntryDatedBeyondItsOwnerHorizon_FailsTheGuard', () => {
    // THE KILL FIXTURE FOR TASK 093, and the reason the stagger is a mechanism
    // rather than a comment. Run both ways below: RED with the violation
    // present, GREEN with the same entry left where the seed put it.
    //
    // The violating date is the ANCHOR itself — the one date task 017's single
    // horizon accepted from every entry. So the fixture is not "a late date
    // fails" (that tooth already existed); it is "a date the GLOBAL cap accepts
    // is still refused, because this entry's OWNER comes due sooner". Nothing is
    // computed from the schedule here: the anchor is read from the pin, which
    // cannot observe the allowlist.
    const early = slot(0);
    const last = slot(LIVE_COHORTS.length - 1);
    expect(last.horizon).toBe(VACUITY_EXPIRY_HORIZON);
    expect(early.horizon < last.horizon).toBe(true);

    const victim = anyLiveIdOf(early);
    const reDated = withReDatedEntry(victim, VACUITY_EXPIRY_HORIZON);

    // RED. The global expiry audit is CLEAN on this input — the entry sits
    // exactly on the pinned horizon and is nowhere near expired — so the only
    // thing that can redden the guard is the per-owner slot.
    const globalHalf = auditVacuityExpiry(SEEDED_ON, reDated);
    expect(globalHalf.ok).toBe(true);
    expect(globalHalf.beyondHorizon).toEqual([]);
    expect(globalHalf.expired).toEqual([]);

    const red = invoke({ today: SEEDED_ON, entries: reDated });
    expect(red.code).toBe(1);
    expect(red.out).toBe('');
    expect(red.err).toContain('WAIVER_BEYOND_OWNER_HORIZON');
    expect(red.err).toContain(victim);
    expect(red.err).toContain(`later than the ${early.owner} cohort's slot ${early.horizon}`);
    // Isolated: nothing else in the ratchet moved.
    expect(red.err).not.toContain('SEED_KEY_SET_DRIFT');
    expect(red.err).not.toContain('UNWAIVED_VACUITY');
    expect(red.err).not.toContain('EXPIRED_WAIVER');

    // GREEN. Same guard, same day, same code path — the entry back on its
    // shipped date. Without this arm the red above would only prove the guard
    // can be red.
    const green = invoke({ today: SEEDED_ON });
    expect(green.code).toBe(0);
    expect(green.err).toBe('');

    // …and the tooth is per-owner, not "the anchor is now forbidden": the LAST
    // cohort's own entries sit on the anchor and pass. That contrast is what
    // makes the finding about ownership rather than about the date.
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

    // Pulling a date FORWARD is legal here too — the cap only bounds one
    // direction, or the tooth would be "no edits" rather than "no renewals".
    const earlier = auditVacuityStagger(
      SEEDED_ON,
      withReDatedEntry(victim, SEEDED_ON),
      VACUITY_RETIRED,
      VACUITY_EXPIRY_HORIZON,
      VACUITY_STAGGER_STEP_DAYS,
      VACUITY_RUNWAY_BUDGET_DAYS,
    );
    expect(earlier.ok).toBe(true);

    // NO WAIVER FALLS THROUGH. Every live entry is compared against a slot,
    // because the schedule ranks over the live entries themselves plus the
    // graveyard. Stated as a measurement over the live population rather than
    // left as an assumption — a per-owner cap that quietly skipped an owner
    // would be exactly the "checked zero times" defect DR-4 exists to remove.
    // (An owner arriving from nowhere means an ID arriving from nowhere, which
    // is an addition and already a SEED_KEY_SET_DRIFT.)
    const scheduledOwners = new Set(LIVE_COHORTS.map((cohort) => cohort.owner));
    const liveOwners = new Set(Object.values(VACUITY_ALLOWLIST).map((entry) => entry.owner));
    expect(liveOwners.size).toBeGreaterThan(0);
    expect([...liveOwners].filter((owner) => !scheduledOwners.has(owner))).toEqual([]);
  });

  it('OutputSchemaSchedule_DerivedFromTheSeed_IsStaggeredAndUnmovedByAPaydown', () => {
    // WHAT THE SCHEDULE IS. Every slot is a real day, they are strictly ordered,
    // the last one is the anchor, and consecutive slots are exactly one step
    // apart — so "staggered" is a measurement and not a description.
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
      // `daysBetween` measures; the guard's schedule SHIFTS. Two different
      // operations over the same day rule, so this is a cross-check rather than
      // a restatement.
      expect(daysBetween(slot(rank - 1).horizon, slot(rank).horizon)).toBe(
        VACUITY_STAGGER_STEP_DAYS,
      );
    }

    // WHO SITS WHERE, against the data file rather than against the derivation:
    // the seeded cohort sizes are non-decreasing across the slots, so the team
    // with the least outstanding work comes due first.
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

    // THE STABILITY CLAIM, and the reason the schedule is derived from the SEED
    // and not from today's allowlist. Pay an entry down — MOVE it from the
    // allowlist to the graveyard, the one legal edit — and not one slot moves.
    // A ranking taken over the live list would reshuffle here, re-date the
    // paying team's own remaining waivers and move other teams' deadlines with
    // them: a gate that reddens on a legitimate paydown.
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
    // …and the live count is what moved, which is the number the report shows.
    expect(afterPaydown[0]?.live).toBe(slot(0).live - 1);

    // The kill fixture for that claim: a schedule ranked on the LIVE list —
    // exactly the obvious derivation this one rejects — DOES move. Without it,
    // "stability" would be a property nothing was shown capable of violating.
    const rankedOnLive = deriveOwnerCohorts(
      Object.fromEntries(Object.entries(VACUITY_ALLOWLIST).filter(([id]) => id !== paidId)),
      {},
      VACUITY_EXPIRY_HORIZON,
      VACUITY_STAGGER_STEP_DAYS,
    );
    expect(rankedOnLive.map((cohort) => cohort.seeded)).not.toEqual(
      LIVE_COHORTS.map((cohort) => cohort.seeded),
    );

    // THE ANTI-RENEWAL TOOTH. A staggered schedule hanging off one constant is
    // still one constant, so the anchor is measured against the clock. The live
    // schedule is inside its budget; the multi-year bump that motivated task
    // 093 is not.
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

    // …and it is a budget, not a ban: a bump INSIDE the ceiling is still legal,
    // which is what keeps "re-date the whole debt as a deliberate decision" a
    // real path rather than a sentence in a header.
    const smallBump = auditVacuityStagger(
      SEEDED_ON,
      VACUITY_ALLOWLIST,
      VACUITY_RETIRED,
      dayAfter(VACUITY_EXPIRY_HORIZON),
      VACUITY_STAGGER_STEP_DAYS,
      VACUITY_RUNWAY_BUDGET_DAYS,
    );
    expect(smallBump.findings.map((f) => f.code)).not.toContain('RUNWAY_BEYOND_BUDGET');

    // An unreadable anchor, a non-positive step and a fractional budget each
    // disable a comparison, so each fails closed rather than waiving its tooth.
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

    // A seed that names no owner at all resolves ZERO slots, which makes every
    // per-owner check trivially true. That is what a broken import looks like.
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

  it('OutputSchemaExpiry_EmptyAllowlistOrEmptyCensus_FailsClosed', () => {
    // NON-EMPTY DENOMINATOR, on both populations the guard reads.
    //
    // An allowlist that resolves to zero entries makes "no expired waiver" true
    // for the worst possible reason, and a census that enumerates zero
    // declarations makes "no unwaived vacuity" true the same way. Both are what
    // a moved module or a broken import looks like, and both must FAIL rather
    // than report clean.
    const noEntries = auditLiveVacuityExpiry(SEEDED_ON, {});
    expect(noEntries.entryCount).toBe(0);
    expect(noEntries.expired).toEqual([]);
    expect(noEntries.ok).toBe(false);
    expect(noEntries.findings.map((f) => f.code)).toEqual(['EMPTY_ALLOWLIST']);

    const emptyThroughTheGuard = invoke({ today: SEEDED_ON, entries: {} });
    expect(emptyThroughTheGuard.code).toBe(1);
    expect(emptyThroughTheGuard.err).toContain('EMPTY_ALLOWLIST');

    // The census side, through the guard: an emptied registry is a failure even
    // though every waiver is perfectly in date.
    const emptyCensus = invoke({ today: SEEDED_ON, tools: [] });
    expect(emptyCensus.code).toBe(1);
    expect(emptyCensus.err).toContain('EMPTY_CENSUS');

    // ONE entry and ONE declaration clear both guards — the tooth bites on
    // emptiness, not on smallness, so it cannot be satisfied by shrinking.
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

  it('OutputSchemaExpiry_MalformedOwnerOrDate_FailsClosed', () => {
    // A waiver with no owner has nobody the debt comes due for; a waiver whose
    // date cannot be compared has no deadline at all. Both must fail rather than
    // read as "in date" — the shape check task 055 shipped only asserted the
    // string's PUNCTUATION, which is presence, not substance.
    const unowned = auditLiveVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: '   ', expires: LAST_LIVE_DAY },
    });
    expect(unowned.malformed).toEqual(['exarchos_view.tasks']);
    expect(unowned.ok).toBe(false);

    // `2027-02-31` MATCHES /^\d{4}-\d{2}-\d{2}$/ and does not exist. A pattern
    // check would accept it, `<` would compare it happily, and the entry would
    // outlive every real date in February forever.
    expect(isIsoDay('2027-02-31')).toBe(false);
    expect(isIsoDay('2027-13-01')).toBe(false);
    expect(isIsoDay('2027-2-8')).toBe(false);
    expect(isIsoDay('next wave')).toBe(false);
    expect(isIsoDay('2028-02-29')).toBe(true); // a real leap day
    expect(isIsoDay('2027-02-28')).toBe(true);

    for (const bad of ['2027-02-31', '2027-13-01', 'next wave', '']) {
      const audit = auditLiveVacuityExpiry(SEEDED_ON, {
        'exarchos_view.tasks': { owner: 'views', expires: bad },
      });
      expect(audit.malformed, bad).toEqual(['exarchos_view.tasks']);
      expect(audit.ok, bad).toBe(false);
    }

    // An unreadable CLOCK or an unreadable HORIZON disables the comparison
    // itself, so both fail closed rather than reporting the waivers live.
    expect(auditLiveVacuityExpiry('someday').findings.map((f) => f.code)).toContain(
      'UNREADABLE_CLOCK',
    );
    expect(auditLiveVacuityExpiry(SEEDED_ON, VACUITY_ALLOWLIST, 'eventually').ok).toBe(false);
    expect(
      auditLiveVacuityExpiry(SEEDED_ON, VACUITY_ALLOWLIST, 'eventually').findings.map((f) => f.code),
    ).toContain('MALFORMED_HORIZON');
    expect(isoDayUtc(new Date(Number.NaN))).toBe('');

    // The LIVE seed is well-formed on every axis — the assertion that would
    // redden if a hand-edited entry ever lost its owner or its date, with a real
    // denominator rather than an empty `every()`.
    const liveWellFormed = auditLiveVacuityExpiry(SEEDED_ON);
    // DERIVED, not literal (task 018). This line carried `toBe(111)` beside the
    // derived assertion below — a trip-wire that says nothing the next line does
    // not already say, and that reddens on the next legitimate paydown. The
    // literal has already broken twice in this wave (068 grew the denominator,
    // 069 shrank the numerator); `toBeGreaterThan(0)` keeps the non-empty
    // denominator the assertion actually needs.
    expect(liveWellFormed.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(liveWellFormed.entryCount).toBeGreaterThan(0);
    expect(liveWellFormed.malformed).toEqual([]);
  });

  it('OutputSchemaRatchetGuard_ProductionDefaultsAreTheLiveArtifacts', () => {
    // THE ANTI-STUB TOOTH. Every verdict above was taken through an injected
    // seam. A guard proven only through its seams has been proven about the
    // seams — the live wiring could point at a fixture and every assertion would
    // still pass. So the defaults are pinned by REFERENCE IDENTITY against the
    // modules that own them.
    expect(LIVE_SUBJECT.entries).toBe(VACUITY_ALLOWLIST);
    expect(LIVE_SUBJECT.retiredEntries).toBe(VACUITY_RETIRED);
    expect(LIVE_SUBJECT.waived).toBe(VACUITY_ALLOWLIST_IDS);
    expect(LIVE_SUBJECT.retired).toBe(VACUITY_RETIRED_IDS);
    expect(LIVE_SUBJECT.pinnedDigest).toBe(VACUITY_SEED_KEY_SET_DIGEST);
    expect(LIVE_SUBJECT.horizon).toBe(VACUITY_EXPIRY_HORIZON);
    expect(LIVE_SUBJECT.stepDays).toBe(VACUITY_STAGGER_STEP_DAYS);
    expect(LIVE_SUBJECT.runwayBudgetDays).toBe(VACUITY_RUNWAY_BUDGET_DAYS);

    // …and behaviourally, not just structurally: with ONLY the day injected, the
    // guard reports the real live ids. A stubbed default could not produce them.
    const red = invoke({ today: FIRST_DEAD_DAY });
    for (const id of ['exarchos_workflow.init', 'exarchos_view.tasks', 'exarchos_event.append']) {
      expect(red.err, id).toContain(id);
    }

    // The CLOCK is really wired — asserted as "it agrees with an independently
    // computed UTC day", never as a verdict. Pinning a verdict to the wall clock
    // is how a deadline becomes a test that fails for the passage of time.
    const now = new Date();
    const independent = `${String(now.getUTCFullYear()).padStart(4, '0')}-${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    expect(resolveToday(now)).toBe(independent);
    expect(isIsoDay(resolveToday())).toBe(true);
    expect(resolveToday(new Date(Date.UTC(2027, 1, 28, 23, 59, 59)))).toBe('2027-02-28');
    expect(resolveToday(new Date(Date.UTC(2027, 2, 1, 0, 0, 0)))).toBe('2027-03-01');
  });

  it('OutputSchemaRatchet_StructuralHalvesStayTimeFree', () => {
    // The design decision, made executable: the two STRUCTURAL halves are pure
    // functions of the registry and the seed, and stay callable without a clock.
    // That is what keeps the unit suite deterministic while the gate is
    // time-dependent — and it is a property someone could quietly destroy by
    // giving `today` a `new Date()` default, so it is pinned here.
    const structural = auditLiveVacuityRatchet();
    expect(structural.expiry).toBeUndefined();
    expect(structural.ok).toBe(true);
    expect(structural.findings).toEqual([]);

    // The census module — where every audit lives — contains no clock read at
    // all. Read from the CODE lines only, so the prose explaining WHY there is
    // no clock is not mistaken for one.
    const censusCode = readFileSync(CENSUS_SRC, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
    expect(censusCode.length).toBeGreaterThan(300);
    expect(censusCode.filter((l) => l.includes('new Date()'))).toEqual([]);
    expect(censusCode.filter((l) => l.includes('Date.now('))).toEqual([]);

    // The WHOLE ratchet at a named day carries all three halves, and its
    // findings are the concatenation — no half is silently dropped when another
    // is clean. A composition that reported only the first failure would hide
    // the other two behind whichever repair came first.
    const whole = auditLiveVacuityRatchetAsOf(SEEDED_ON);
    expect(whole.expiry).toBeDefined();
    // DERIVED, not literal (task 018) — same trip-wire as above. What this
    // assertion is for is that the expiry half really was CARRIED into the
    // composition over the live seed, which the derived comparison states and a
    // hard-coded 111 only obscured.
    expect(whole.expiry?.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(whole.expiry?.entryCount).toBeGreaterThan(0);
    expect(whole.ok).toBe(true);
    expect(whole.findings).toEqual([]);

    const swappedRegistry = censusLiveOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', vacuous())]),
    ]);
    const failing = auditLiveVacuityRatchetAsOf(
      FIRST_DEAD_DAY,
      // membership: `t.a` paid down but still waived, `t.c` newly vacuous
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

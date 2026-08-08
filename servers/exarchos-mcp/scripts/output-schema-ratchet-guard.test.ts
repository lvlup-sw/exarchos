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
// — 112 `{ owner, expires }` records in a module that imports nothing. Authority
// B is the FROZEN PIN `src/output-schema-seed-pin.ts`, which likewise imports
// nothing and holds the single horizon every one of those deadlines is measured
// against. Neither can observe the other; the guard compares them, and the
// comparison is what this file drives.
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
// @oracle-sources: ../src/output-schema-vacuity-allowlist.ts, ../src/output-schema-seed-pin.ts, the Zod schema objects the live tool registry constructs at module-import time and the census walks structurally
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  LIVE_SUBJECT,
  resolveToday,
  runGuard,
  type GuardOptions,
} from './output-schema-ratchet-guard.js';
import {
  auditVacuityAllowlist,
  auditVacuityExpiry,
  auditVacuityRatchet,
  auditVacuityRatchetAsOf,
  auditVacuitySeedIntegrity,
  censusOutputSchemas,
  formatVacuityExpiryAudit,
  isIsoDay,
  isoDayUtc,
  type CensusableAction,
  type CensusableTool,
} from '../src/architecture/output-schema-census.js';
import {
  VACUITY_ALLOWLIST,
  VACUITY_ALLOWLIST_IDS,
  VACUITY_RETIRED_IDS,
  type VacuityWaiverEntry,
} from '../src/output-schema-vacuity-allowlist.js';
import {
  VACUITY_EXPIRY_HORIZON,
  VACUITY_SEED_KEY_SET_DIGEST,
} from '../src/output-schema-seed-pin.js';
import {
  unregisteredActionOutputSchema,
  withCappedShape,
} from '../src/output-schema-declaration.js';
import { EnvelopeSchema } from '../src/schemas/envelope.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CENSUS_SRC = resolve(HERE, '..', 'src', 'architecture', 'output-schema-census.ts');
const PIN_SRC = resolve(HERE, '..', 'src', 'output-schema-seed-pin.ts');

/** The day the 112 waivers were seeded. Every "before the deadline" verdict uses it. */
const SEEDED_ON = '2026-08-07';
/** The horizon itself — the LAST day every seeded waiver is still live. */
const LAST_LIVE_DAY = VACUITY_EXPIRY_HORIZON;
/** The first day after the horizon. Every seeded waiver is dead here. */
const FIRST_DEAD_DAY = '2027-03-01';

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
    const live = auditVacuityExpiry(FIRST_DEAD_DAY);
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
    const planted = auditVacuityExpiry(SEEDED_ON, plantedEntries);
    expect(planted.entryCount).toBe(1);
    expect(planted.ok).toBe(false);
    expect(planted.expired).toEqual(['exarchos_view.tasks']);
    const plantedRun = invoke({ today: SEEDED_ON, entries: plantedEntries });
    expect(plantedRun.code).toBe(1);
    expect(plantedRun.err).toContain("'exarchos_view.tasks' (owner: views) expired on 2026-08-06");

    // The boundary is INCLUSIVE of the expiry day, matching the field's
    // documented meaning ("the date after which the waiver is expired"). An
    // off-by-one here silently buys or destroys a day of every waiver's life.
    const onTheDay = auditVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: SEEDED_ON },
    });
    expect(onTheDay.expired).toEqual([]);
    expect(onTheDay.ok).toBe(true);
  });

  it('OutputSchemaExpiry_UnexpiredEntry_PassesTheGuard', () => {
    // The other side of the kill fixture, and the reason it is evidence: the
    // guard is not simply red. The SAME live seed, the SAME code path, one day
    // earlier — green.
    const lastLive = auditVacuityExpiry(LAST_LIVE_DAY);
    expect(lastLive.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(lastLive.ok).toBe(true);
    expect(lastLive.expired).toEqual([]);
    expect(lastLive.beyondHorizon).toEqual([]);
    expect(lastLive.malformed).toEqual([]);
    expect(lastLive.daysToHorizon).toBe(0);

    // …and on the seeding day, with the countdown derived rather than written.
    const atSeeding = auditVacuityExpiry(SEEDED_ON);
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
    expect(green.out).toContain('111 waived of 122 declaration(s)');
    expect(green.out).toContain(`horizon ${VACUITY_EXPIRY_HORIZON}`);

    // Exactly one day separates green from red, and both were produced by this
    // test — the guard's verdict really is a function of the date.
    expect(invoke({ today: LAST_LIVE_DAY }).code).toBe(0);
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
    const bumped = auditVacuityExpiry(SEEDED_ON, reDated('2099-01-01'));
    expect(bumped.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(bumped.expired).toEqual([]);
    expect(bumped.beyondHorizon).toEqual([...VACUITY_ALLOWLIST_IDS]);
    expect(bumped.ok).toBe(false);
    expect(formatVacuityExpiryAudit(bumped)).toContain('WAIVER_BEYOND_HORIZON');
    expect(formatVacuityExpiryAudit(bumped)).toContain('may not name its own deadline');

    // A SINGLE entry inching one day past the horizon fails just as hard — the
    // tooth is not a "most of them moved" heuristic.
    const oneDayOver = auditVacuityExpiry(SEEDED_ON, {
      'exarchos_view.tasks': { owner: 'views', expires: '2027-03-01' },
    });
    expect(oneDayOver.beyondHorizon).toEqual(['exarchos_view.tasks']);
    expect(oneDayOver.ok).toBe(false);

    // Pulling a date FORWARD is always legal: it only shortens the debt's life,
    // which is the direction the ratchet wants. Without this the tooth would be
    // "no edits", not "no renewals".
    const earlier = auditVacuityExpiry(SEEDED_ON, {
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

  it('OutputSchemaExpiry_EmptyAllowlistOrEmptyCensus_FailsClosed', () => {
    // NON-EMPTY DENOMINATOR, on both populations the guard reads.
    //
    // An allowlist that resolves to zero entries makes "no expired waiver" true
    // for the worst possible reason, and a census that enumerates zero
    // declarations makes "no unwaived vacuity" true the same way. Both are what
    // a moved module or a broken import looks like, and both must FAIL rather
    // than report clean.
    const noEntries = auditVacuityExpiry(SEEDED_ON, {});
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
    const one = auditVacuityExpiry(SEEDED_ON, {
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
    const unowned = auditVacuityExpiry(SEEDED_ON, {
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
      const audit = auditVacuityExpiry(SEEDED_ON, {
        'exarchos_view.tasks': { owner: 'views', expires: bad },
      });
      expect(audit.malformed, bad).toEqual(['exarchos_view.tasks']);
      expect(audit.ok, bad).toBe(false);
    }

    // An unreadable CLOCK or an unreadable HORIZON disables the comparison
    // itself, so both fail closed rather than reporting the waivers live.
    expect(auditVacuityExpiry('someday').findings.map((f) => f.code)).toContain(
      'UNREADABLE_CLOCK',
    );
    expect(auditVacuityExpiry(SEEDED_ON, VACUITY_ALLOWLIST, 'eventually').ok).toBe(false);
    expect(
      auditVacuityExpiry(SEEDED_ON, VACUITY_ALLOWLIST, 'eventually').findings.map((f) => f.code),
    ).toContain('MALFORMED_HORIZON');
    expect(isoDayUtc(new Date(Number.NaN))).toBe('');

    // The LIVE seed is well-formed on every axis — the assertion that would
    // redden if a hand-edited entry ever lost its owner or its date, with a real
    // denominator rather than an empty `every()`.
    const liveWellFormed = auditVacuityExpiry(SEEDED_ON);
    // 111 since task 069 retired the first entry; 112 were seeded.
    expect(liveWellFormed.entryCount).toBe(111);
    expect(liveWellFormed.entryCount).toBe(VACUITY_ALLOWLIST_IDS.length);
    expect(liveWellFormed.malformed).toEqual([]);
  });

  it('OutputSchemaRatchetGuard_ProductionDefaultsAreTheLiveArtifacts', () => {
    // THE ANTI-STUB TOOTH. Every verdict above was taken through an injected
    // seam. A guard proven only through its seams has been proven about the
    // seams — the live wiring could point at a fixture and every assertion would
    // still pass. So the defaults are pinned by REFERENCE IDENTITY against the
    // modules that own them.
    expect(LIVE_SUBJECT.entries).toBe(VACUITY_ALLOWLIST);
    expect(LIVE_SUBJECT.waived).toBe(VACUITY_ALLOWLIST_IDS);
    expect(LIVE_SUBJECT.retired).toBe(VACUITY_RETIRED_IDS);
    expect(LIVE_SUBJECT.pinnedDigest).toBe(VACUITY_SEED_KEY_SET_DIGEST);
    expect(LIVE_SUBJECT.horizon).toBe(VACUITY_EXPIRY_HORIZON);

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
    const structural = auditVacuityRatchet();
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
    const whole = auditVacuityRatchetAsOf(SEEDED_ON);
    expect(whole.expiry).toBeDefined();
    // 111 since task 069's paydown; 112 were seeded.
    expect(whole.expiry?.entryCount).toBe(111);
    expect(whole.ok).toBe(true);
    expect(whole.findings).toEqual([]);

    const swappedRegistry = censusOutputSchemas([
      tool('t', [action('a', substantive()), action('b', vacuous()), action('c', vacuous())]),
    ]);
    const failing = auditVacuityRatchetAsOf(
      FIRST_DEAD_DAY,
      // membership: `t.a` paid down but still waived, `t.c` newly vacuous
      auditVacuityAllowlist(swappedRegistry, ['t.a', 't.b']),
      auditVacuitySeedIntegrity(['t.a', 't.b'], [], 'a-digest-that-is-not-theirs'),
      auditVacuityExpiry(FIRST_DEAD_DAY, {
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

// DR-5 (task 023): the hand-written CLI verb allowlist is a SHRINK-ONLY ratchet
// whose per-entry expiry is ENFORCED, not advisory — and the ratchet is an
// EXECUTABLE gate, not a library nothing calls.
//
// ── What tasks 020/021/022 already proved, and is NOT re-proved here ─────────
// The parse is structural rather than textual; a seeded twelfth literal is
// detected; a zero-site parse fails closed in the PURE scanner; the kill fixture
// `merge-orchestrate` is rejected and cannot be exempted from data; the policy
// file's own `$comment` pointers are bound to the tree. Those live in
// `./cli-derivation-guard.test.ts` and are not duplicated. This file covers the
// half those tasks left open: may the tolerated set change, and for how long.
//
// ── TWO AUTHORITIES ─────────────────────────────────────────────────────────
// Authority A is the POLICY DATA `./cli-derivation-allowlist.json` — ten
// `{ owner, expires }` records in an inert file. Authority B is the FROZEN PIN
// `./cli-derivation-seed-pin.ts`, which imports nothing and holds both the
// digest of the seed's key set and the single horizon every deadline is measured
// against. Neither can observe the other; the guard compares them, and the
// comparison is what this file drives.
//
// Authority C, for the membership half, is the LIVE COMPOSITION ROOT parsed off
// disk. Every count below is DERIVED from that parse or from the policy file —
// none is written down as a literal, because four assertions in this wave broke
// when a guard's self-test hard-coded the number it measures and a CORRECT
// change elsewhere moved it.
//
// ── THE CLOCK ───────────────────────────────────────────────────────────────
// Every verdict below is taken at a NAMED day passed in as data. Not one
// assertion reads the wall clock, so no test here can start failing because time
// passed — the deadline reddens the CI gate (`runRatchetGuard()` with its
// default clock, wired into the unfiltered grep-gates deps tail), which is the
// artifact that blocks a merge. The one thing asserted ABOUT the wall clock is
// that it is really wired (`resolveToday()` agrees with an independently
// computed UTC day), never what verdict it produces.
//
// @oracle-sources: ./cli-derivation-allowlist.json, ./cli-derivation-seed-pin.ts, ../src/adapters/cli.ts parsed by the TypeScript compiler
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  ALLOWLIST_PATH,
  GOVERNED_SOURCES,
  KILL_FIXTURE_COMMANDS,
  REPO_ROOT,
  auditCliAllowlistMembership,
  auditCliDerivationExpiry,
  auditCliDerivationSeedIntegrity,
  auditCliRatchetAsOf,
  cliDerivationSeedDigest,
  formatCliExpiryAudit,
  formatCliMembershipAudit,
  formatCliSeedIntegrityAudit,
  isIsoDay,
  isoDayUtc,
  isKillFixture,
  readPolicy,
  scanGovernedSources,
  scanSourceForCommandSites,
  type CliDerivationPolicy,
  type CliWaiverEntry,
} from './cli-derivation-guard.js';
import {
  LIVE_SUBJECT,
  resolveToday,
  runRatchetGuard,
  type RatchetGuardOptions,
} from './cli-derivation-ratchet-guard.js';
import {
  CLI_DERIVATION_EXPIRY_HORIZON,
  CLI_DERIVATION_SEED_KEY_SET_DIGEST,
} from './cli-derivation-seed-pin.js';

/** The day the ten waivers were seeded. Every "before the deadline" verdict uses it. */
const SEEDED_ON = '2026-08-07';
/** The horizon itself — the LAST day every seeded waiver is still live. */
const LAST_LIVE_DAY = CLI_DERIVATION_EXPIRY_HORIZON;
/** The first day after the horizon. Every seeded waiver is dead here. */
const FIRST_DEAD_DAY = '2027-03-01';

const LIVE_SCAN = scanGovernedSources();
const LIVE_POLICY = readPolicy();

/**
 * The governed composition root's source text.
 *
 * Read through {@link GOVERNED_SOURCES} rather than a path typed out here, so
 * the seeded-literal fixtures below operate on the SAME file the guard governs
 * and a future split of the composition root cannot leave them testing a stale
 * one.
 */
function sourceOfGovernedRoot(): string {
  const relative = GOVERNED_SOURCES[0];
  if (relative === undefined) throw new Error('GOVERNED_SOURCES is empty');
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** Drive the CLI entrypoint and capture what it wrote, so exit code AND report are observable. */
function invoke(options: RatchetGuardOptions): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = runRatchetGuard({
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

/** A policy built from the live one with the given overrides — never a hand-typed fixture. */
function policyOf(
  allowed: Readonly<Record<string, CliWaiverEntry>>,
  retired: CliDerivationPolicy['retired'] = {},
): CliDerivationPolicy {
  return { allowed, retired };
}

/** Re-date every live waiver — the "bump them all in one commit" attack, as data. */
function reDated(expires: string): Readonly<Record<string, CliWaiverEntry>> {
  const out: Record<string, CliWaiverEntry> = {};
  for (const [name, entry] of Object.entries(LIVE_POLICY.allowed)) {
    out[name] = { owner: entry.owner, expires };
  }
  return out;
}

describe('DR-5: the CLI-derivation allowlist is seeded from the live parse', () => {
  it('CliRatchet_SeededAllowlist_CoversEveryLiteralExceptTheKillFixture', () => {
    // The subject list is DERIVED here, not transcribed. The spec's task-023
    // prose named eight verbs AND included `merge-orchestrate`; the parse said
    // eleven literals of which one was the kill fixture, so the allowlist was
    // TEN. Task 076 then DELETED the kill fixture's hand-written call, so the
    // live parse is ten literals of which none is a kill fixture — and the
    // allowlist is still ten. Nothing below states any of those numbers as a
    // literal; both sides come from the tree, which is why a correct paydown
    // moves them together instead of reddening this test.
    const literalNames = [...new Set(LIVE_SCAN.literals.map((s) => s.name))].sort();
    const killFixtures = literalNames.filter(isKillFixture);
    const allowlistable = literalNames.filter((n) => !isKillFixture(n));

    expect(literalNames.length).toBeGreaterThan(0);

    // No kill fixture survives in the live composition root (task 076). This is
    // the DR-5 exit for `merge-orchestrate`: not exempted, deleted. Policy is
    // still declared — an empty KILL_FIXTURE_COMMANDS would make the exclusion
    // below vacuous, so the declaration is asserted separately from the live
    // population it currently matches nothing in.
    expect(killFixtures).toEqual([]);
    expect(KILL_FIXTURE_COMMANDS.length).toBeGreaterThan(0);

    expect(Object.keys(LIVE_POLICY.allowed).sort()).toEqual(allowlistable);
    expect(Object.keys(LIVE_POLICY.allowed).length).toBe(literalNames.length - killFixtures.length);

    // Every entry carries BOTH fields, non-empty and well-formed. This is the
    // shape DR-5 asks for; whether it is ENFORCED is the expiry section below.
    for (const [name, entry] of Object.entries(LIVE_POLICY.allowed)) {
      expect(entry.owner.trim().length, `${name} has an owner`).toBeGreaterThan(0);
      expect(isIsoDay(entry.expires), `${name} expires on a real day`).toBe(true);
    }

    // The graveyard starts empty — nothing has been paid down yet — but it is
    // PRESENT, because it is half of the pinned key set.
    expect(Object.keys(LIVE_POLICY.retired)).toEqual([]);
  });

  it('CliRatchet_LiveTree_PassesEveryTooth', () => {
    // The other side of every kill fixture below, and the reason they are
    // evidence: the guard is not simply red. Same live artifacts, same code
    // path, a named day inside the horizon — green.
    const verdict = auditCliRatchetAsOf(SEEDED_ON, LIVE_SCAN, LIVE_POLICY);
    expect(verdict.findings, verdict.findings.join(', ')).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.membership.ok).toBe(true);
    expect(verdict.seed.ok).toBe(true);
    expect(verdict.expiry.ok).toBe(true);

    // …and the GUARD — the thing CI runs — exits 0 on it, with a report that
    // states its denominators. A proportion without its denominator is the
    // rubber stamp this ratchet exists to remove.
    const green = invoke({ today: SEEDED_ON });
    expect(green.code).toBe(0);
    expect(green.err).toBe('');
    expect(green.out).toContain('OK as of 2026-08-07');
    expect(green.out).toContain(`${Object.keys(LIVE_POLICY.allowed).length} tracked waiver(s)`);
    expect(green.out).toContain(`${LIVE_SCAN.sites.length} \`.command(\` site(s)`);

    // The production defaults really are the live artifacts, not a stub: a guard
    // proven only through its injected seams has been proven about the seams.
    expect(LIVE_SUBJECT.allowlistPath).toBe(ALLOWLIST_PATH);
    expect(LIVE_SUBJECT.horizon).toBe(CLI_DERIVATION_EXPIRY_HORIZON);
    expect(LIVE_SUBJECT.pinnedDigest).toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
  });
});

describe('DR-5: the allowlist may only SHRINK', () => {
  it('CliRatchet_EleventhEntrySeeded_FailsTheGuard', () => {
    // THE KILL PROBE the task names: seed one more entry than the measured
    // population and the guard must fail. The count is DERIVED — `+ 1` on the
    // live key set — so a legitimate paydown that moves the population to nine
    // does not silently turn this into a no-op.
    const seededName = 'seeded-eleventh';
    const grown = policyOf({
      ...LIVE_POLICY.allowed,
      [seededName]: { owner: 'cli-surface', expires: LAST_LIVE_DAY },
    });
    expect(Object.keys(grown.allowed).length).toBe(Object.keys(LIVE_POLICY.allowed).length + 1);

    const verdict = auditCliRatchetAsOf(SEEDED_ON, LIVE_SCAN, grown);
    expect(verdict.ok).toBe(false);

    // It fails on TWO independent teeth, and both matter:
    //  • the key set grew, so the frozen digest no longer matches — this is the
    //    tooth that catches an addition even when the new name IS a live literal;
    //  • nothing in the composition root is called `seeded-eleventh`, so the
    //    entry is also a STALE waiver.
    expect(verdict.findings).toContain('SEED_KEY_SET_DRIFT');
    expect(verdict.findings).toContain('STALE_WAIVER');
    expect(verdict.seed.keySetSize).toBe(Object.keys(LIVE_POLICY.allowed).length + 1);
    expect(verdict.seed.digest).not.toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
    expect(verdict.membership.stale).toEqual([seededName]);

    // …and the GUARD exits non-zero with the repair in its report.
    const red = invoke({ today: SEEDED_ON, policy: grown });
    expect(red.code).toBe(1);
    expect(red.out).toBe('');
    expect(red.err).toContain('SEED_KEY_SET_DRIFT');
    expect(red.err).toContain(seededName);
    expect(red.err).toContain('Do NOT regenerate the pin to go green');
  });

  it('CliRatchet_EntrySwappedInPlace_FailsTheShrinkOnlyCheck', () => {
    // The defect a COUNT cannot see and a comparison against today cannot see:
    // drop one name, add another, cardinality unchanged. A threshold ratchet
    // ("no more than ten hand-written verbs") passes this; membership against
    // the live parse passes it too if the new name is genuinely a live literal.
    // Only PRIOR STATE catches it.
    const names = Object.keys(LIVE_POLICY.allowed).sort();
    const dropped = names[0];
    if (dropped === undefined) throw new Error('the live allowlist is empty');

    const swapped: Record<string, CliWaiverEntry> = {};
    for (const [name, entry] of Object.entries(LIVE_POLICY.allowed)) {
      if (name === dropped) continue;
      swapped[name] = entry;
    }
    swapped['swapped-in'] = { owner: 'cli-surface', expires: LAST_LIVE_DAY };
    expect(Object.keys(swapped).length).toBe(names.length);

    const seed = auditCliDerivationSeedIntegrity(Object.keys(swapped), []);
    expect(seed.ok).toBe(false);
    expect(seed.keySetSize).toBe(names.length);
    expect(seed.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);
    expect(formatCliSeedIntegrityAudit(seed)).toContain('FAILED');

    // The LEGAL edit — a paydown, recorded as a MOVE — leaves the pin valid.
    // Without this the tooth could be "any edit fails", which is not a ratchet.
    const paidDown: Record<string, CliWaiverEntry> = {};
    for (const [name, entry] of Object.entries(LIVE_POLICY.allowed)) {
      if (name === dropped) continue;
      paidDown[name] = entry;
    }
    const moved = auditCliDerivationSeedIntegrity(Object.keys(paidDown), [dropped]);
    expect(moved.ok).toBe(true);
    expect(moved.digest).toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
    expect(moved.keySetSize).toBe(names.length);

    // And a paydown recorded as a DELETION does not: prior state destroyed.
    const deleted = auditCliDerivationSeedIntegrity(Object.keys(paidDown), []);
    expect(deleted.ok).toBe(false);
    expect(deleted.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);

    // A COPY rather than a move is caught separately: the digest absorbs it (a
    // set union is idempotent), but the entry stays live while reading retired.
    const copied = auditCliDerivationSeedIntegrity(names, [dropped]);
    expect(copied.digest).toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
    expect(copied.ok).toBe(false);
    expect(copied.findings.map((f) => f.code)).toEqual(['RETIRED_AND_WAIVED']);
    expect(copied.overlapping).toEqual([dropped]);
  });

  it('CliRatchet_SeedDigest_IsASetNotAList', () => {
    // The pinned quantity is a SET, so re-sorting the policy file or writing a
    // name twice must not move the digest. Only membership may.
    const names = Object.keys(LIVE_POLICY.allowed);
    const reversed = [...names].reverse();
    expect(cliDerivationSeedDigest(reversed)).toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
    const first = names[0];
    if (first === undefined) throw new Error('the live allowlist is empty');
    expect(cliDerivationSeedDigest([...names, first])).toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
    expect(cliDerivationSeedDigest(names.slice(1))).not.toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
  });
});

describe('DR-5: membership is checked in BOTH directions', () => {
  it('CliRatchet_UntrackedLiteral_FailsAndStaleWaiver_FailsToo', () => {
    // (1) A NEW hand-written verb, seeded into the real source text. The
    // allowlist does not track it, so it fails — this is the direction that
    // stops the debt growing.
    const seeded = scanSourceForCommandSites(
      `${sourceOfGovernedRoot()}\nconst __seeded = program.command('seeded-verb').description('x');\n`,
      'cli.ts',
    );
    expect(seeded.literals.length).toBe(LIVE_SCAN.literals.length + 1);

    const grownTree = auditCliAllowlistMembership(seeded, LIVE_POLICY);
    expect(grownTree.ok).toBe(false);
    expect(grownTree.untracked).toEqual(['seeded-verb']);
    expect(grownTree.findings.map((f) => f.code)).toEqual(['UNTRACKED_LITERAL']);
    // The repair message must NOT read as "add an allowlist entry", or the next
    // author reaches for exactly the edit the pin exists to reject.
    expect(formatCliMembershipAudit(grownTree)).toContain('Adding an entry is NOT the repair');

    // (2) The opposite direction: a tracked name that is no longer a literal.
    // Without this there is somewhere to PARK a paid-down entry, and the list
    // stops describing anything.
    const names = Object.keys(LIVE_POLICY.allowed).sort();
    const paidDownName = names[0];
    if (paidDownName === undefined) throw new Error('the live allowlist is empty');
    const withoutIt = scanSourceForCommandSites(
      sourceOfGovernedRoot().replace(`.command('${paidDownName}')`, '.command(derivedName)'),
      'cli.ts',
    );
    expect(withoutIt.literals.map((s) => s.name)).not.toContain(paidDownName);

    const stale = auditCliAllowlistMembership(withoutIt, LIVE_POLICY);
    expect(stale.ok).toBe(false);
    expect(stale.stale).toEqual([paidDownName]);
    expect(stale.findings.map((f) => f.code)).toEqual(['STALE_WAIVER']);

    // …and the legal repair — MOVE it to the graveyard — is green on membership.
    const movedAllowed: Record<string, CliWaiverEntry> = {};
    for (const [name, entry] of Object.entries(LIVE_POLICY.allowed)) {
      if (name === paidDownName) continue;
      movedAllowed[name] = entry;
    }
    const afterMove = auditCliAllowlistMembership(
      withoutIt,
      policyOf(movedAllowed, { [paidDownName]: { owner: 'cli-surface', retiredAt: SEEDED_ON } }),
    );
    expect(afterMove.ok).toBe(true);

    // (3) Retiring an entry WITHOUT doing the work fails louder than leaving it
    // alone — the graveyard is a record of paydowns, not a suppression list.
    const fakedPaydown = auditCliAllowlistMembership(
      LIVE_SCAN,
      policyOf(movedAllowed, { [paidDownName]: { owner: 'cli-surface', retiredAt: SEEDED_ON } }),
    );
    expect(fakedPaydown.ok).toBe(false);
    expect(fakedPaydown.findings.map((f) => f.code).sort()).toEqual([
      'RETIRED_BUT_LIVE',
      'UNTRACKED_LITERAL',
    ]);
  });

  it('CliRatchet_KillFixture_IsNotTrackedDebtOnEitherSide', () => {
    // The ratchet must not demand an allowlist entry for the one name that may
    // not have one. `merge-orchestrate` is a standing REJECTION (reported
    // unconditionally by the derivation policy), never tracked debt — so it is
    // excluded from both sides of the membership comparison.
    //
    // Task 076 deleted its hand-written call, so the LIVE tree no longer carries
    // the subject. The live half below therefore asserts only what the live tree
    // can still show; the mechanism itself is re-proved against a RE-SEEDED
    // parse, because "the ratchet does not demand an entry for it" is a claim
    // about a scan that CONTAINS it, and a scan that does not contain it cannot
    // distinguish a working exclusion from an absent subject.
    const membership = auditCliAllowlistMembership(LIVE_SCAN, LIVE_POLICY);
    expect(membership.ok).toBe(true);
    for (const killFixture of KILL_FIXTURE_COMMANDS) {
      expect(LIVE_SCAN.literals.map((s) => s.name)).not.toContain(killFixture);
      expect(membership.literals).not.toContain(killFixture);
      expect(membership.untracked).not.toContain(killFixture);
      expect(Object.keys(LIVE_POLICY.allowed)).not.toContain(killFixture);
      expect(Object.keys(LIVE_POLICY.retired)).not.toContain(killFixture);
    }

    // ── Re-seeded: the exclusion still holds when the subject IS present ──────
    const governed = GOVERNED_SOURCES[0];
    if (governed === undefined) throw new Error('GOVERNED_SOURCES is empty');
    const seededName = KILL_FIXTURE_COMMANDS[0];
    if (seededName === undefined) throw new Error('KILL_FIXTURE_COMMANDS is empty');
    const reseeded = scanSourceForCommandSites(
      `${readFileSync(path.join(REPO_ROOT, governed), 'utf8')}\n` +
        `const __killFixture = program.command('${seededName}').description('x');\n`,
      governed,
    );
    const reseededMembership = auditCliAllowlistMembership(reseeded, LIVE_POLICY);
    for (const killFixture of KILL_FIXTURE_COMMANDS) {
      // The subject is genuinely back in the parse…
      expect(reseeded.literals.map((s) => s.name)).toContain(killFixture);
      // …and the ratchet still does not ask for an allowlist entry for it.
      expect(reseededMembership.literals).not.toContain(killFixture);
      expect(reseededMembership.untracked).not.toContain(killFixture);
    }
    // Membership stays GREEN with the kill fixture present and unallowlisted —
    // rejecting it is the derivation policy's job, not the membership ratchet's.
    // (The derivation guard's own test proves it is rejected there.)
    expect(reseededMembership.ok).toBe(true);
  });
});

describe('DR-5: the expiry is enforced, not advisory', () => {
  it('CliRatchetExpiry_PastExpiryEntry_FailsTheGuard', () => {
    // (1) The LIVE seed, one day after the horizon. Nothing synthetic: these are
    // the real waivers, the real owners and the real dates, read from the policy
    // file. The denominator is the live list, asserted against the policy's own
    // key count and `toBeGreaterThan(0)`.
    const live = auditCliDerivationExpiry(FIRST_DEAD_DAY, LIVE_POLICY.allowed);
    expect(live.entryCount).toBe(Object.keys(LIVE_POLICY.allowed).length);
    expect(live.entryCount).toBeGreaterThan(0);
    expect(live.ok).toBe(false);
    expect(live.expired).toEqual(Object.keys(LIVE_POLICY.allowed).sort());
    expect(live.findings.every((f) => f.code === 'EXPIRED_WAIVER')).toBe(true);
    // The finding names the owner the debt comes due for and the legal repair,
    // because a red gate without a repair is a gate people delete.
    expect(formatCliExpiryAudit(live)).toContain('FAILED');
    expect(formatCliExpiryAudit(live)).toContain('MOVE its entry to "retired"');
    expect(formatCliExpiryAudit(live)).toContain('Bumping the date is not the fix');

    // …and the GUARD exits non-zero on it, with the expired names in its report.
    const red = invoke({ today: FIRST_DEAD_DAY });
    expect(red.code).toBe(1);
    expect(red.out).toBe('');
    expect(red.err).toContain('EXPIRED_WAIVER');
    expect(red.err).toContain(FIRST_DEAD_DAY);

    // (2) One planted entry, expired yesterday, against an otherwise clean day.
    // The single-entry form proves the tooth bites on ONE stale waiver and does
    // not need the whole list to lapse at once.
    const planted = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: '2026-08-06' },
    });
    expect(planted.entryCount).toBe(1);
    expect(planted.ok).toBe(false);
    expect(planted.expired).toEqual(['doctor']);
    expect(formatCliExpiryAudit(planted)).toContain(
      "'doctor' (owner: orchestration) expired on 2026-08-06",
    );

    // The boundary is INCLUSIVE of the expiry day, matching the field's
    // documented meaning. An off-by-one here silently buys or destroys a day of
    // every waiver's life.
    const onTheDay = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: SEEDED_ON },
    });
    expect(onTheDay.expired).toEqual([]);
    expect(onTheDay.ok).toBe(true);
  });

  it('CliRatchetExpiry_UnexpiredEntry_PassesTheGuard', () => {
    // The other side of the kill fixture: the SAME live seed, the SAME code
    // path, one day earlier — green.
    const lastLive = auditCliDerivationExpiry(LAST_LIVE_DAY, LIVE_POLICY.allowed);
    expect(lastLive.entryCount).toBe(Object.keys(LIVE_POLICY.allowed).length);
    expect(lastLive.ok).toBe(true);
    expect(lastLive.expired).toEqual([]);
    expect(lastLive.beyondHorizon).toEqual([]);
    expect(lastLive.malformed).toEqual([]);
    expect(lastLive.daysToHorizon).toBe(0);

    const green = invoke({ today: LAST_LIVE_DAY });
    expect(green.code).toBe(0);
    expect(green.out).toContain('0 day(s) remaining');
  });

  it('CliRatchetExpiry_SelfRenewedWaiver_FailsAgainstThePinnedHorizon', () => {
    // A deadline its own owner may move is not a deadline. The blanket "bump
    // every date in one commit" renewal is the cheapest green on the day the
    // debt bites, and it looks exactly like a routine paydown diff.
    const bumped = auditCliDerivationExpiry(SEEDED_ON, reDated('2099-01-01'));
    expect(bumped.ok).toBe(false);
    expect(bumped.beyondHorizon).toEqual(Object.keys(LIVE_POLICY.allowed).sort());
    expect(bumped.findings.every((f) => f.code === 'WAIVER_BEYOND_HORIZON')).toBe(true);
    expect(formatCliExpiryAudit(bumped)).toContain('may not name its own deadline');

    // One day past the horizon is enough — the tooth is not a tolerance band.
    const oneDayOver = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: FIRST_DEAD_DAY },
    });
    expect(oneDayOver.beyondHorizon).toEqual(['doctor']);

    // Bringing a date FORWARD is always legal: it only shortens the debt's life.
    const earlier = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: '2026-12-31' },
    });
    expect(earlier.ok).toBe(true);

    // …and the whole guard reddens on the blanket bump.
    const red = invoke({ today: SEEDED_ON, policy: policyOf(reDated('2099-01-01')) });
    expect(red.code).toBe(1);
    expect(red.err).toContain('WAIVER_BEYOND_HORIZON');
  });

  it('CliRatchetExpiry_EmptyAllowlistOrUnreadableClock_FailsClosed', () => {
    // NON-EMPTY DENOMINATOR. "No expired waiver" over zero waivers is trivially
    // true, and it is what a moved policy file or a renamed field looks like.
    const noEntries = auditCliDerivationExpiry(SEEDED_ON, {});
    expect(noEntries.ok).toBe(false);
    expect(noEntries.entryCount).toBe(0);
    expect(noEntries.findings.map((f) => f.code)).toEqual(['EMPTY_ALLOWLIST']);
    expect(formatCliExpiryAudit(noEntries)).toContain('DELETED in the same commit');

    // Off-by-one control: ONE entry is enough, so the tooth is not a `<= 1`.
    const one = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: LAST_LIVE_DAY },
    });
    expect(one.ok).toBe(true);
    expect(one.entryCount).toBe(1);

    // An unowned waiver has nobody the debt comes due for; an unparseable date
    // cannot be compared. Both fail closed rather than reading as fine.
    const unowned = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: '   ', expires: LAST_LIVE_DAY },
    });
    expect(unowned.malformed).toEqual(['doctor']);
    expect(unowned.findings.map((f) => f.code)).toEqual(['MALFORMED_WAIVER']);

    // An IMPOSSIBLE calendar date matches the ISO pattern and does not exist.
    // A guard that accepts one has an impossible deadline.
    for (const impossible of ['2027-02-31', '2027-13-01', '2027-00-10', 'someday']) {
      const audit = auditCliDerivationExpiry(SEEDED_ON, {
        doctor: { owner: 'orchestration', expires: impossible },
      });
      expect(audit.malformed, `${impossible} is not a real day`).toEqual(['doctor']);
    }

    // An unreadable clock or horizon disables the comparison, so both fail.
    expect(auditCliDerivationExpiry('someday', LIVE_POLICY.allowed).findings.map((f) => f.code)).toContain(
      'UNREADABLE_CLOCK',
    );
    const badHorizon = auditCliDerivationExpiry(SEEDED_ON, LIVE_POLICY.allowed, 'eventually');
    expect(badHorizon.ok).toBe(false);
    expect(badHorizon.findings.map((f) => f.code)).toContain('MALFORMED_HORIZON');
  });

  it('CliRatchetExpiry_TheClockIsReadOnlyAtTheGate', () => {
    // The single production clock read is really wired — but what is asserted is
    // that it AGREES with an independently computed UTC day, never what verdict
    // it produces. An assertion about the verdict would be a date bomb.
    const now = new Date();
    const independent = [
      String(now.getUTCFullYear()).padStart(4, '0'),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
    ].join('-');
    expect(resolveToday(now)).toBe(independent);
    expect(isIsoDay(resolveToday(now))).toBe(true);

    // UTC, not local time: "expired" must not be a property of who ran the gate.
    expect(isoDayUtc(new Date(Date.UTC(2027, 1, 28, 23, 59, 59)))).toBe('2027-02-28');
    expect(isoDayUtc(new Date(Date.UTC(2027, 2, 1, 0, 0, 0)))).toBe('2027-03-01');

    // An invalid Date yields the empty string, which the audit reports as
    // UNREADABLE_CLOCK rather than silently treating as "long ago" — which would
    // make every waiver read as live forever.
    expect(isoDayUtc(new Date(Number.NaN))).toBe('');
    expect(auditCliDerivationExpiry('', LIVE_POLICY.allowed).findings.map((f) => f.code)).toContain(
      'UNREADABLE_CLOCK',
    );
  });
});


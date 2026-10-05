// The allowlist of hand-written CLI verbs is a shrink-only ratchet with an enforced expiry for
// each entry, and the ratchet is an executable gate.
//
// `./cli-derivation-guard.test.ts` covers the parse, the zero-site check, the kill fixture and the
// `$comment` references. This file covers whether the tolerated set can change, and for how long.
//
// Three authorities: the policy data `cli-derivation-allowlist.json`, the frozen pin
// `cli-derivation-seed-pin.ts`, and the live composition root parsed from disk. The pin imports
// nothing, and holds the digest of the seed key set and the one horizon. Each count of the live
// population comes from the parse or the policy file, not from a literal number.
//
// Each verdict uses a named day that the test passes as data, so no assertion fails because time
// passed. The deadline fails the CI gate, which calls `runRatchetGuard()` with its default clock.
// The only assertion about the wall clock is that `resolveToday()` equals an independent UTC day.
//
// @oracle-sources: ./cli-derivation-allowlist.json, ./cli-derivation-seed-pin.ts, ../src/adapters/cli/cli.ts parsed by the TypeScript compiler
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
} from '../../../tools/audit/core/cli-derivation-guard.js';
import {
  LIVE_SUBJECT,
  resolveToday,
  runRatchetGuard,
  type RatchetGuardOptions,
} from '../../../tools/audit/core/cli-derivation-ratchet-guard.js';
import {
  CLI_DERIVATION_EXPIRY_HORIZON,
  CLI_DERIVATION_SEED_KEY_SET_DIGEST,
} from '../../../tools/audit/core/cli-derivation-seed-pin.js';

/** The day the ten waivers were seeded. Every "before the deadline" verdict uses it. */
const SEEDED_ON = '2026-08-07';
/** The horizon itself — the LAST day every seeded waiver is still live. */
const LAST_LIVE_DAY = CLI_DERIVATION_EXPIRY_HORIZON;
/** The first day after the horizon. Every seeded waiver is dead here. */
const FIRST_DEAD_DAY = '2027-03-01';

const LIVE_SCAN = scanGovernedSources();
const LIVE_POLICY = readPolicy();

/**
 * The source text of the governed composition root. The path comes from {@link GOVERNED_SOURCES},
 * so the seeded-literal fixtures use the file that the guard governs.
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
  /**
   * The test derives both sides from the tree and states no count, so a correct paydown moves them
   * together. The live root holds no kill fixture. `KILL_FIXTURE_COMMANDS` must still be non-empty,
   * or the exclusion is vacuous. Each entry must have an owner and a real expiry day. The `retired`
   * map is empty, because no verb is paid down yet. The map must exist, because it is half of the
   * pinned key set.
   */
  it('CliRatchet_SeededAllowlist_CoversEveryLiteralExceptTheKillFixture', () => {
    const literalNames = [...new Set(LIVE_SCAN.literals.map((s) => s.name))].sort();
    const killFixtures = literalNames.filter(isKillFixture);
    const allowlistable = literalNames.filter((n) => !isKillFixture(n));

    expect(literalNames.length).toBeGreaterThan(0);

    expect(killFixtures).toEqual([]);
    expect(KILL_FIXTURE_COMMANDS.length).toBeGreaterThan(0);

    expect(Object.keys(LIVE_POLICY.allowed).sort()).toEqual(allowlistable);
    expect(Object.keys(LIVE_POLICY.allowed).length).toBe(literalNames.length - killFixtures.length);

    for (const [name, entry] of Object.entries(LIVE_POLICY.allowed)) {
      expect(entry.owner.trim().length, `${name} has an owner`).toBeGreaterThan(0);
      expect(isIsoDay(entry.expires), `${name} expires on a real day`).toBe(true);
    }

    expect(Object.keys(LIVE_POLICY.retired)).toEqual([]);
  });

  /**
   * The positive control for each kill probe below: the live artifacts on a named day inside the
   * horizon give no finding. The guard exits 0 and its report states its denominators. The
   * production defaults of the guard must be the live artifacts and not a stub.
   */
  it('CliRatchet_LiveTree_PassesEveryTooth', () => {
    const verdict = auditCliRatchetAsOf(SEEDED_ON, LIVE_SCAN, LIVE_POLICY);
    expect(verdict.findings, verdict.findings.join(', ')).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.membership.ok).toBe(true);
    expect(verdict.seed.ok).toBe(true);
    expect(verdict.expiry.ok).toBe(true);

    const green = invoke({ today: SEEDED_ON });
    expect(green.code).toBe(0);
    expect(green.err).toBe('');
    expect(green.out).toContain('OK as of 2026-08-07');
    expect(green.out).toContain(`${Object.keys(LIVE_POLICY.allowed).length} tracked waiver(s)`);
    expect(green.out).toContain(`${LIVE_SCAN.sites.length} \`.command(\` site(s)`);

    expect(LIVE_SUBJECT.allowlistPath).toBe(ALLOWLIST_PATH);
    expect(LIVE_SUBJECT.horizon).toBe(CLI_DERIVATION_EXPIRY_HORIZON);
    expect(LIVE_SUBJECT.pinnedDigest).toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
  });
});

describe('DR-5: the allowlist may only SHRINK', () => {
  /**
   * The kill probe: one entry more than the live key set must fail the guard. The count is derived,
   * so a paydown does not make the probe a no-op. The guard exits 1. Its report names the seeded
   * entry and says not to regenerate the pin.
   *
   * Two independent checks fail. The key set grew, so the digest does not match the pin. No literal
   * has the seeded name, so the entry is also a stale waiver.
   */
  it('CliRatchet_EleventhEntrySeeded_FailsTheGuard', () => {
    const seededName = 'seeded-eleventh';
    const grown = policyOf({
      ...LIVE_POLICY.allowed,
      [seededName]: { owner: 'cli-surface', expires: LAST_LIVE_DAY },
    });
    expect(Object.keys(grown.allowed).length).toBe(Object.keys(LIVE_POLICY.allowed).length + 1);

    const verdict = auditCliRatchetAsOf(SEEDED_ON, LIVE_SCAN, grown);
    expect(verdict.ok).toBe(false);

    expect(verdict.findings).toContain('SEED_KEY_SET_DRIFT');
    expect(verdict.findings).toContain('STALE_WAIVER');
    expect(verdict.seed.keySetSize).toBe(Object.keys(LIVE_POLICY.allowed).length + 1);
    expect(verdict.seed.digest).not.toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
    expect(verdict.membership.stale).toEqual([seededName]);

    const red = invoke({ today: SEEDED_ON, policy: grown });
    expect(red.code).toBe(1);
    expect(red.out).toBe('');
    expect(red.err).toContain('SEED_KEY_SET_DRIFT');
    expect(red.err).toContain(seededName);
    expect(red.err).toContain('Do NOT regenerate the pin to go green');
  });

  /**
   * An in-place swap drops one name and adds another, so the count stays the same. A count threshold
   * passes it, and so does membership when the new name is a live literal. Only the pinned prior
   * state fails it.
   *
   * A paydown that moves the entry to `retired` keeps the pin valid, so the check passes a legal
   * edit. A paydown that deletes the entry fails. A copy to `retired` keeps the digest, because a
   * set union is idempotent, and fails as `RETIRED_AND_WAIVED`.
   */
  it('CliRatchet_EntrySwappedInPlace_FailsTheShrinkOnlyCheck', () => {
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

    const paidDown: Record<string, CliWaiverEntry> = {};
    for (const [name, entry] of Object.entries(LIVE_POLICY.allowed)) {
      if (name === dropped) continue;
      paidDown[name] = entry;
    }
    const moved = auditCliDerivationSeedIntegrity(Object.keys(paidDown), [dropped]);
    expect(moved.ok).toBe(true);
    expect(moved.digest).toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
    expect(moved.keySetSize).toBe(names.length);

    const deleted = auditCliDerivationSeedIntegrity(Object.keys(paidDown), []);
    expect(deleted.ok).toBe(false);
    expect(deleted.findings.map((f) => f.code)).toEqual(['SEED_KEY_SET_DRIFT']);

    const copied = auditCliDerivationSeedIntegrity(names, [dropped]);
    expect(copied.digest).toBe(CLI_DERIVATION_SEED_KEY_SET_DIGEST);
    expect(copied.ok).toBe(false);
    expect(copied.findings.map((f) => f.code)).toEqual(['RETIRED_AND_WAIVED']);
    expect(copied.overlapping).toEqual([dropped]);
  });

  /**
   * The pinned quantity is a set. A new order or a duplicate name must not move the digest, and a
   * removed name must.
   */
  it('CliRatchet_SeedDigest_IsASetNotAList', () => {
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
  /**
   * A new hand-written verb that the allowlist does not track must fail, which stops growth of the
   * debt. The repair message must say that a new entry is not the repair. A tracked name that is not
   * a live literal must fail too, or a paid-down entry can stay in the list. A move of that entry to
   * `retired` passes membership. An entry in `retired` whose literal is still live fails with two
   * findings, because `retired` records paydowns and suppresses nothing.
   */
  it('CliRatchet_UntrackedLiteral_FailsAndStaleWaiver_FailsToo', () => {
    const seeded = scanSourceForCommandSites(
      `${sourceOfGovernedRoot()}\nconst __seeded = program.command('seeded-verb').description('x');\n`,
      'cli.ts',
    );
    expect(seeded.literals.length).toBe(LIVE_SCAN.literals.length + 1);

    const grownTree = auditCliAllowlistMembership(seeded, LIVE_POLICY);
    expect(grownTree.ok).toBe(false);
    expect(grownTree.untracked).toEqual(['seeded-verb']);
    expect(grownTree.findings.map((f) => f.code)).toEqual(['UNTRACKED_LITERAL']);
    expect(formatCliMembershipAudit(grownTree)).toContain('Adding an entry is NOT the repair');

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

  /**
   * The ratchet must not demand an allowlist entry for a kill fixture, which can never have one. The
   * derivation policy reports that name unconditionally, so membership excludes it from both sides.
   *
   * The live tree holds no kill fixture, and a scan without the subject cannot show that the
   * exclusion works. Thus the test seeds the kill fixture into the real source. Membership must stay
   * green there, because the rejection belongs to the derivation guard.
   */
  it('CliRatchet_KillFixture_IsNotTrackedDebtOnEitherSide', () => {
    const membership = auditCliAllowlistMembership(LIVE_SCAN, LIVE_POLICY);
    expect(membership.ok).toBe(true);
    for (const killFixture of KILL_FIXTURE_COMMANDS) {
      expect(LIVE_SCAN.literals.map((s) => s.name)).not.toContain(killFixture);
      expect(membership.literals).not.toContain(killFixture);
      expect(membership.untracked).not.toContain(killFixture);
      expect(Object.keys(LIVE_POLICY.allowed)).not.toContain(killFixture);
      expect(Object.keys(LIVE_POLICY.retired)).not.toContain(killFixture);
    }

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
      expect(reseeded.literals.map((s) => s.name)).toContain(killFixture);
      expect(reseededMembership.literals).not.toContain(killFixture);
      expect(reseededMembership.untracked).not.toContain(killFixture);
    }
    expect(reseededMembership.ok).toBe(true);
  });
});

describe('DR-5: the expiry is enforced, not advisory', () => {
  /**
   * The live waivers, one day after the horizon, must all fail as expired. The denominator is the
   * live list and must be non-empty. The report names the owner and the legal repair, and the guard
   * exits 1.
   *
   * One planted entry that expired the day before shows that one expired waiver is sufficient. An
   * entry is live on its expiry day. An off-by-one error there adds or removes a day for each waiver.
   */
  it('CliRatchetExpiry_PastExpiryEntry_FailsTheGuard', () => {
    const live = auditCliDerivationExpiry(FIRST_DEAD_DAY, LIVE_POLICY.allowed);
    expect(live.entryCount).toBe(Object.keys(LIVE_POLICY.allowed).length);
    expect(live.entryCount).toBeGreaterThan(0);
    expect(live.ok).toBe(false);
    expect(live.expired).toEqual(Object.keys(LIVE_POLICY.allowed).sort());
    expect(live.findings.every((f) => f.code === 'EXPIRED_WAIVER')).toBe(true);
    expect(formatCliExpiryAudit(live)).toContain('FAILED');
    expect(formatCliExpiryAudit(live)).toContain('MOVE its entry to "retired"');
    expect(formatCliExpiryAudit(live)).toContain('Bumping the date is not the fix');

    const red = invoke({ today: FIRST_DEAD_DAY });
    expect(red.code).toBe(1);
    expect(red.out).toBe('');
    expect(red.err).toContain('EXPIRED_WAIVER');
    expect(red.err).toContain(FIRST_DEAD_DAY);

    const planted = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: '2026-08-06' },
    });
    expect(planted.entryCount).toBe(1);
    expect(planted.ok).toBe(false);
    expect(planted.expired).toEqual(['doctor']);
    expect(formatCliExpiryAudit(planted)).toContain(
      "'doctor' (owner: orchestration) expired on 2026-08-06",
    );

    const onTheDay = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: SEEDED_ON },
    });
    expect(onTheDay.expired).toEqual([]);
    expect(onTheDay.ok).toBe(true);
  });

  /** The positive control: the same live waivers on the last live day pass, and the guard exits 0. */
  it('CliRatchetExpiry_UnexpiredEntry_PassesTheGuard', () => {
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

  /**
   * A deadline that its owner can move is not a deadline. A commit that moves each date later is the
   * cheapest way to a green gate, so it must fail against the pinned horizon. One day past the
   * horizon is sufficient. An earlier date is always legal, because it only shortens the life of
   * the waiver.
   */
  it('CliRatchetExpiry_SelfRenewedWaiver_FailsAgainstThePinnedHorizon', () => {
    const bumped = auditCliDerivationExpiry(SEEDED_ON, reDated('2099-01-01'));
    expect(bumped.ok).toBe(false);
    expect(bumped.beyondHorizon).toEqual(Object.keys(LIVE_POLICY.allowed).sort());
    expect(bumped.findings.every((f) => f.code === 'WAIVER_BEYOND_HORIZON')).toBe(true);
    expect(formatCliExpiryAudit(bumped)).toContain('may not name its own deadline');

    const oneDayOver = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: FIRST_DEAD_DAY },
    });
    expect(oneDayOver.beyondHorizon).toEqual(['doctor']);

    const earlier = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: '2026-12-31' },
    });
    expect(earlier.ok).toBe(true);

    const red = invoke({ today: SEEDED_ON, policy: policyOf(reDated('2099-01-01')) });
    expect(red.code).toBe(1);
    expect(red.err).toContain('WAIVER_BEYOND_HORIZON');
  });

  /**
   * "No expired waiver" is true for zero waivers, so an audit of an empty allowlist proves nothing.
   * Thus an empty allowlist must fail, and one entry must be sufficient. An entry with a blank owner,
   * a date that does not parse, and a calendar date that does not exist are malformed. A clock or a
   * horizon that does not parse must fail, because it disables the comparison.
   */
  it('CliRatchetExpiry_EmptyAllowlistOrUnreadableClock_FailsClosed', () => {
    const noEntries = auditCliDerivationExpiry(SEEDED_ON, {});
    expect(noEntries.ok).toBe(false);
    expect(noEntries.entryCount).toBe(0);
    expect(noEntries.findings.map((f) => f.code)).toEqual(['EMPTY_ALLOWLIST']);
    expect(formatCliExpiryAudit(noEntries)).toContain('DELETED in the same commit');

    const one = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: 'orchestration', expires: LAST_LIVE_DAY },
    });
    expect(one.ok).toBe(true);
    expect(one.entryCount).toBe(1);

    const unowned = auditCliDerivationExpiry(SEEDED_ON, {
      doctor: { owner: '   ', expires: LAST_LIVE_DAY },
    });
    expect(unowned.malformed).toEqual(['doctor']);
    expect(unowned.findings.map((f) => f.code)).toEqual(['MALFORMED_WAIVER']);

    for (const impossible of ['2027-02-31', '2027-13-01', '2027-00-10', 'someday']) {
      const audit = auditCliDerivationExpiry(SEEDED_ON, {
        doctor: { owner: 'orchestration', expires: impossible },
      });
      expect(audit.malformed, `${impossible} is not a real day`).toEqual(['doctor']);
    }

    expect(auditCliDerivationExpiry('someday', LIVE_POLICY.allowed).findings.map((f) => f.code)).toContain(
      'UNREADABLE_CLOCK',
    );
    const badHorizon = auditCliDerivationExpiry(SEEDED_ON, LIVE_POLICY.allowed, 'eventually');
    expect(badHorizon.ok).toBe(false);
    expect(badHorizon.findings.map((f) => f.code)).toContain('MALFORMED_HORIZON');
  });

  /**
   * `resolveToday` must equal a UTC day that the test computes independently. The test asserts no
   * verdict of the live clock, because that verdict changes when the horizon passes. The day is UTC,
   * so "expired" does not depend on the machine that runs the gate. An invalid `Date` gives the empty
   * string. The audit must report it as `UNREADABLE_CLOCK`, because an empty day sorts before each
   * date and then no waiver expires.
   */
  it('CliRatchetExpiry_TheClockIsReadOnlyAtTheGate', () => {
    const now = new Date();
    const independent = [
      String(now.getUTCFullYear()).padStart(4, '0'),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
    ].join('-');
    expect(resolveToday(now)).toBe(independent);
    expect(isIsoDay(resolveToday(now))).toBe(true);

    expect(isoDayUtc(new Date(Date.UTC(2027, 1, 28, 23, 59, 59)))).toBe('2027-02-28');
    expect(isoDayUtc(new Date(Date.UTC(2027, 2, 1, 0, 0, 0)))).toBe('2027-03-01');

    expect(isoDayUtc(new Date(Number.NaN))).toBe('');
    expect(auditCliDerivationExpiry('', LIVE_POLICY.allowed).findings.map((f) => f.code)).toContain(
      'UNREADABLE_CLOCK',
    );
  });
});


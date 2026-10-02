// One waiver ledger, and the two structural properties that make its extraction safe.
//
// Authority A is `./waiver-ledger.ts` as behavior. The tests drive it as a pure function of
// injected data, with no live seed, no registry and no clock. Authority B is the source text of
// the same module, read from disk and split by the TypeScript `preProcessFile`. B makes the claim
// "this module imports nothing" testable. A module can behave correctly while its bytes say
// something else, so the two authorities stay separate.
//
// Every verdict here uses a named day that the test passes as data. Nothing reads the wall clock,
// so no assertion starts to fail because time passed.
//
// @oracle-sources: ./waiver-ledger.ts, this module's source text read from disk and decomposed by the TypeScript compiler's preProcessFile
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  auditWaiverLedger,
  canonicalKeySet,
  isIsoDay,
  isoDayUtc,
  measureKeySetPin,
  type WaiverLedgerEntry,
  type WaiverLedgerSubject,
} from './waiver-ledger.js';
import { keySetDigest } from './waiver-ledger-digest.js';
import {
  cliDerivationSeedDigest,
  isIsoDay as cliIsIsoDay,
  isoDayUtc as cliIsoDayUtc,
} from '../../audit/core/cli-derivation-guard.js';
import { REPO_ROOT } from './subject-root.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_SRC = path.join(HERE, 'waiver-ledger.ts');

/** A subject with recognisable nouns, so a message can be traced back to its source. */
const SUBJECT: WaiverLedgerSubject = {
  authority: 'DR-TEST',
  ledger: 'fixture ledger',
  entry: 'fixture waiver',
  entries: 'fixture waivers',
  horizonSource: 'FIXTURE_HORIZON in nowhere.ts',
  paydown: 'Pay it down.',
  horizonPaydown: 'Pay it down',
  zeroState: 'Zero means the module is deleted.',
};

const HORIZON = '2027-02-28';

function ledgerOver(
  entries: Readonly<Record<string, WaiverLedgerEntry>>,
): Readonly<Record<string, WaiverLedgerEntry>> {
  return entries;
}

describe('DR-6 waiver ledger: the four teeth', () => {
  /**
   * Non-empty denominator. "Nothing expired" over no entries is trivially true, and a moved module
   * or a broken import looks like that. One entry clears the finding. The check is about
   * emptiness, not size, so a smaller ledger cannot make it quiet.
   */
  it('WaiverLedger_ZeroEntries_FailsRatherThanReportingClean', () => {
    const empty = auditWaiverLedger('2026-08-09', {}, HORIZON, SUBJECT);
    expect(empty.entryCount).toBe(0);
    expect(empty.ok).toBe(false);
    expect(empty.findings.map((f) => f.code)).toEqual(['EMPTY_LEDGER']);
    expect(empty.findings[0]?.message).toContain('fixture ledger');
    expect(empty.findings[0]?.message).toContain('Zero means the module is deleted.');

    const one = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: 'someone', expires: HORIZON } }),
      HORIZON,
      SUBJECT,
    );
    expect(one.entryCount).toBe(1);
    expect(one.ok).toBe(true);
  });

  /** The expiry day itself is still valid. The finding names the owner of the debt and the legal repair. */
  it('WaiverLedger_ExpiryBoundary_IsInclusiveOfTheExpiryDay', () => {
    const entries = ledgerOver({ 'a.b': { owner: 'someone', expires: '2026-08-09' } });

    const onTheDay = auditWaiverLedger('2026-08-09', entries, HORIZON, SUBJECT);
    expect(onTheDay.expired).toEqual([]);
    expect(onTheDay.ok).toBe(true);

    const dayAfter = auditWaiverLedger('2026-08-10', entries, HORIZON, SUBJECT);
    expect(dayAfter.expired).toEqual(['a.b']);
    expect(dayAfter.ok).toBe(false);
    expect(dayAfter.findings.map((f) => f.code)).toEqual(['EXPIRED']);
    expect(dayAfter.findings[0]?.message).toContain("(owner: someone)");
    expect(dayAfter.findings[0]?.message).toContain('DR-TEST: the expiry is ENFORCED');
    expect(dayAfter.findings[0]?.message).toContain('Pay it down.');
  });

  /**
   * The renewal check. Enforcement of `expires` alone is not enough: on the day it fails, the
   * cheapest fix is a sed that adds a year to every date. One day over the horizon fails too. A
   * move of a date to an earlier day is always legal, because it only makes the debt shorter. The
   * check thus forbids renewals, not all edits.
   */
  it('WaiverLedger_EntryPastTheHorizon_FailsBeforeItsOwnExpiryIsConsulted', () => {
    const selfRenewed = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: 'someone', expires: '2099-01-01' } }),
      HORIZON,
      SUBJECT,
    );
    expect(selfRenewed.beyondHorizon).toEqual(['a.b']);
    expect(selfRenewed.expired).toEqual([]);
    expect(selfRenewed.ok).toBe(false);
    expect(selfRenewed.findings[0]?.message).toContain('may not name its own deadline');
    expect(selfRenewed.findings[0]?.message).toContain('FIXTURE_HORIZON in nowhere.ts');

    const oneDayOver = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: 'someone', expires: '2027-03-01' } }),
      HORIZON,
      SUBJECT,
    );
    expect(oneDayOver.beyondHorizon).toEqual(['a.b']);

    const earlier = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: 'someone', expires: '2026-09-01' } }),
      HORIZON,
      SUBJECT,
    );
    expect(earlier.ok).toBe(true);
    expect(earlier.beyondHorizon).toEqual([]);
  });

  /**
   * `2027-02-31` matches `/^\d{4}-\d{2}-\d{2}$/` but does not exist. A pattern check accepts it,
   * `<` compares it, and the entry outlives every real February date.
   */
  it('WaiverLedger_BlankOwnerOrImpossibleDate_FailsClosed', () => {
    const unowned = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: '   ', expires: HORIZON } }),
      HORIZON,
      SUBJECT,
    );
    expect(unowned.malformed).toEqual(['a.b']);
    expect(unowned.ok).toBe(false);

    for (const bad of ['2027-02-31', '2027-13-01', '2027-2-8', 'next wave', '']) {
      const audit = auditWaiverLedger(
        '2026-08-09',
        ledgerOver({ 'a.b': { owner: 'someone', expires: bad } }),
        HORIZON,
        SUBJECT,
      );
      expect(audit.malformed, bad).toEqual(['a.b']);
      expect(audit.ok, bad).toBe(false);
    }
  });

  /**
   * An unreadable clock must not expire the whole ledger, which is what "treat it as long ago"
   * does. An unreadable horizon disables the renewal check, so it fails closed. The expiry check
   * does not depend on the horizon, so it still fires.
   */
  it('WaiverLedger_UnreadableClockOrHorizon_ProducesOneHonestFindingNotACascade', () => {
    const entries = ledgerOver({ 'a.b': { owner: 'someone', expires: '2020-01-01' } });

    const noClock = auditWaiverLedger('someday', entries, HORIZON, SUBJECT);
    expect(noClock.findings.map((f) => f.code)).toEqual(['UNREADABLE_CLOCK']);
    expect(noClock.expired).toEqual([]);

    const noHorizon = auditWaiverLedger('2026-08-09', entries, 'eventually', SUBJECT);
    expect(noHorizon.findings.map((f) => f.code)).toEqual(['MALFORMED_HORIZON', 'EXPIRED']);
    expect(noHorizon.beyondHorizon).toEqual([]);
    expect(noHorizon.ok).toBe(false);
  });

  /**
   * When a day is not well formed, the result is the documented fallback, 0. It does not change a
   * verdict, because the malformed-date checks already fired.
   */
  it('WaiverLedger_DaysToHorizon_IsDerivedNotWrittenDown', () => {
    const entries = ledgerOver({ 'a.b': { owner: 'someone', expires: HORIZON } });
    expect(auditWaiverLedger('2026-08-07', entries, HORIZON, SUBJECT).daysToHorizon).toBe(205);
    expect(auditWaiverLedger(HORIZON, entries, HORIZON, SUBJECT).daysToHorizon).toBe(0);
    expect(auditWaiverLedger('2027-03-01', entries, HORIZON, SUBJECT).daysToHorizon).toBe(-1);
    expect(auditWaiverLedger('someday', entries, HORIZON, SUBJECT).daysToHorizon).toBe(0);
  });

  it('WaiverLedger_AnnotatePort_CarriesTheConsumersOwnPerEntryContext', () => {
    const audit = auditWaiverLedger(
      '2027-03-01',
      ledgerOver({ 'a.b': { owner: 'someone', expires: '2027-02-28' } }),
      HORIZON,
      { ...SUBJECT, annotate: (id) => `, blockedBy: #${id.length}` },
    );
    expect(audit.findings[0]?.message).toContain('(owner: someone, blockedBy: #3)');
  });
});

describe('DR-6 waiver ledger: the day rule', () => {
  /** An impossible day fails, and a real leap day such as `2028-02-29` passes. */
  it('WaiverLedger_ImpossibleCalendarDay_IsRejectedNotMerelyUnmatched', () => {
    expect(isIsoDay('2027-02-31')).toBe(false);
    expect(isIsoDay('2027-13-01')).toBe(false);
    expect(isIsoDay('2027-2-8')).toBe(false);
    expect(isIsoDay('next wave')).toBe(false);
    expect(isIsoDay('')).toBe(false);
    expect(isIsoDay('2028-02-29')).toBe(true);
    expect(isIsoDay('2027-02-28')).toBe(true);
  });

  /** An invalid `Date` gives '', which a consumer reports as an unreadable clock, not as a date long ago. */
  it('WaiverLedger_IsoDayUtc_IsUtcAndFailsVisiblyOnAnInvalidDate', () => {
    expect(isoDayUtc(new Date(Date.UTC(2027, 1, 28, 23, 59, 59)))).toBe('2027-02-28');
    expect(isoDayUtc(new Date(Date.UTC(2027, 2, 1, 0, 0, 0)))).toBe('2027-03-01');
    expect(isoDayUtc(new Date(Number.NaN))).toBe('');
    expect(isIsoDay(isoDayUtc(new Date(Number.NaN)))).toBe(false);
  });
});

describe('DR-6 waiver ledger: the key set', () => {
  /** The pinned quantity is a set. A new order or a duplicate id does not move the digest. Only membership does. */
  it('WaiverLedger_CanonicalKeySet_IsSetValuedNotOrderOrDuplicateSensitive', () => {
    expect(canonicalKeySet(['b', 'a'])).toBe(canonicalKeySet(['a', 'b']));
    expect(canonicalKeySet(['a', 'a', 'b'])).toBe(canonicalKeySet(['a', 'b']));
    expect(canonicalKeySet(['a', 'b'])).not.toBe(canonicalKeySet(['a', 'c']));
    expect(canonicalKeySet(['a', 'b'])).toBe('a\nb');
    expect(keySetDigest(['b', 'a'], 'sha256')).toBe(keySetDigest(['a', 'b'], 'sha256'));
    expect(keySetDigest(['a'], 'sha256')).not.toBe(keySetDigest(['a'], 'sha512'));
  });

  /**
   * The one legal edit moves a key from live to retired. The union does not change, so the pin must
   * not move. Otherwise every paydown regenerates it, and it carries no information. A swap with
   * the same size must drift the pin. A copy instead of a move does not change the digest, so the
   * measure reports it as an overlap.
   */
  it('WaiverLedger_InPlaceSwap_DriftsThePinWhileALegalMoveDoesNot', () => {
    const digestOf = (ids: readonly string[]): string => keySetDigest(ids, 'sha256');
    const pinned = digestOf(['a', 'b', 'c']);

    const moved = measureKeySetPin(['a', 'b'], ['c'], pinned, digestOf);
    expect(moved.drifted).toBe(false);
    expect(moved.keySetSize).toBe(3);
    expect(moved.overlapping).toEqual([]);

    const swapped = measureKeySetPin(['a', 'b', 'd'], [], pinned, digestOf);
    expect(swapped.drifted).toBe(true);
    expect(swapped.keySetSize).toBe(3);

    const copied = measureKeySetPin(['a', 'b', 'c'], ['c'], pinned, digestOf);
    expect(copied.drifted).toBe(false);
    expect(copied.overlapping).toEqual(['c']);
  });
});

/** Every module specifier `source` references, via the compiler's own extractor. */
function referencedSpecifiers(source: string): readonly string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map((ref) => ref.fileName);
}

/** Resolve a relative `./x.js` specifier to the `.ts` file on disk, or `undefined`. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    base,
    path.join(base, 'index.ts'),
  ]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return undefined;
}

interface ImportWalk {
  /** Every first-party `.ts` file reachable from the entry, including the entry. */
  readonly files: readonly string[];
  /** Every bare specifier reached — packages and `node:`/`bun:` builtins. */
  readonly bare: readonly string[];
  /** Relative specifiers that resolved to nothing on disk. A walk with these is not a proof. */
  readonly unresolved: readonly string[];
}

/** Walk the static import graph from `entry`, following first-party files only. */
function walkImports(entry: string): ImportWalk {
  const files = new Set<string>();
  const bare = new Set<string>();
  const unresolved = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || files.has(current)) continue;
    files.add(current);

    for (const specifier of referencedSpecifiers(readFileSync(current, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        bare.add(specifier);
        continue;
      }
      const resolved = resolveRelative(current, specifier);
      if (resolved === undefined) unresolved.add(`${current} -> ${specifier}`);
      else queue.push(resolved);
    }
  }

  return {
    files: [...files].sort(),
    bare: [...bare].sort(),
    unresolved: [...unresolved].sort(),
  };
}

/**
 * The structural half. The tests above drive the ledger as data. These tests measure the file and
 * the import graph that it reaches: the module imports nothing, and the guard never reaches
 * `bun:sqlite`.
 */
describe('DR-6 waiver ledger: the properties the extraction rests on', () => {
  /**
   * The ledger is a separate module with no imports, because the existing census reaches
   * `TOOL_REGISTRY` at load. The test reads the module from disk to prove that it has no imports,
   * `import type` included. The same reader must find the imports of this test file, so the
   * reader is not vacuous.
   */
  it('WaiverLedger_ImportsNothing_MeasuredNotAsserted', () => {
    const specifiers = referencedSpecifiers(readFileSync(LEDGER_SRC, 'utf8'));
    expect(specifiers).toEqual([]);

    const self = referencedSpecifiers(readFileSync(path.join(HERE, 'waiver-ledger.test.ts'), 'utf8'));
    expect(self.length).toBeGreaterThan(3);
    expect(self).toContain('./waiver-ledger.js');
  });

  /**
   * The ratchet guard runs under plain node in the grep-gates lane, so it must not reach
   * `bun:sqlite`. The walk must contain the ledger and `cli-derivation-guard.ts`, and no storage
   * module. The positive control: the same walker finds `bun:sqlite` in the SQLite backend.
   */
  it('CliDerivationRatchetGuard_ReachesNoBunSqlite_ThroughTheSharedLedgerOrOtherwise', () => {
    const guard = walkImports(path.join(REPO_ROOT, 'tools/audit/core/cli-derivation-ratchet-guard.ts'));

    expect(guard.unresolved).toEqual([]);
    expect(guard.bare).not.toContain('bun:sqlite');
    expect(guard.files).toContain(path.join(REPO_ROOT, 'tools/conformance/src/waiver-ledger.ts'));
    expect(guard.files).toContain(path.join(REPO_ROOT, 'tools/audit/core/cli-derivation-guard.ts'));
    expect(guard.files.filter((f) => f.includes(`${path.sep}storage${path.sep}`))).toEqual([]);

    const cliRoot = path.join(REPO_ROOT, 'src/storage/sqlite-backend.ts');
    expect(existsSync(cliRoot)).toBe(true);
    const control = walkImports(cliRoot);
    expect(control.bare).toContain('bun:sqlite');
  });

  /**
   * The day-rule names of `cli-derivation-guard.ts` are the ledger names, by identity. The guard
   * binds its own algorithm constant, so the digest check compares outputs instead. Distinct sets
   * must give distinct digests, so a constant digest cannot satisfy the loop.
   */
  it('CliDerivationGuard_TakesTheDayRuleAndDigestFromTheLedger_NotItsOwnWords', () => {
    expect(cliIsIsoDay).toBe(isIsoDay);
    expect(cliIsoDayUtc).toBe(isoDayUtc);

    for (const ids of [['a', 'b'], ['b', 'a'], ['a', 'a', 'b'], [] as string[]]) {
      expect(cliDerivationSeedDigest(ids)).toBe(keySetDigest(ids, 'sha256'));
    }

    expect(cliDerivationSeedDigest(['a'])).not.toBe(cliDerivationSeedDigest(['b']));
  });
});

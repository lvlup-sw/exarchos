// DR-6: one waiver ledger, and the two structural properties that make the
// extraction safe rather than merely tidy.
//
// ── TWO AUTHORITIES ─────────────────────────────────────────────────────────
// Authority A is `./waiver-ledger.ts` as BEHAVIOUR — driven as a pure function of
// injected data: no live seed, no registry, no clock. Authority B is this same
// module's SOURCE TEXT read off disk and decomposed by the TypeScript compiler's
// own `preProcessFile`, which is what makes "this module imports nothing"
// falsifiable rather than a comment: a module can behave correctly while its
// bytes say something else, so the two cannot be collapsed.
//
// B was originally `../../scripts/cli-derivation-guard.ts`, which then held the
// one surviving independent statement of this day rule. That copy is gone — the
// guard now imports these names — so naming it here would declare one authority
// wearing two names. DR-30's reachability rule caught exactly that when the
// delegation landed, which is the rule doing its job rather than a nuisance.
//
// ── THE CLOCK ───────────────────────────────────────────────────────────────
// Every verdict below is taken at a NAMED day passed in as data. Nothing here
// reads the wall clock, so no assertion can start failing because time passed.
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
} from '../../scripts/cli-derivation-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_SRC = path.join(HERE, 'waiver-ledger.ts');
const MCP_ROOT = path.resolve(HERE, '..', '..');

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

// ─── The verdict ─────────────────────────────────────────────────────────────

describe('DR-6 waiver ledger: the four teeth', () => {
  it('WaiverLedger_ZeroEntries_FailsRatherThanReportingClean', () => {
    // NON-EMPTY DENOMINATOR. "Nothing has expired" over no entries is trivially
    // true, and it is what a moved module or a broken import looks like — the
    // instrument reading green exactly when it has stopped working.
    const empty = auditWaiverLedger('2026-08-09', {}, HORIZON, SUBJECT);
    expect(empty.entryCount).toBe(0);
    expect(empty.ok).toBe(false);
    expect(empty.findings.map((f) => f.code)).toEqual(['EMPTY_LEDGER']);
    expect(empty.findings[0]?.message).toContain('fixture ledger');
    expect(empty.findings[0]?.message).toContain('Zero means the module is deleted.');

    // ONE entry clears it — the tooth bites on emptiness, not on smallness, so
    // it cannot be satisfied by shrinking the ledger until it is quiet.
    const one = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: 'someone', expires: HORIZON } }),
      HORIZON,
      SUBJECT,
    );
    expect(one.entryCount).toBe(1);
    expect(one.ok).toBe(true);
  });

  it('WaiverLedger_ExpiryBoundary_IsInclusiveOfTheExpiryDay', () => {
    const entries = ledgerOver({ 'a.b': { owner: 'someone', expires: '2026-08-09' } });

    const onTheDay = auditWaiverLedger('2026-08-09', entries, HORIZON, SUBJECT);
    expect(onTheDay.expired).toEqual([]);
    expect(onTheDay.ok).toBe(true);

    const dayAfter = auditWaiverLedger('2026-08-10', entries, HORIZON, SUBJECT);
    expect(dayAfter.expired).toEqual(['a.b']);
    expect(dayAfter.ok).toBe(false);
    expect(dayAfter.findings.map((f) => f.code)).toEqual(['EXPIRED']);
    // The finding names the owner the debt comes due for and the legal repair.
    expect(dayAfter.findings[0]?.message).toContain("(owner: someone)");
    expect(dayAfter.findings[0]?.message).toContain('DR-TEST: the expiry is ENFORCED');
    expect(dayAfter.findings[0]?.message).toContain('Pay it down.');
  });

  it('WaiverLedger_EntryPastTheHorizon_FailsBeforeItsOwnExpiryIsConsulted', () => {
    // THE RENEWAL TOOTH. Enforcing `expires` alone is theatre: on the day it
    // bites, the cheapest green is a sed adding a year to every date, and that
    // diff looks like the paydowns the file already receives.
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

    // One day over fails just as hard — not a "most of them moved" heuristic.
    const oneDayOver = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: 'someone', expires: '2027-03-01' } }),
      HORIZON,
      SUBJECT,
    );
    expect(oneDayOver.beyondHorizon).toEqual(['a.b']);

    // Pulling a date FORWARD is always legal: it only shortens the debt's life.
    // Without this the tooth would be "no edits", not "no renewals".
    const earlier = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: 'someone', expires: '2026-09-01' } }),
      HORIZON,
      SUBJECT,
    );
    expect(earlier.ok).toBe(true);
    expect(earlier.beyondHorizon).toEqual([]);
  });

  it('WaiverLedger_BlankOwnerOrImpossibleDate_FailsClosed', () => {
    const unowned = auditWaiverLedger(
      '2026-08-09',
      ledgerOver({ 'a.b': { owner: '   ', expires: HORIZON } }),
      HORIZON,
      SUBJECT,
    );
    expect(unowned.malformed).toEqual(['a.b']);
    expect(unowned.ok).toBe(false);

    // `2027-02-31` MATCHES /^\d{4}-\d{2}-\d{2}$/ and does not exist. A pattern
    // check accepts it, `<` compares it happily, and the entry outlives every
    // real date in February forever.
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

  it('WaiverLedger_UnreadableClockOrHorizon_ProducesOneHonestFindingNotACascade', () => {
    const entries = ledgerOver({ 'a.b': { owner: 'someone', expires: '2020-01-01' } });

    // An unreadable clock must NOT silently expire the whole ledger — which is
    // what "treat it as long ago" would do, turning a broken instrument into a
    // confident verdict.
    const noClock = auditWaiverLedger('someday', entries, HORIZON, SUBJECT);
    expect(noClock.findings.map((f) => f.code)).toEqual(['UNREADABLE_CLOCK']);
    expect(noClock.expired).toEqual([]);

    // An unreadable horizon disables the renewal tooth, so it fails closed —
    // and the expiry tooth, which does not depend on it, still bites.
    const noHorizon = auditWaiverLedger('2026-08-09', entries, 'eventually', SUBJECT);
    expect(noHorizon.findings.map((f) => f.code)).toEqual(['MALFORMED_HORIZON', 'EXPIRED']);
    expect(noHorizon.beyondHorizon).toEqual([]);
    expect(noHorizon.ok).toBe(false);
  });

  it('WaiverLedger_DaysToHorizon_IsDerivedNotWrittenDown', () => {
    const entries = ledgerOver({ 'a.b': { owner: 'someone', expires: HORIZON } });
    expect(auditWaiverLedger('2026-08-07', entries, HORIZON, SUBJECT).daysToHorizon).toBe(205);
    expect(auditWaiverLedger(HORIZON, entries, HORIZON, SUBJECT).daysToHorizon).toBe(0);
    expect(auditWaiverLedger('2027-03-01', entries, HORIZON, SUBJECT).daysToHorizon).toBe(-1);
    // Neither side well-formed is not "0 days away" by accident: it is the
    // documented fallback, and it never contributes to a verdict because the
    // malformed-date teeth have already fired.
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
  it('WaiverLedger_ImpossibleCalendarDay_IsRejectedNotMerelyUnmatched', () => {
    expect(isIsoDay('2027-02-31')).toBe(false);
    expect(isIsoDay('2027-13-01')).toBe(false);
    expect(isIsoDay('2027-2-8')).toBe(false);
    expect(isIsoDay('next wave')).toBe(false);
    expect(isIsoDay('')).toBe(false);
    expect(isIsoDay('2028-02-29')).toBe(true); // a real leap day
    expect(isIsoDay('2027-02-28')).toBe(true);
  });

  it('WaiverLedger_IsoDayUtc_IsUtcAndFailsVisiblyOnAnInvalidDate', () => {
    expect(isoDayUtc(new Date(Date.UTC(2027, 1, 28, 23, 59, 59)))).toBe('2027-02-28');
    expect(isoDayUtc(new Date(Date.UTC(2027, 2, 1, 0, 0, 0)))).toBe('2027-03-01');
    // An invalid `Date` yields '' — which every consumer reports as an
    // unreadable clock, rather than a date that silently compares as "long ago".
    expect(isoDayUtc(new Date(Number.NaN))).toBe('');
    expect(isIsoDay(isoDayUtc(new Date(Number.NaN)))).toBe(false);
  });
});

describe('DR-6 waiver ledger: the key set', () => {
  it('WaiverLedger_CanonicalKeySet_IsSetValuedNotOrderOrDuplicateSensitive', () => {
    // The pinned quantity is a SET, so re-sorting a literal or writing an id
    // twice must not move the digest. Only membership does.
    expect(canonicalKeySet(['b', 'a'])).toBe(canonicalKeySet(['a', 'b']));
    expect(canonicalKeySet(['a', 'a', 'b'])).toBe(canonicalKeySet(['a', 'b']));
    expect(canonicalKeySet(['a', 'b'])).not.toBe(canonicalKeySet(['a', 'c']));
    expect(canonicalKeySet(['a', 'b'])).toBe('a\nb');
    expect(keySetDigest(['b', 'a'], 'sha256')).toBe(keySetDigest(['a', 'b'], 'sha256'));
    expect(keySetDigest(['a'], 'sha256')).not.toBe(keySetDigest(['a'], 'sha512'));
  });

  it('WaiverLedger_InPlaceSwap_DriftsThePinWhileALegalMoveDoesNot', () => {
    const digestOf = (ids: readonly string[]): string => keySetDigest(ids, 'sha256');
    const pinned = digestOf(['a', 'b', 'c']);

    // The one legal edit: MOVE a key from live to retired. The union does not
    // change, so the pin must not move — otherwise it would be regenerated on
    // every paydown and carry no information at all.
    const moved = measureKeySetPin(['a', 'b'], ['c'], pinned, digestOf);
    expect(moved.drifted).toBe(false);
    expect(moved.keySetSize).toBe(3);
    expect(moved.overlapping).toEqual([]);

    // The swap no comparison against today can see: drop one, add another, same
    // cardinality.
    const swapped = measureKeySetPin(['a', 'b', 'd'], [], pinned, digestOf);
    expect(swapped.drifted).toBe(true);
    expect(swapped.keySetSize).toBe(3);

    // A paydown recorded as a COPY rather than a move: harmless to the digest
    // (a union absorbs it) and therefore worth catching separately.
    const copied = measureKeySetPin(['a', 'b', 'c'], ['c'], pinned, digestOf);
    expect(copied.drifted).toBe(false);
    expect(copied.overlapping).toEqual(['c']);
  });
});

// ─── The structural half ─────────────────────────────────────────────────────
//
// Everything above drives the ledger as data. The claims below are about the
// FILE and the import graph reachable from it, because "this module imports
// nothing" and "this guard never reaches `bun:sqlite`" are the two properties
// the whole extraction rests on — and a property nothing measures is a comment.

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

describe('DR-6 waiver ledger: the properties the extraction rests on', () => {
  it('WaiverLedger_ImportsNothing_MeasuredNotAsserted', () => {
    // D4 chose a dependency-free module over the existing census because the
    // census reaches `TOOL_REGISTRY` at load. That choice is only worth anything
    // if the module really has no imports, so it is read off disk rather than
    // trusted — including `import type`, which `preProcessFile` reports too and
    // which would still couple this module's compilation to another file.
    const specifiers = referencedSpecifiers(readFileSync(LEDGER_SRC, 'utf8'));
    expect(specifiers).toEqual([]);

    // Non-empty denominator on the instrument itself: a `preProcessFile` that
    // silently returned nothing for every input would make the line above
    // vacuous. The same reader finds this test file's own imports.
    const self = referencedSpecifiers(readFileSync(path.join(HERE, 'waiver-ledger.test.ts'), 'utf8'));
    expect(self.length).toBeGreaterThan(3);
    expect(self).toContain('./waiver-ledger.js');
  });

  it('CliDerivationRatchetGuard_ReachesNoBunSqlite_ThroughTheSharedLedgerOrOtherwise', () => {
    // D4's load-bearing property, stated as a graph fact. `cli-derivation-guard`
    // runs under plain node on the unfiltered grep-gates lane; resolving
    // `bun:sqlite` would make it un-runnable there, and task 023 declined to
    // extract the ledger precisely to avoid acquiring that edge. The extraction
    // happened, so the edge is now asserted rather than avoided by not moving.
    const guard = walkImports(path.join(MCP_ROOT, 'scripts', 'cli-derivation-ratchet-guard.ts'));

    expect(guard.unresolved).toEqual([]);
    expect(guard.bare).not.toContain('bun:sqlite');
    // The ledger really is on the walked path — otherwise the assertion above
    // would be about a graph that never included the module in question.
    expect(guard.files).toContain(path.join(MCP_ROOT, 'src', 'architecture', 'waiver-ledger.ts'));
    expect(guard.files).toContain(path.join(MCP_ROOT, 'scripts', 'cli-derivation-guard.ts'));
    // …and nothing it reaches drags the registry or the storage layer in.
    expect(guard.files.filter((f) => f.includes(`${path.sep}storage${path.sep}`))).toEqual([]);

    // POSITIVE CONTROL. A walker that never reports `bun:sqlite` proves nothing
    // about the guard. The CLI composition root does reach it — that is exactly
    // why `cli-vocab-guard` must run under bun — so the same walker must find it
    // there, or the assertion above is vacuous.
    const cliRoot = path.join(MCP_ROOT, 'src', 'adapters', 'cli.ts');
    expect(existsSync(cliRoot)).toBe(true);
    const control = walkImports(cliRoot);
    expect(control.bare).toContain('bun:sqlite');
  });

  it('CliDerivationGuard_TakesTheDayRuleAndDigestFromTheLedger_NotItsOwnWords', () => {
    // 077 could not reach `cli-derivation-guard.ts` (a concurrent task owned it)
    // and pinned its surviving copy against this ledger instead. The copy is now
    // gone, so that comparison would assert a function equals itself. What is
    // worth stating is the fact that replaced it: the guard's names ARE these
    // names, read off the module rather than argued from the import line.
    expect(cliIsIsoDay).toBe(isIsoDay);
    expect(cliIsoDayUtc).toBe(isoDayUtc);

    // The digest is delegated rather than restated. Identity cannot be used here
    // (the guard binds its own algorithm constant), so the shared primitive is
    // shown to produce the guard's answer over an order/duplicate-sensitive set.
    for (const ids of [['a', 'b'], ['b', 'a'], ['a', 'a', 'b'], [] as string[]]) {
      expect(cliDerivationSeedDigest(ids)).toBe(keySetDigest(ids, 'sha256'));
    }

    // Non-empty denominator on the instrument: a digest that returned a constant
    // would satisfy the loop above, so distinct sets must produce distinct hex.
    expect(cliDerivationSeedDigest(['a'])).not.toBe(cliDerivationSeedDigest(['b']));
  });
});

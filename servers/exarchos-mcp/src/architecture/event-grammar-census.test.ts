// @oracle-sources: ../event-store/schemas.ts, ./event-grammar-concessions.ts
//
// DR-3 / task 015 — the event-name grammar census and its two-way ratchet.
//
// THIS FILE IS THE GUARD. `event-grammar-census.ts` is a pure library with no `process.exit`, so
// its verdict is stated by this suite, which `ci.yml` runs as a named step on the UNFILTERED
// `grep-gates` deps tail. Hosting the assertions here satisfies DR-24's "each guard's self-test
// runs in the same CI job as the guard" for free: a guard-execution failure exits non-zero rather
// than passing as success.
//
// Two authorities are compared throughout and neither lives in this file: the live event REGISTRY
// (`getValidEventTypes()`, which nothing here can author) and the RULE it is measured against (the
// DR-3 grammar, in both its classifier and its regex form). Every number below is read back from the
// census; none is written down. Four assertions in this wave broke because a guard's self-test
// hard-coded the number it measures and a CORRECT change elsewhere falsified it, so the live cases
// assert relationships between derived quantities instead of cardinalities.
import { describe, it, expect, afterEach } from 'vitest';
import {
  EVENT_NAME_PATTERN,
  EventTypes,
  getValidEventTypes,
  registerEventType,
  unregisterEventType,
} from '../event-store/schemas.js';
import { classifyEventName, WORD_SEPARATORS } from '../event-store/event-name.js';
import {
  auditEventGrammarRatchet,
  censusEventNameGrammar,
  concessionClauses,
  formatEventGrammarRatchet,
  isIsoDay,
  isoDayUtc,
  EVENT_GRAMMAR_CONCESSIONS,
  type EventGrammarCensusReport,
  type GrammarConcessionEntry,
} from './event-grammar-census.js';

/** A day every seeded expiry is comfortably later than, so a fixture varies exactly one field. */
const BEFORE_ANY_EXPIRY = '2026-01-01';

/** The live census, taken once. Every live-tree case reads its numbers back from this. */
const live = censusEventNameGrammar();

/** Names the live corpus registers that do NOT exercise a given concession clause. Derived. */
function liveNamesWithout(clause: string): readonly string[] {
  return live.records.filter((r) => !r.concessions.includes(clause)).map((r) => r.name);
}

/** The live concession table with one entry replaced — every other field untouched. */
function concessionsWith(
  clause: string,
  overrides: Partial<GrammarConcessionEntry>,
): Readonly<Record<string, GrammarConcessionEntry>> {
  const base = EVENT_GRAMMAR_CONCESSIONS[clause];
  if (base === undefined) throw new Error(`fixture error: '${clause}' is not a seeded concession`);
  return { ...EVENT_GRAMMAR_CONCESSIONS, [clause]: { ...base, ...overrides } };
}

function codesOf(report: { readonly findings: readonly { readonly code: string }[] }): string[] {
  return [...new Set(report.findings.map((f) => f.code))].sort();
}

// Custom registrations mutate module-level registry state, so every case that makes one is
// responsible for removing it. Without this the kill fixtures would leak a malformed name into the
// live-tree cases and the suite's verdict would depend on file order.
const registered: string[] = [];
function registerForThisTest(name: string): void {
  registerEventType(name, { source: 'auto' });
  registered.push(name);
}
afterEach(() => {
  while (registered.length > 0) {
    const name = registered.pop();
    if (name !== undefined) unregisterEventType(name);
  }
});

describe('EventGrammarCensus_LiveRegistry_IsWellFormed', () => {
  it('enumerates a non-empty subject', () => {
    // The non-empty-denominator rule, stated first because every assertion below is vacuous
    // without it. `EMPTY_CENSUS` is the mechanism; this is the claim that it is not firing today
    // for the wrong reason.
    expect(live.total).toBeGreaterThan(0);
    expect(live.diagnostics).toEqual([]);
    expect(live.ok).toBe(true);
  });

  it('enumerates the RUNTIME registry, not the compile-time union', () => {
    // The whole reason this census exists in architecture/ rather than as another proof alias in
    // event-name.ts. `EventTypes` is already quantified over by
    // `_EventName_EveryRegisteredType_IsWellFormed`; censusing it here would be a slower
    // restatement of a proof that already holds. The denominator must be the value-level registry.
    //
    // A custom type is registered FIRST, deliberately. With none registered the two populations
    // are equal and this case passes against a census that reads `EventTypes` — a kill probe
    // caught exactly that, so the fixture makes the two denominators differ before comparing them.
    registerForThisTest('probe.registry-denominator');
    expect(getValidEventTypes().length).toBeGreaterThan(EventTypes.length);

    const report = censusEventNameGrammar();
    expect(report.total).toBe(getValidEventTypes().length);
    expect(report.records.filter((r) => r.origin === 'built-in').length).toBe(EventTypes.length);
    expect(report.records.filter((r) => r.origin === 'custom').map((r) => r.name)).toEqual([
      'probe.registry-denominator',
    ]);
  });

  it('accepts every registered name', () => {
    // The forward tooth, reporting clean. Asserted as the empty LIST rather than a count so a
    // failure names the offender.
    expect([...live.malformed]).toEqual([]);
  });

  it('the ratchet passes on the live tree, in both directions', () => {
    const verdict = auditEventGrammarRatchet(isoDayUtc(new Date()), live);
    // The whole verdict, so a failure prints which tooth bit. This is also where the deadline on
    // EVENT_GRAMMAR_CONCESSIONS reddens CI: it is a real date, and it will bite on schedule.
    expect(formatEventGrammarRatchet(verdict, live)).toContain('PASS');
    expect(verdict.findings).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.malformed).toEqual([]);
    expect(verdict.unseeded).toEqual([]);
    expect(verdict.stale).toEqual([]);
    expect(verdict.expired).toEqual([]);
  });
});

describe('EventGrammarCensus_ConcessionTable_IsExactlyTheLiveConcessions', () => {
  it('records every clause the grammar derives, and no others', () => {
    // The rung-3 twin of `_EventGrammarCensus_ConcessionKeys_MatchTheGrammar`. Both are kept: the
    // proof alias is checked by `tsc` over the literal, this is checked over the DERIVATION, and a
    // change to `concessionClauses` that stopped agreeing with the table would slip past the first.
    expect([...concessionClauses()]).toEqual(Object.keys(EVENT_GRAMMAR_CONCESSIONS).sort());
    expect(concessionClauses().length).toBe(WORD_SEPARATORS.length);
  });

  it('every recorded concession is exercised by at least one live name', () => {
    // The stale tooth's denominator, asserted non-empty per entry. A concession table whose
    // entries no live name exercises would pass `EMPTY_ALLOWLIST` while being entirely cover.
    for (const clause of Object.keys(EVENT_GRAMMAR_CONCESSIONS)) {
      expect(live.concessionUsage.get(clause)?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('every recorded concession carries an owner and a real deadline', () => {
    for (const [clause, entry] of Object.entries(EVENT_GRAMMAR_CONCESSIONS)) {
      expect(entry.owner.trim().length, clause).toBeGreaterThan(0);
      expect(isIsoDay(entry.expires), clause).toBe(true);
    }
  });
});

// The regex `event-store/schemas.ts` authored by hand until task 075 collapsed the two authorities.
// Kept here as an injectable SUBJECT so the divergence teeth still have something to bite: the
// census's `shippedPattern` seam exists precisely so a composition the live tree can no longer
// produce can still be posed. Nothing in the production tree reads this literal.
const RETIRED_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

describe('EventGrammarCensus_TheTwoForms_NoLongerDiverge', () => {
  it('reports zero live divergence over a non-empty subject', () => {
    // Task 014's FINDING, discharged (DR-5). `EVENT_NAME_PATTERN` is now BUILT from the grammar's
    // own alphabet and separator set, so the two forms cannot disagree without someone re-authoring
    // one of them. The denominator is asserted first: "no divergence" over zero names is the
    // instrument dying green, which is the failure `EMPTY_CENSUS` exists to catch.
    expect(live.total).toBeGreaterThan(0);
    expect([...live.divergent]).toEqual([]);
    // Not a vacuous zero — the concession the divergence used to live on is still exercised, in
    // quantity. The population is there; the disagreement about it is gone.
    expect(live.concessionUsage.get('word-separator:_')?.length ?? 0).toBeGreaterThan(0);
  });

  it('the retired pattern still diverges, so the zero above is a repair and not a broken measure', () => {
    // The anti-vacuity twin. A census that had lost its ability to SEE a divergence would also
    // report zero, so the same instrument is pointed at the pattern that shipped until task 075 and
    // must report the old finding exactly: the snake_case concession, name for name.
    const underRetired = censusEventNameGrammar(getValidEventTypes(), RETIRED_PATTERN);
    expect([...underRetired.divergent].sort()).toEqual(
      [...(live.concessionUsage.get('word-separator:_') ?? [])].sort(),
    );
    // And it ran one way: the grammar accepted, the retired validator refused.
    for (const name of underRetired.divergent) {
      const record = underRetired.records.find((r) => r.name === name);
      expect(record?.wellFormed, name).toBe(true);
      expect(record?.shippedPatternAccepts, name).toBe(false);
    }
  });

  it('measures the validators, NOT the text — a substring scan disagrees in both directions', () => {
    // The tempting proxy for the historical divergence is "does the name contain an underscore",
    // and it is wrong in BOTH directions. Posed against the retired pattern, because that is the
    // composition the claim was ever true of.
    //
    //   `workflow.plan-review_dispatched` CONTAINS `_`, so the text proxy calls it divergent — but
    //   BOTH authorities reject it (mixed separators / underscore), so they AGREE.
    //   `workflow.started2` contains NO `_`, so the text proxy calls it fine — but the grammar
    //   rejects the digit while the retired pattern admitted it, so they DISAGREE.
    const subjects = ['workflow.plan-review_dispatched', 'workflow.started2'];
    const textProxy = subjects.filter((name) => name.includes('_'));
    const measured = censusEventNameGrammar(subjects, RETIRED_PATTERN).divergent;

    expect(textProxy).toEqual(['workflow.plan-review_dispatched']);
    expect([...measured]).toEqual(['workflow.started2']);
    // Stated as a set relation too, so the point survives a future edit to either name.
    expect(new Set(textProxy)).not.toEqual(new Set(measured));
    // Under the LIVE pattern both names are judged the same way by both forms — that is the
    // collapse, over the same two subjects the proxy was wrong about.
    expect([...censusEventNameGrammar(subjects).divergent]).toEqual([]);
  });
});

describe('EventGrammarCensus_EmptyDenominator_Fails', () => {
  it('an emptied census reports EMPTY_CENSUS rather than a clean run', () => {
    const empty = censusEventNameGrammar([]);
    expect(empty.total).toBe(0);
    expect(empty.ok).toBe(false);
    expect(empty.diagnostics.map((d) => d.code)).toEqual(['EMPTY_CENSUS']);
    // "every name is well-formed" is TRUE over no names — which is exactly why the tooth exists.
    expect([...empty.malformed]).toEqual([]);
  });

  it('the ratchet fails on an emptied census instead of inheriting its silence', () => {
    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, censusEventNameGrammar([]));
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain('EMPTY_CENSUS');
  });

  it('an emptied concession table reports EMPTY_ALLOWLIST', () => {
    // The same rule applied to the stale tooth's own denominator: with no recorded concessions,
    // "no stale concession" is trivially true and the second direction is decoration.
    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, live, {});
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain('EMPTY_ALLOWLIST');
  });

  it('an untrustworthy census is not read as a passing ratchet', () => {
    const broken: EventGrammarCensusReport = {
      ...live,
      ok: false,
      diagnostics: [{ code: 'EMPTY_CENSUS', message: 'seeded' }],
    };
    expect(codesOf(auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, broken))).toContain(
      'UNTRUSTWORTHY_CENSUS',
    );
  });
});

describe('EventGrammarCensus_ForwardTooth_RejectsARealMalformedRegistration', () => {
  it('the registration seam now REFUSES the name this tooth used to be proven against', () => {
    // Until task 075 this suite proved the forward tooth by really registering `my-app.started2` —
    // the shipped `EVENT_NAME_PATTERN` admitted a multi-word namespace and a digit while the DR-3
    // grammar admitted neither, so the production path could genuinely produce a malformed name.
    // It cannot any more, and that is the point of the collapse rather than a loss of coverage.
    // Both halves are executed so the change is a measurement: the retired regex really did admit
    // this name, and the live seam really does throw.
    const malformed = 'my-app.started2';
    expect(RETIRED_PATTERN.test(malformed)).toBe(true);
    expect(EVENT_NAME_PATTERN.test(malformed)).toBe(false);
    expect(classifyEventName(malformed).ok).toBe(false);

    expect(() => registerEventType(malformed, { source: 'auto' })).toThrow(
      /NAMESPACE_NOT_SINGLE_WORD/,
    );
    expect(getValidEventTypes()).not.toContain(malformed);
  });

  it('finds a malformed name that reached the registry without passing the seam', () => {
    // The tooth's remaining live subject, and it is not hypothetical: the 171 BUILT-INS are a
    // readonly literal array that `registerEventType` never sees, so a badly-named built-in reaches
    // this census without ever meeting `assertWellFormedEventName`. (`tsc` also catches that, via
    // `_EventName_EveryRegisteredType_IsWellFormed` — the two rungs are deliberate.) Posed through
    // the injected name list rather than by registering, because the seam now refuses to register
    // it, which is exactly the change the previous case measures.
    const malformed = 'my-app.started2';
    const report = censusEventNameGrammar([...getValidEventTypes(), malformed]);
    expect([...report.malformed]).toEqual([malformed]);
    expect(report.records.find((r) => r.name === malformed)?.origin).toBe('custom');

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, report);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['MALFORMED_EVENT_NAME']);

    const finding = verdict.findings.find((f) => f.code === 'MALFORMED_EVENT_NAME');
    // Not just "rejected" — rejected for the clause the grammar's classifier names, passed through
    // rather than re-encoded. A census that returned one blanket code would satisfy `ok === false`
    // while giving a reader nothing to act on.
    expect(finding).toMatchObject({ name: malformed, defect: 'NAMESPACE_NOT_SINGLE_WORD' });
    expect(formatEventGrammarRatchet(verdict, report)).toContain('FAIL');
  });

  it('restores the live verdict once the malformed registration is gone', () => {
    // Proves the previous case's RED came from the seeded subject and not from ambient state — and
    // that the cleanup actually cleans up, so file order cannot decide this suite.
    expect([...censusEventNameGrammar().malformed]).toEqual([]);
  });

  it('reports the offending segment when the classifier can localise it', () => {
    const report = censusEventNameGrammar(['workflow.plan-review_dispatched']);
    expect(report.records[0]).toMatchObject({
      wellFormed: false,
      defect: 'MIXED_WORD_SEPARATORS',
      segment: 'plan-review_dispatched',
    });
  });
});

describe('EventGrammarCensus_StaleTooth_RejectsCoverWithNoLiveSubject', () => {
  it('a recorded concession no live name exercises is STALE_SEED_ENTRY', () => {
    // The brief's second direction, verbatim. The corpus is narrowed to the names that do NOT use
    // `-` — DERIVED from the live census, not hand-listed — so the `word-separator:-` entry keeps
    // covering a class nothing uses. A grammar wider than its corpus declines to reject a class
    // nobody noticed it was admitting.
    //
    // The KEBAB clause, not the snake one, and that choice is load-bearing. `word-separator:_`
    // also carries `divergesFromShippedPattern: true`, so emptying ITS population trips the
    // divergence branch as well and the case would pass with the no-live-subject branch deleted —
    // a kill probe caught exactly that. `word-separator:-` records no divergence, so this branch
    // is the only one that can produce the finding.
    const withoutKebab = liveNamesWithout('word-separator:-');
    expect(withoutKebab.length).toBeGreaterThan(0);
    expect(withoutKebab.length).toBeLessThan(live.total);

    const report = censusEventNameGrammar(withoutKebab);
    expect(report.concessionUsage.get('word-separator:-')).toEqual([]);
    expect(report.concessionUsage.get('word-separator:_')?.length ?? 0).toBeGreaterThan(0);

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, report);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['STALE_SEED_ENTRY']);
    expect([...verdict.stale]).toEqual(['word-separator:-']);
    expect(
      verdict.findings.find((f) => f.code === 'STALE_SEED_ENTRY' && 'clause' in f)?.message,
    ).toContain('NO live event name exercises');
  });

  it('an entry for a clause the grammar no longer derives is STALE_SEED_ENTRY', () => {
    // The grammar drops `_` from WORD_SEPARATORS; the recorded concession for it is now cover for
    // a rule that does not exist. Posed through the injected separator set rather than by editing
    // task 014's tuple, so the fixture cannot corrupt the live grammar.
    const narrowed = censusEventNameGrammar(getValidEventTypes(), EVENT_NAME_PATTERN, ['-']);
    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, narrowed);
    expect(verdict.clauses).toEqual(['word-separator:-']);
    expect([...verdict.stale]).toEqual(['word-separator:_']);
    expect(codesOf(verdict)).toContain('STALE_SEED_ENTRY');
    // The MESSAGE, not just the code. All three stale sub-cases share `STALE_SEED_ENTRY` (they are
    // one failure class and coining three codes would be the multiple-authority defect), so the
    // code alone cannot say which one fired — and a kill probe showed this case passing through
    // the no-live-subject branch with the clause-gone branch deleted.
    expect(
      verdict.findings.find((f) => f.code === 'STALE_SEED_ENTRY' && 'clause' in f)?.message,
    ).toContain('no longer makes');
  });

  it('a divergence record the repair no longer justifies is STALE_SEED_ENTRY', () => {
    // THE tooth task 015 built for task 075, fired against the real repaired tree. `word-separator:_`
    // recorded `divergesFromShippedPattern: true` as the standing record of task 014's finding;
    // task 075 collapsed the two authorities, and leaving that flag standing would be cover for a
    // finding that no longer exists. This case poses exactly that — the live census, the live table
    // with the one field reverted — and it must go RED. Retiring the flag (which the shipped table
    // now does) is what makes the ratchet green again; silencing the tooth is not an option that
    // exists, because deleting this case is what the growth tooth's twin below would then catch.
    const verdict = auditEventGrammarRatchet(
      BEFORE_ANY_EXPIRY,
      live,
      concessionsWith('word-separator:_', { divergesFromShippedPattern: true }),
    );
    expect([...live.divergent]).toEqual([]);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['STALE_SEED_ENTRY']);
    expect([...verdict.stale]).toEqual(['word-separator:_']);
    expect(
      verdict.findings.find((f) => f.code === 'STALE_SEED_ENTRY' && 'clause' in f)?.message,
    ).toContain('divergence');
  });
});

describe('EventGrammarCensus_GrowthTooth_RejectsUnrecordedWidening', () => {
  it('an exercised concession with no entry is UNSEEDED_GRAMMAR_CONCESSION', () => {
    // The grammar concedes a clause, live names use it, and nobody wrote down who retires it or
    // when. Posed by removing the entry rather than by widening the grammar, so the fixture uses
    // the same table shape production does.
    const withoutSnakeEntry = { ...EVENT_GRAMMAR_CONCESSIONS };
    delete withoutSnakeEntry['word-separator:_'];

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, live, withoutSnakeEntry);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['UNSEEDED_GRAMMAR_CONCESSION']);
    expect([...verdict.unseeded]).toEqual(['word-separator:_']);
  });

  it('an entry understating its clause`s divergence is UNSEEDED_GRAMMAR_CONCESSION', () => {
    // The two authorities drifted further apart than the record admits. This is the half that makes
    // the shipped `divergesFromShippedPattern: false` a CLAIM rather than a convenience: the census
    // is pointed at the pattern that shipped until task 075 — under which the divergence is real and
    // 25 names wide — while the LIVE table (already retired to `false`) is handed in unmodified. The
    // ratchet fires. So the flag could not have been flipped before the repair landed, and it goes
    // red again the day anyone re-authors the pattern by hand.
    const underRetired = censusEventNameGrammar(getValidEventTypes(), RETIRED_PATTERN);
    expect(underRetired.divergent.length).toBeGreaterThan(0);

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, underRetired);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['UNSEEDED_GRAMMAR_CONCESSION']);
    expect([...verdict.unseeded]).toEqual(['word-separator:_']);
    expect(EVENT_GRAMMAR_CONCESSIONS['word-separator:_']?.divergesFromShippedPattern).toBe(false);
  });
});

describe('EventGrammarCensus_Expiry_IsEnforcedNotDecorative', () => {
  it('a lapsed entry is EXPIRED_SEED_ENTRY', () => {
    const entry = EVENT_GRAMMAR_CONCESSIONS['word-separator:_'];
    expect(entry).toBeDefined();
    // The day AFTER the seeded expiry, derived from the entry itself so this case cannot rot when
    // the date moves.
    const dayAfter = isoDayUtc(new Date(Date.parse(`${entry?.expires ?? ''}T00:00:00Z`) + 86_400_000));
    const verdict = auditEventGrammarRatchet(dayAfter, live);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['EXPIRED_SEED_ENTRY']);
    expect([...verdict.expired]).toContain('word-separator:_');
  });

  it('an entry is live THROUGH its expiry day and dead the next', () => {
    const entry = EVENT_GRAMMAR_CONCESSIONS['word-separator:_'];
    const onTheDay = auditEventGrammarRatchet(entry?.expires ?? '', live);
    expect(onTheDay.expired).toEqual([]);
  });

  it('an unowned or undated entry is MALFORMED_SEED_ENTRY', () => {
    const unowned = auditEventGrammarRatchet(
      BEFORE_ANY_EXPIRY,
      live,
      concessionsWith('word-separator:-', { owner: '   ' }),
    );
    expect(codesOf(unowned)).toContain('MALFORMED_SEED_ENTRY');

    // `2027-02-31` matches YYYY-MM-DD and is not a day. A guard that accepts an impossible
    // deadline has an impossible deadline.
    const impossible = auditEventGrammarRatchet(
      BEFORE_ANY_EXPIRY,
      live,
      concessionsWith('word-separator:-', { expires: '2027-02-31' }),
    );
    expect(codesOf(impossible)).toContain('MALFORMED_SEED_ENTRY');
    expect(isIsoDay('2027-02-31')).toBe(false);
    expect(isIsoDay('2027-02-28')).toBe(true);
  });

  it('an unreadable clock fails closed rather than reading every entry as live', () => {
    const verdict = auditEventGrammarRatchet('not-a-day', live);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain('UNREADABLE_CLOCK');
    expect(isoDayUtc(new Date(Number.NaN))).toBe('');
  });
});

describe('EventGrammarCensus_ConcessionUsage_IsSegmentScoped', () => {
  it('a separator in the NAMESPACE is a defect, not an exercise of the concession', () => {
    // Counting a namespace separator as usage would let a malformed name keep a concession alive —
    // the stale tooth would report the clause as justified by the very name the forward tooth is
    // rejecting.
    const report = censusEventNameGrammar(['my-app.started']);
    expect(report.records[0]).toMatchObject({
      wellFormed: false,
      defect: 'NAMESPACE_NOT_SINGLE_WORD',
      concessions: [],
    });
    expect(report.concessionUsage.get('word-separator:-')).toEqual([]);
  });

  it('a separator in a tail segment is an exercise of the concession', () => {
    const report = censusEventNameGrammar(['workflow.plan-review-dispatched']);
    expect(report.records[0]).toMatchObject({
      wellFormed: true,
      concessions: ['word-separator:-'],
    });
  });
});

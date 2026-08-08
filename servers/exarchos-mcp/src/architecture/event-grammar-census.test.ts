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
// DR-3 grammar, plus the shipped `EVENT_NAME_PATTERN`). Every number below is read back from the
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

describe('EventGrammarCensus_ShippedPatternDivergence_IsMeasuredNotAsserted', () => {
  it('reports a live divergence between the two authorities', () => {
    // Task 014's FINDING, on the runtime path. Reported as a MEASUREMENT (the census stays `ok`),
    // because the divergence is real and permanent until someone repairs it — treating it as an
    // instrument fault would leave the census untrustworthy forever and the ratchet unreadable.
    expect(live.divergent.length).toBeGreaterThan(0);
  });

  it('the divergence is exactly the snake_case concession, derived two independent ways', () => {
    // No cardinality is written here. The two sides are computed by DIFFERENT means — one by
    // asking the shipped regex object, one by asking which concession clause each name exercises —
    // so agreement is evidence rather than a restatement.
    expect([...live.divergent].sort()).toEqual(
      [...(live.concessionUsage.get('word-separator:_') ?? [])].sort(),
    );
    // And the divergence runs one way today: the grammar accepts, the shipped validator refuses.
    for (const name of live.divergent) {
      const record = live.records.find((r) => r.name === name);
      expect(record?.wellFormed, name).toBe(true);
      expect(record?.shippedPatternAccepts, name).toBe(false);
    }
  });

  it('measures the validators, NOT the text — a substring scan disagrees in both directions', () => {
    // The tempting proxy for this divergence is "does the name contain an underscore", and it is
    // wrong in BOTH directions. Both numbers are asserted, per the wave's rule for any measurement
    // that could have been done by text-matching.
    //
    //   `workflow.plan-review_dispatched` CONTAINS `_`, so the text proxy calls it divergent — but
    //   BOTH authorities reject it (mixed separators / underscore), so they AGREE.
    //   `workflow.started2` contains NO `_`, so the text proxy calls it fine — but the grammar
    //   rejects the digit while the shipped pattern admits it, so they DISAGREE.
    const subjects = ['workflow.plan-review_dispatched', 'workflow.started2'];
    const textProxy = subjects.filter((name) => name.includes('_'));
    const measured = censusEventNameGrammar(subjects).divergent;

    expect(textProxy).toEqual(['workflow.plan-review_dispatched']);
    expect([...measured]).toEqual(['workflow.started2']);
    // Stated as a set relation too, so the point survives a future edit to either name.
    expect(new Set(textProxy)).not.toEqual(new Set(measured));
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
  it('finds a malformed name that `registerEventType` accepted for real', () => {
    // THE kill fixture, and it is not a stub: `registerEventType` really admits this name today,
    // because the shipped `EVENT_NAME_PATTERN` allows a multi-word namespace and a digit while the
    // DR-3 grammar allows neither. So the census's forward tooth is proven against a subject the
    // production registration path can genuinely produce — which is the whole reason a RUNTIME
    // enumeration exists rather than another compile-time proof over `EventType`.
    const malformed = 'my-app.started2';
    expect(EVENT_NAME_PATTERN.test(malformed)).toBe(true);
    expect(classifyEventName(malformed).ok).toBe(false);

    registerForThisTest(malformed);

    const report = censusEventNameGrammar();
    expect([...report.malformed]).toEqual([malformed]);
    expect(report.records.find((r) => r.name === malformed)?.origin).toBe('custom');

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, report);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['MALFORMED_EVENT_NAME']);

    const finding = verdict.findings.find((f) => f.code === 'MALFORMED_EVENT_NAME');
    // Not just "rejected" — rejected for the clause task 014's classifier names, passed through
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

  it('a divergence record that the repaired pattern no longer justifies is STALE_SEED_ENTRY', () => {
    // The one edit that legitimately retires task 014's finding: `EVENT_NAME_PATTERN` gains `_` in
    // both character classes, so the two authorities agree again. The record must then GO — a
    // standing note about a repaired defect is exactly the stale cover this tooth exists to find,
    // and it would otherwise outlive the defect indefinitely.
    const repaired = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/;
    const report = censusEventNameGrammar(getValidEventTypes(), repaired);
    expect([...report.divergent]).toEqual([]);

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, report);
    expect(verdict.ok).toBe(false);
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
    // The two authorities drifted further apart than the record admits. Without this half, the
    // `divergesFromShippedPattern` flag could be set to `false` to silence the finding while the
    // divergence continued — a record that documents a defect must be falsifiable in the direction
    // that makes it look better, not only in the direction that makes it look worse.
    const verdict = auditEventGrammarRatchet(
      BEFORE_ANY_EXPIRY,
      live,
      concessionsWith('word-separator:_', { divergesFromShippedPattern: false }),
    );
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['UNSEEDED_GRAMMAR_CONCESSION']);
    expect([...verdict.unseeded]).toEqual(['word-separator:_']);
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

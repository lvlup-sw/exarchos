/**
 * The event-name grammar census and its two-way ratchet.
 *
 * This suite is the guard. `event-grammar-census.ts` is a library with no `process.exit`, so this
 * suite states its verdict. CI runs it in the unfiltered conformance-suite step.
 *
 * The suite compares two authorities, and neither lives in this file: the live event registry and
 * the grammar, in its classifier and its regex form. Each number comes from the census. The live
 * cases assert relations between derived quantities, not counts. So a correct change elsewhere
 * does not break them.
 *
 * @oracle-sources: ../../../src/events/schemas.ts, ./event-grammar-concessions.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  EVENT_NAME_PATTERN,
  EventTypes,
  getValidEventTypes,
  registerEventType,
  unregisterEventType,
} from '../../../src/events/schemas.js';
import { classifyEventName, WORD_SEPARATORS } from '../../../src/events/event-name.js';
import { censusLiveEventNameGrammar } from './bindings/events.js';
import {
  auditEventGrammarRatchet,
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
const live = censusLiveEventNameGrammar();

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

/**
 * Custom registrations change module-level registry state, so each case that makes one removes
 * it. Otherwise a kill fixture leaks a malformed name into the live-tree cases, and the verdict
 * depends on file order.
 */
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
  /** The non-empty denominator comes first, because each later assertion is vacuous without it. */
  it('enumerates a non-empty subject', () => {
    expect(live.total).toBeGreaterThan(0);
    expect(live.diagnostics).toEqual([]);
    expect(live.ok).toBe(true);
  });

  /**
   * The denominator is the runtime registry, not the compile-time union that
   * `_EventName_EveryRegisteredType_IsWellFormed` already covers. A custom type is registered
   * first. With none, the two populations are equal, and a census that reads `EventTypes` passes.
   */
  it('enumerates the RUNTIME registry, not the compile-time union', () => {
    registerForThisTest('probe.registry-denominator');
    expect(getValidEventTypes().length).toBeGreaterThan(EventTypes.length);

    const report = censusLiveEventNameGrammar();
    expect(report.total).toBe(getValidEventTypes().length);
    expect(report.records.filter((r) => r.origin === 'built-in').length).toBe(EventTypes.length);
    expect(report.records.filter((r) => r.origin === 'custom').map((r) => r.name)).toEqual([
      'probe.registry-denominator',
    ]);
  });

  /** The forward tooth. It asserts the empty list, not a count, so a failure names the offender. */
  it('accepts every registered name', () => {
    expect([...live.malformed]).toEqual([]);
  });

  /**
   * It asserts the whole verdict, so a failure shows which tooth fired. The concession deadline
   * is a real date, so this case fails CI when that date passes.
   */
  it('the ratchet passes on the live tree, in both directions', () => {
    const verdict = auditEventGrammarRatchet(isoDayUtc(new Date()), live);
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
  /**
   * The runtime twin of `_EventGrammarCensus_ConcessionKeys_MatchTheGrammar`. `tsc` checks that
   * proof over the literal, and this case checks the derivation. A change to `concessionClauses`
   * that disagrees with the table passes the first check and fails here.
   */
  it('records every clause the grammar derives, and no others', () => {
    expect([...concessionClauses(WORD_SEPARATORS)]).toEqual(Object.keys(EVENT_GRAMMAR_CONCESSIONS).sort());
    expect(concessionClauses(WORD_SEPARATORS).length).toBe(WORD_SEPARATORS.length);
  });

  /**
   * The denominator of the stale tooth, per entry. A table that no live name exercises passes
   * `EMPTY_ALLOWLIST` and is only cover.
   */
  it('every recorded concession is exercised by at least one live name', () => {
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

/**
 * The retired hand-written event-name regex. The census takes a `shippedPattern` argument, so the
 * divergence teeth can still run against it. No production code reads it.
 */
const RETIRED_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

describe('EventGrammarCensus_TheTwoForms_NoLongerDiverge', () => {
  /**
   * `EVENT_NAME_PATTERN` is built from the alphabet and the separators of the grammar, so the two
   * forms agree. The denominator comes first, because zero divergence over zero names proves
   * nothing. The snake concession is still exercised, so the zero is not vacuous.
   */
  it('reports zero live divergence over a non-empty subject', () => {
    expect(live.total).toBeGreaterThan(0);
    expect([...live.divergent]).toEqual([]);
    expect(live.concessionUsage.get('word-separator:_')?.length ?? 0).toBeGreaterThan(0);
  });

  /**
   * The anti-vacuity twin. A census that cannot see a divergence also reports zero. So the same
   * census runs on the retired pattern and must report the snake concession, name for name. Each
   * divergence goes one way: the grammar accepts, and the retired pattern refuses.
   */
  it('the retired pattern still diverges, so the zero above is a repair and not a broken measure', () => {
    const underRetired = censusLiveEventNameGrammar(getValidEventTypes(), RETIRED_PATTERN);
    expect([...underRetired.divergent].sort()).toEqual(
      [...(live.concessionUsage.get('word-separator:_') ?? [])].sort(),
    );
    for (const name of underRetired.divergent) {
      const record = underRetired.records.find((r) => r.name === name);
      expect(record?.wellFormed, name).toBe(true);
      expect(record?.shippedPatternAccepts, name).toBe(false);
    }
  });

  /**
   * Against the retired pattern, a substring scan for `_` is wrong in both directions.
   * `workflow.plan-review_dispatched` contains `_`, but both forms reject it. `workflow.started2`
   * contains no `_`, but the grammar rejects the digit and the retired pattern admits it. Under the
   * live pattern, both forms agree on both names.
   */
  it('measures the validators, NOT the text — a substring scan disagrees in both directions', () => {
    const subjects = ['workflow.plan-review_dispatched', 'workflow.started2'];
    const textProxy = subjects.filter((name) => name.includes('_'));
    const measured = censusLiveEventNameGrammar(subjects, RETIRED_PATTERN).divergent

    expect(textProxy).toEqual(['workflow.plan-review_dispatched']);
    expect([...measured]).toEqual(['workflow.started2']);
    expect(new Set(textProxy)).not.toEqual(new Set(measured));
    expect([...censusLiveEventNameGrammar(subjects).divergent]).toEqual([]);
  });
});

describe('EventGrammarCensus_EmptyDenominator_Fails', () => {
  /** "Every name is well-formed" is true over no names, so an empty subject must fail. */
  it('an emptied census reports EMPTY_CENSUS rather than a clean run', () => {
    const empty = censusLiveEventNameGrammar([]);
    expect(empty.total).toBe(0);
    expect(empty.ok).toBe(false);
    expect(empty.diagnostics.map((d) => d.code)).toEqual(['EMPTY_CENSUS']);
    expect([...empty.malformed]).toEqual([]);
  });

  it('the ratchet fails on an emptied census instead of inheriting its silence', () => {
    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, censusLiveEventNameGrammar([]));
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain('EMPTY_CENSUS');
  });

  /**
   * The same rule for the denominator of the stale tooth. With no recorded concessions, "no stale
   * concession" is trivially true.
   */
  it('an emptied concession table reports EMPTY_ALLOWLIST', () => {
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
  /**
   * The retired regex admitted `my-app.started2`. The live pattern, the classifier and
   * `registerEventType` reject it. The case runs both halves, so the change is a measurement.
   */
  it('the registration seam now REFUSES the name this tooth used to be proven against', () => {
    const malformed = 'my-app.started2';
    expect(RETIRED_PATTERN.test(malformed)).toBe(true);
    expect(EVENT_NAME_PATTERN.test(malformed)).toBe(false);
    expect(classifyEventName(malformed).ok).toBe(false);

    expect(() => registerEventType(malformed, { source: 'auto' })).toThrow(
      /NAMESPACE_NOT_SINGLE_WORD/,
    );
    expect(getValidEventTypes()).not.toContain(malformed);
  });

  /**
   * The built-in event types are a literal array that `registerEventType` never sees, so a badly
   * named built-in reaches this census without the seam. `tsc` also catches it through
   * `_EventName_EveryRegisteredType_IsWellFormed`. The name goes in through the injected list,
   * because the seam refuses to register it. The finding carries the clause that the classifier
   * names, not a blanket code.
   */
  it('finds a malformed name that reached the registry without passing the seam', () => {
    const malformed = 'my-app.started2';
    const report = censusLiveEventNameGrammar([...getValidEventTypes(), malformed]);
    expect([...report.malformed]).toEqual([malformed]);
    expect(report.records.find((r) => r.name === malformed)?.origin).toBe('custom');

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, report);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['MALFORMED_EVENT_NAME']);

    const finding = verdict.findings.find((f) => f.code === 'MALFORMED_EVENT_NAME');
    expect(finding).toMatchObject({ name: malformed, defect: 'NAMESPACE_NOT_SINGLE_WORD' });
    expect(formatEventGrammarRatchet(verdict, report)).toContain('FAIL');
  });

  /**
   * The failure in the previous case comes from the seeded subject, not from ambient state. So file
   * order cannot decide this suite.
   */
  it('restores the live verdict once the malformed registration is gone', () => {
    expect([...censusLiveEventNameGrammar().malformed]).toEqual([]);
  });

  it('reports the offending segment when the classifier can localise it', () => {
    const report = censusLiveEventNameGrammar(['workflow.plan-review_dispatched']);
    expect(report.records[0]).toMatchObject({
      wellFormed: false,
      defect: 'MIXED_WORD_SEPARATORS',
      segment: 'plan-review_dispatched',
    });
  });
});

describe('EventGrammarCensus_StaleTooth_RejectsCoverWithNoLiveSubject', () => {
  /**
   * The corpus narrows to the live names that do not use `-`, derived from the census. The
   * `word-separator:-` entry then covers a class that no name uses.
   */
  it('a recorded concession no live name exercises is STALE_SEED_ENTRY', () => {
    const withoutKebab = liveNamesWithout('word-separator:-');
    expect(withoutKebab.length).toBeGreaterThan(0);
    expect(withoutKebab.length).toBeLessThan(live.total);

    const report = censusLiveEventNameGrammar(withoutKebab);
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

  /**
   * The injected separator set drops `_`, so the `_` entry covers a rule that does not exist. The
   * live grammar stays unchanged. The three stale cases share `STALE_SEED_ENTRY`, so the case
   * asserts the message to prove which branch fired.
   */
  it('an entry for a clause the grammar no longer derives is STALE_SEED_ENTRY', () => {
    const narrowed = censusLiveEventNameGrammar(getValidEventTypes(), EVENT_NAME_PATTERN, ['-']);
    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, narrowed);
    expect(verdict.clauses).toEqual(['word-separator:-']);
    expect([...verdict.stale]).toEqual(['word-separator:_']);
    expect(codesOf(verdict)).toContain('STALE_SEED_ENTRY');
    expect(
      verdict.findings.find((f) => f.code === 'STALE_SEED_ENTRY' && 'clause' in f)?.message,
    ).toContain('no longer makes');
  });

  /**
   * The live census, with the snake entry set back to `divergesFromShippedPattern: true`. The two
   * forms agree, so that record covers a divergence that does not exist, and the ratchet must fail.
   */
  it('a divergence record the repair no longer justifies is STALE_SEED_ENTRY', () => {
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
  /**
   * Live names use a conceded clause that has no entry. The case removes the entry and keeps the
   * grammar, so the fixture has the production table shape.
   */
  it('an exercised concession with no entry is UNSEEDED_GRAMMAR_CONCESSION', () => {
    const withoutSnakeEntry = { ...EVENT_GRAMMAR_CONCESSIONS };
    delete withoutSnakeEntry['word-separator:_'];

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, live, withoutSnakeEntry);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['UNSEEDED_GRAMMAR_CONCESSION']);
    expect([...verdict.unseeded]).toEqual(['word-separator:_']);
  });

  /**
   * The census runs on the retired pattern, under which the snake divergence is real. The live
   * table, with `false`, goes in unchanged, and the ratchet fails. So `false` is a claim: it fails
   * again if someone writes the pattern by hand.
   */
  it('an entry understating its clause`s divergence is UNSEEDED_GRAMMAR_CONCESSION', () => {
    const underRetired = censusLiveEventNameGrammar(getValidEventTypes(), RETIRED_PATTERN);
    expect(underRetired.divergent.length).toBeGreaterThan(0);

    const verdict = auditEventGrammarRatchet(BEFORE_ANY_EXPIRY, underRetired);
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toEqual(['UNSEEDED_GRAMMAR_CONCESSION']);
    expect([...verdict.unseeded]).toEqual(['word-separator:_']);
    expect(EVENT_GRAMMAR_CONCESSIONS['word-separator:_']?.divergesFromShippedPattern).toBe(false);
  });
});

describe('EventGrammarCensus_Expiry_IsEnforcedNotDecorative', () => {
  /** The day after the expiry comes from the entry, so the case stays correct when the date moves. */
  it('a lapsed entry is EXPIRED_SEED_ENTRY', () => {
    const entry = EVENT_GRAMMAR_CONCESSIONS['word-separator:_'];
    expect(entry).toBeDefined();
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

  /** `2027-02-31` matches YYYY-MM-DD, but it is not a real day. */
  it('an unowned or undated entry is MALFORMED_SEED_ENTRY', () => {
    const unowned = auditEventGrammarRatchet(
      BEFORE_ANY_EXPIRY,
      live,
      concessionsWith('word-separator:-', { owner: '   ' }),
    );
    expect(codesOf(unowned)).toContain('MALFORMED_SEED_ENTRY');

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
  /**
   * A namespace separator does not count as usage. Otherwise a malformed name keeps a concession
   * alive, and the stale tooth accepts the name that the forward tooth rejects.
   */
  it('a separator in the NAMESPACE is a defect, not an exercise of the concession', () => {
    const report = censusLiveEventNameGrammar(['my-app.started']);
    expect(report.records[0]).toMatchObject({
      wellFormed: false,
      defect: 'NAMESPACE_NOT_SINGLE_WORD',
      concessions: [],
    });
    expect(report.concessionUsage.get('word-separator:-')).toEqual([]);
  });

  it('a separator in a tail segment is an exercise of the concession', () => {
    const report = censusLiveEventNameGrammar(['workflow.plan-review-dispatched']);
    expect(report.records[0]).toMatchObject({
      wellFormed: true,
      concessions: ['word-separator:-'],
    });
  });
});

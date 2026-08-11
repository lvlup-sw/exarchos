import { describe, it, expect } from 'vitest';
import { EventTypes } from './schemas.js';
import {
  assertWellFormedEventName,
  buildEventNamePattern,
  classifyEventName,
  isWellFormedEventName,
  EmptyGrammarVocabularyError,
  MalformedEventNameError,
  EVENT_NAME_DEFECTS,
  EVENT_NAME_MIGRATION_NOTE,
  EVENT_NAME_PATTERN,
  LOWER_ALPHA,
  WORD_SEPARATORS,
  MIN_NAME_SEGMENTS,
  MAX_NAME_SEGMENTS,
  MALFORMED_EVENT_NAMES,
  WELL_FORMED_EVENT_NAME_SAMPLES,
} from './event-name.js';

// @oracle-sources: ./schemas.ts, the ASCII lowercase alphabet as fixed outside this repo together
// with the RETIRED EVENT_NAME_PATTERN regex literal recovered from git history and restated in
// docs/migrations/2026-08-10-event-name-grammar.md
//
// The two authorities are the live event CATALOG (`EventTypes`, which nothing in this file can
// edit) and the RULE it is measured against. Until task 075 they disagreed on 25 names and this
// file recorded the contradiction rather than reconciling it; the collapse suite below is the
// repair, and it keeps the retired regex as a live SUBJECT so the change is provable in both
// directions instead of merely described.
//
// The compile-time half of DR-3 lives in `event-name.ts` itself (`_EventName_*` proof aliases),
// because `tsconfig.json` excludes `*.test.ts` — a type-level assertion in this file would not be
// checked by the build's `tsc` and would be decoration. What this file adds is the RUNTIME mirror:
// `classifyEventName` is the seam the census consumes, and it has to decide exactly what the type
// decides. Both rungs read the SAME fixture tables, so a divergence fails one of them.

describe('EventName_MalformedFixtures_AreRejectedAtRuntime', () => {
  it('has a non-empty kill fixture table', () => {
    // The non-empty-denominator rule, at runtime. `it.each` over an empty table reports zero
    // tests and a green suite, so the denominator gets its own assertion rather than being
    // implied by the loop below. Mirrors `_EventName_KillFixtures_AreNonEmpty`.
    expect(MALFORMED_EVENT_NAMES.length).toBeGreaterThan(0);
  });

  it.each(MALFORMED_EVENT_NAMES)('rejects $name with $defect', ({ name, defect }) => {
    const verdict = classifyEventName(name);
    expect(verdict.ok).toBe(false);
    // Not just "rejected" — rejected for the clause the table says it violates. A checker that
    // returned one blanket code for everything would pass a bare `ok === false` assertion while
    // giving the census nothing to ratchet on.
    if (!verdict.ok) expect(verdict.defect).toBe(defect);
    expect(isWellFormedEventName(name)).toBe(false);
  });

  it('every declared defect code is exercised by at least one fixture', () => {
    // Guards against a code being added to the vocabulary that nothing can produce — a defect
    // class declared but unreachable is the vacuity pattern this program exists to close.
    const exercised = new Set(MALFORMED_EVENT_NAMES.map((fixture) => fixture.defect));
    expect([...exercised].sort()).toEqual([...EVENT_NAME_DEFECTS].sort());
  });
});

describe('EventName_RegisteredCatalog_IsWellFormedAtRuntime', () => {
  it('enumerates a non-empty catalog', () => {
    // If `EventTypes` ever resolves empty (a moved module, a broken re-export), the loop below
    // would pass clean. It must fail instead.
    expect(EventTypes.length).toBeGreaterThan(0);
  });

  it('accepts every registered event type', () => {
    // The runtime twin of `_EventName_EveryRegisteredType_IsWellFormed`. The compile-time proof
    // is the stronger one; this catches the case where `classifyEventName` and the type diverge,
    // which is the only way the census could report a name the grammar actually accepts.
    const rejected = [...EventTypes].filter((name) => !isWellFormedEventName(name));
    expect(rejected).toEqual([]);
  });

  it('agrees with the shape measurements the grammar was derived from', () => {
    // Pins the corpus facts the header's derivation table cites. If a future event type breaks
    // one of these, the grammar's stated evidence is stale and this says so by name.
    const names = [...EventTypes];
    const arities = new Set(names.map((name) => name.split('.').length));
    expect([...arities].sort()).toEqual([MIN_NAME_SEGMENTS, MAX_NAME_SEGMENTS]);
    expect(names.filter((name) => /[A-Z]/.test(name))).toEqual([]);
    expect(names.filter((name) => /[0-9]/.test(name))).toEqual([]);
    expect(names.filter((name) => /[-_]/.test(name.split('.')[0] ?? ''))).toEqual([]);
  });
});

describe('EventName_WellFormedSamples_AreAcceptedAtRuntime', () => {
  it.each(WELL_FORMED_EVENT_NAME_SAMPLES)('accepts %s', (name) => {
    const verdict = classifyEventName(name);
    expect(verdict).toEqual({ ok: true, name });
  });

  it('covers both live word-separator styles', () => {
    // The samples are only useful if they span the shapes the catalog exhibits; a table of six
    // two-segment plain names would accept a grammar that rejected all 54 hyphen/underscore names.
    expect(WELL_FORMED_EVENT_NAME_SAMPLES.some((name) => name.includes('-'))).toBe(true);
    expect(WELL_FORMED_EVENT_NAME_SAMPLES.some((name) => name.includes('_'))).toBe(true);
    expect(
      WELL_FORMED_EVENT_NAME_SAMPLES.some((name) => name.split('.').length === MAX_NAME_SEGMENTS),
    ).toBe(true);
  });
});

describe('EventName_DataForms_AreCompleteVocabularies', () => {
  it('LOWER_ALPHA is the 26 letters, in order, with no gaps', () => {
    // The type-level proof pins LOWER_ALPHA to the `LowerAlpha` union, but both halves are written
    // by hand — a letter dropped from BOTH would satisfy mutual assignability and silently narrow
    // the grammar. This is the independent check that catches that.
    expect(LOWER_ALPHA.length).toBe(26);
    expect(LOWER_ALPHA.join('')).toBe('abcdefghijklmnopqrstuvwxyz');
  });

  it('WORD_SEPARATORS holds exactly the two live styles', () => {
    expect([...WORD_SEPARATORS]).toEqual(['-', '_']);
  });

  it('defect codes are unique', () => {
    expect(new Set(EVENT_NAME_DEFECTS).size).toBe(EVENT_NAME_DEFECTS.length);
  });
});

describe('EventName_Classifier_ReportsTheOffendingSegment', () => {
  it('names the segment for a segment-scoped defect', () => {
    // The census reports per-name findings; without the segment the report says a name is bad but
    // not where, which is not actionable.
    const verdict = classifyEventName('workflow.plan-review_dispatched');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.defect).toBe('MIXED_WORD_SEPARATORS');
      expect(verdict.segment).toBe('plan-review_dispatched');
      expect(verdict.message).toContain('plan-review_dispatched');
    }
  });

  it('omits the segment for a whole-name defect', () => {
    const verdict = classifyEventName('workflowstarted');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.defect).toBe('MISSING_SEPARATOR');
      expect(verdict.segment).toBeUndefined();
    }
  });

  it('rejects the empty string without throwing', () => {
    // The census maps over whatever the registry holds; a hostile or corrupt key must produce a
    // verdict, not an exception that aborts the enumeration and reads as "no findings".
    expect(classifyEventName('').ok).toBe(false);
  });
});

// ─── The collapse (DR-5, task 075) ──────────────────────────────────────────
//
// `RETIRED_PATTERN` is the regex `schemas.ts` shipped until task 075, transcribed from git history
// and restated in the migration note. It is kept here as a SUBJECT, not as a rule: it is what makes
// "this name used to register and no longer does" a measurement rather than an assertion. Nothing
// in the production tree reads it.
const RETIRED_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** Names the retired regex ADMITTED that the surviving grammar refuses — one per broken clause. */
const NEWLY_REFUSED: ReadonlyArray<{ readonly name: string; readonly defect: string }> = [
  { name: 'my-app.started', defect: 'NAMESPACE_NOT_SINGLE_WORD' },
  { name: 'deploy.rollout2', defect: 'NON_LOWERCASE_ALPHA' },
  { name: 'my-app.started2', defect: 'NAMESPACE_NOT_SINGLE_WORD' },
  { name: 'workflow.plan.review.dispatched', defect: 'TOO_MANY_SEGMENTS' },
];

/** Names the retired regex REFUSED that the surviving grammar accepts — the snake_case half. */
const NEWLY_ACCEPTED: readonly string[] = [
  'deploy.rollback_started',
  'billing.invoice_reissued',
  'audit.trail.write_deferred',
];

describe('EventName_RetiredPattern_IsSupersededInBothDirections', () => {
  it('has a non-empty subject in each direction', () => {
    // The non-empty-denominator rule for the two kill tables. `it.each` over an empty table reports
    // zero tests and a green suite, so both denominators are asserted before either is quantified
    // over — and the tables must be DISJOINT, which is what stops one table being pasted into both.
    expect(NEWLY_REFUSED.length).toBeGreaterThan(0);
    expect(NEWLY_ACCEPTED.length).toBeGreaterThan(0);
    const overlap = NEWLY_ACCEPTED.filter((name) =>
      NEWLY_REFUSED.some((fixture) => fixture.name === name),
    );
    expect(overlap).toEqual([]);
  });

  it.each(NEWLY_REFUSED)(
    'the retired pattern admitted $name; the grammar refuses it with $defect',
    ({ name, defect }) => {
      // BOTH halves are executed. Asserting only the second half would pass against a name the old
      // regex never admitted either, which proves nothing about the change.
      expect(RETIRED_PATTERN.test(name)).toBe(true);
      const verdict = classifyEventName(name);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.defect).toBe(defect);
    },
  );

  it.each(NEWLY_ACCEPTED)('the retired pattern refused %s; the grammar accepts it', (name) => {
    expect(RETIRED_PATTERN.test(name)).toBe(false);
    expect(classifyEventName(name)).toEqual({ ok: true, name });
  });

  it('the 25 snake_case built-ins the retired pattern rejected are all accepted now', () => {
    // The finding this task closes, stated over the REAL corpus rather than over the fixture table.
    // The count is read back from the retired regex, not written down: a future built-in changes
    // it, and a hard-coded 25 would then be a false claim about a corpus that had moved.
    const wasRejected = [...EventTypes].filter((name) => !RETIRED_PATTERN.test(name));
    expect(wasRejected.length).toBeGreaterThan(0);
    expect(wasRejected.filter((name) => !name.includes('_'))).toEqual([]);
    expect(wasRejected.filter((name) => !isWellFormedEventName(name))).toEqual([]);
    // And the surviving authority admits ALL of them, which is the property the retired one lacked.
    expect(wasRejected.filter((name) => !EVENT_NAME_PATTERN.test(name))).toEqual([]);
  });
});

describe('EventName_AssertWellFormed_ThrowsAndNamesTheMigration', () => {
  it.each(NEWLY_REFUSED)('$name throws a MalformedEventNameError carrying $defect', ({ name, defect }) => {
    expect(() => {
      assertWellFormedEventName(name);
    }).toThrow(MalformedEventNameError);

    let caught: unknown;
    try {
      assertWellFormedEventName(name);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MalformedEventNameError);
    if (caught instanceof MalformedEventNameError) {
      expect(caught.eventName).toBe(name);
      expect(caught.defect).toBe(defect);
      // The message must NAME the migration. A user hitting this on upgrade is not making a typo —
      // the name was legal yesterday — so an error that only says "invalid" sends them to read a
      // regex that no longer exists.
      expect(caught.message).toContain(EVENT_NAME_MIGRATION_NOTE);
      expect(caught.message).toContain(name);
    }
  });

  it.each(NEWLY_ACCEPTED)('%s does not throw', (name) => {
    expect(() => {
      assertWellFormedEventName(name);
    }).not.toThrow();
  });

  it('the migration note it points at is a real path shape', () => {
    // A pointer nobody can follow is worse than no pointer: it reads as an answer.
    expect(EVENT_NAME_MIGRATION_NOTE).toMatch(/^docs\/migrations\/[\w.-]+\.md$/);
  });
});

describe('EventName_DerivedPattern_IsAFormNotASecondAuthority', () => {
  it('agrees with the classifier on every live name and every fixture', () => {
    // The whole point of deriving the regex instead of re-authoring it. The subject spans the live
    // catalog, both kill tables and the malformed fixtures, so a divergence anywhere in the grammar
    // surfaces here rather than at a registration site in someone else's repo.
    const subjects = [
      ...EventTypes,
      ...WELL_FORMED_EVENT_NAME_SAMPLES,
      ...MALFORMED_EVENT_NAMES.map((fixture) => fixture.name),
      ...NEWLY_ACCEPTED,
      ...NEWLY_REFUSED.map((fixture) => fixture.name),
      '',
      'a.b',
    ];
    expect(subjects.length).toBeGreaterThan(EventTypes.length);

    const disagreements = subjects.filter(
      (name) => EVENT_NAME_PATTERN.test(name) !== isWellFormedEventName(name),
    );
    expect(disagreements).toEqual([]);
  });

  it('rejects a segment that mixes the two word separators, like the type does', () => {
    // The one clause a naive character class cannot express, and the reason the derived pattern is
    // an alternation per separator rather than `[a-z_-]+`.
    expect(EVENT_NAME_PATTERN.test('workflow.plan-review_dispatched')).toBe(false);
    expect(EVENT_NAME_PATTERN.test('workflow.plan-review-dispatched')).toBe(true);
    expect(EVENT_NAME_PATTERN.test('workflow.plan_review_dispatched')).toBe(true);
  });

  it('is rebuilt from the grammar data, not pinned to a literal', () => {
    // Narrow the separator set and the pattern narrows with it. A hand-written regex would not
    // move, which is exactly how the two authorities drifted apart the first time.
    const kebabOnly = buildEventNamePattern(LOWER_ALPHA, ['-']);
    expect(kebabOnly.test('workflow.plan-review-dispatched')).toBe(true);
    expect(kebabOnly.test('workflow.checkpoint_requested')).toBe(false);
    expect(EVENT_NAME_PATTERN.test('workflow.checkpoint_requested')).toBe(true);
  });

  it('honours the segment bounds it is handed', () => {
    const upToFour = buildEventNamePattern(LOWER_ALPHA, WORD_SEPARATORS, MIN_NAME_SEGMENTS, 4);
    expect(upToFour.test('workflow.plan.review.dispatched')).toBe(true);
    expect(EVENT_NAME_PATTERN.test('workflow.plan.review.dispatched')).toBe(false);
    expect(upToFour.test('workflow')).toBe(false);
  });
});

describe('EventName_EmptyVocabulary_FailsRatherThanValidatingNothing', () => {
  it('an emptied alphabet throws instead of building a validator that matches nothing', () => {
    // The non-empty-denominator rule at the CONSTRUCTION site. `[]+` matches no string, so a
    // grammar built from an emptied alphabet would refuse every name — which looks exactly like a
    // strict validator and is actually a dead one.
    expect(() => buildEventNamePattern([], WORD_SEPARATORS)).toThrow(EmptyGrammarVocabularyError);
  });

  it('an emptied separator set throws for the same reason', () => {
    expect(() => buildEventNamePattern(LOWER_ALPHA, [])).toThrow(EmptyGrammarVocabularyError);
  });

  it('an impossible segment bound throws rather than silently building an empty repetition', () => {
    expect(() => buildEventNamePattern(LOWER_ALPHA, WORD_SEPARATORS, 1, 3)).toThrow(RangeError);
    expect(() => buildEventNamePattern(LOWER_ALPHA, WORD_SEPARATORS, 3, 2)).toThrow(RangeError);
  });

  it('a non-integer segment bound throws rather than degrading the quantifier to literal braces', () => {
    // JavaScript does not read `{1.5,2}` or `{1,Infinity}` as a quantifier — the
    // braces become LITERAL characters, so the pattern stops enforcing a segment
    // count and starts demanding that text. A bound that silently disables the
    // bound is the failure this guard exists for.
    for (const [min, max] of [
      [2.5, 3],
      [2, 3.5],
      [2, Infinity],
      [Number.NaN, 3],
    ] as const) {
      expect(() => buildEventNamePattern(LOWER_ALPHA, WORD_SEPARATORS, min, max)).toThrow(
        RangeError,
      );
    }
  });

  it('escapes vocabulary characters instead of letting them mean something in the pattern', () => {
    // The builder concatenates its inputs into a regex source. A separator that is a metacharacter
    // must be a literal, or a narrowed vocabulary would silently WIDEN the pattern.
    // Named for the separator actually under test — it is `+`, and this is the one
    // test whose whole subject is WHICH character gets escaped.
    const plusSeparated = buildEventNamePattern(LOWER_ALPHA, ['+']);
    expect(plusSeparated.test('workflow.plan+review')).toBe(true);
    expect(plusSeparated.test('workflow.planreview')).toBe(true);
    expect(plusSeparated.test('workflow.plan-review')).toBe(false);
  });
});

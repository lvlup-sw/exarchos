// @oracle-sources: ../../../src/events/schemas.ts, the ASCII lowercase alphabet as fixed outside this repo together
// with the RETIRED EVENT_NAME_PATTERN regex literal recovered from git history and restated in
// docs/migrations/2026-08-10-event-name-grammar.md
//
// The two authorities are the live event catalog (`EventTypes`) and the rule that measures it.
// The collapse suite keeps the retired regex as a subject, so the change is provable in both
// directions.
//
// The compile-time proofs are the `_EventName_*` aliases in `event-name.ts`, because
// `tsconfig.json` excludes test files. This file is the runtime mirror: the census reads
// `classifyEventName`, and it must decide exactly what the type decides. Both read the same
// fixture tables, so a divergence fails one of them.

import { describe, it, expect } from 'vitest';
import { EventTypes } from '../../../src/events/schemas.js';
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
} from '../../../src/events/event-name.js';

describe('EventName_MalformedFixtures_AreRejectedAtRuntime', () => {
  /**
   * `it.each` over an empty table reports zero tests and a green suite, so the table size has its
   * own assertion. It mirrors `_EventName_KillFixtures_AreNonEmpty`.
   */
  it('has a non-empty kill fixture table', () => {
    expect(MALFORMED_EVENT_NAMES.length).toBeGreaterThan(0);
  });

  /**
   * The defect must be the clause that the table names. A checker that returns the same code for
   * all failures passes a bare `ok === false` assertion and gives the census nothing to ratchet on.
   */
  it.each(MALFORMED_EVENT_NAMES)('rejects $name with $defect', ({ name, defect }) => {
    const verdict = classifyEventName(name);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.defect).toBe(defect);
    expect(isWellFormedEventName(name)).toBe(false);
  });

  /** A defect code that no fixture produces is declared and unreachable, so each code needs a fixture. */
  it('every declared defect code is exercised by at least one fixture', () => {
    const exercised = new Set(MALFORMED_EVENT_NAMES.map((fixture) => fixture.defect));
    expect([...exercised].sort()).toEqual([...EVENT_NAME_DEFECTS].sort());
  });
});

describe('EventName_RegisteredCatalog_IsWellFormedAtRuntime', () => {
  /**
   * An empty `EventTypes`, from a moved module or a broken re-export, makes the next loop pass.
   * It must fail here.
   */
  it('enumerates a non-empty catalog', () => {
    expect(EventTypes.length).toBeGreaterThan(0);
  });

  /**
   * The runtime twin of `_EventName_EveryRegisteredType_IsWellFormed`. It catches a divergence
   * between `classifyEventName` and the type.
   */
  it('accepts every registered event type', () => {
    const rejected = [...EventTypes].filter((name) => !isWellFormedEventName(name));
    expect(rejected).toEqual([]);
  });

  /**
   * Pins the shape facts of the catalog that the grammar cites as evidence. A later event type
   * that breaks one makes that evidence stale.
   */
  it('agrees with the shape measurements the grammar was derived from', () => {
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

  /**
   * The samples must span the shapes of the catalog. A table of plain two-segment names also
   * passes for a grammar that rejects every name with a hyphen or an underscore.
   */
  it('covers both live word-separator styles', () => {
    expect(WELL_FORMED_EVENT_NAME_SAMPLES.some((name) => name.includes('-'))).toBe(true);
    expect(WELL_FORMED_EVENT_NAME_SAMPLES.some((name) => name.includes('_'))).toBe(true);
    expect(
      WELL_FORMED_EVENT_NAME_SAMPLES.some((name) => name.split('.').length === MAX_NAME_SEGMENTS),
    ).toBe(true);
  });
});

describe('EventName_DataForms_AreCompleteVocabularies', () => {
  /**
   * The `LowerAlpha` union derives from the `LOWER_ALPHA` tuple, so the type-level proof compares
   * the tuple with itself. A dropped letter passes that proof and narrows the grammar. This check
   * is independent.
   */
  it('LOWER_ALPHA is the 26 letters, in order, with no gaps', () => {
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
  /**
   * The census reports a finding for each name. Without the segment, the report does not say
   * where the defect is.
   */
  it('names the segment for a segment-scoped defect', () => {
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

  /**
   * The census maps over each key in the registry. A corrupt key must give a verdict and not an
   * exception, because an exception stops the enumeration and reads as no findings.
   */
  it('rejects the empty string without throwing', () => {
    expect(classifyEventName('').ok).toBe(false);
  });
});

/**
 * The retired event-name regex of `schemas.ts`, as the migration note states it. The tests use it
 * as a subject and not as a rule. Production code does not read it.
 */
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
  /**
   * `it.each` over an empty table reports zero tests, so the test asserts both table sizes first.
   * The tables must also be disjoint, which catches one table pasted into both.
   */
  it('has a non-empty subject in each direction', () => {
    expect(NEWLY_REFUSED.length).toBeGreaterThan(0);
    expect(NEWLY_ACCEPTED.length).toBeGreaterThan(0);
    const overlap = NEWLY_ACCEPTED.filter((name) =>
      NEWLY_REFUSED.some((fixture) => fixture.name === name),
    );
    expect(overlap).toEqual([]);
  });

  /**
   * The test runs both halves. The second half alone also passes for a name that the retired
   * regex never admitted, and that proves nothing about the change.
   */
  it.each(NEWLY_REFUSED)(
    'the retired pattern admitted $name; the grammar refuses it with $defect',
    ({ name, defect }) => {
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

  /**
   * The finding over the real corpus and not over the fixture table. The test reads the count
   * from the retired regex, because a later built-in changes it. The derived pattern must also
   * admit each name.
   */
  it('the 25 snake_case built-ins the retired pattern rejected are all accepted now', () => {
    const wasRejected = [...EventTypes].filter((name) => !RETIRED_PATTERN.test(name));
    expect(wasRejected.length).toBeGreaterThan(0);
    expect(wasRejected.filter((name) => !name.includes('_'))).toEqual([]);
    expect(wasRejected.filter((name) => !isWellFormedEventName(name))).toEqual([]);
    expect(wasRejected.filter((name) => !EVENT_NAME_PATTERN.test(name))).toEqual([]);
  });
});

describe('EventName_AssertWellFormed_ThrowsAndNamesTheMigration', () => {
  /**
   * The message must name the migration note. The name was legal before the migration, so an
   * error that says only "invalid" does not tell the user what changed.
   */
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
      expect(caught.message).toContain(EVENT_NAME_MIGRATION_NOTE);
      expect(caught.message).toContain(name);
    }
  });

  it.each(NEWLY_ACCEPTED)('%s does not throw', (name) => {
    expect(() => {
      assertWellFormedEventName(name);
    }).not.toThrow();
  });

  /** A pointer that nobody can follow reads as an answer, so the note must have a real path shape. */
  it('the migration note it points at is a real path shape', () => {
    expect(EVENT_NAME_MIGRATION_NOTE).toMatch(/^docs\/migrations\/[\w.-]+\.md$/);
  });
});

describe('EventName_DerivedPattern_IsAFormNotASecondAuthority', () => {
  /**
   * The regex is derived and not written a second time, so it must agree with the classifier.
   * The subjects are the live catalog, the samples, the malformed fixtures and both kill tables.
   */
  it('agrees with the classifier on every live name and every fixture', () => {
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

  /**
   * A plain character class cannot express this clause, so the derived pattern is an alternation
   * for each separator.
   */
  it('rejects a segment that mixes the two word separators, like the type does', () => {
    expect(EVENT_NAME_PATTERN.test('workflow.plan-review_dispatched')).toBe(false);
    expect(EVENT_NAME_PATTERN.test('workflow.plan-review-dispatched')).toBe(true);
    expect(EVENT_NAME_PATTERN.test('workflow.plan_review_dispatched')).toBe(true);
  });

  /**
   * A smaller separator set must give a narrower pattern. A hand-written regex does not move with
   * the grammar data.
   */
  it('is rebuilt from the grammar data, not pinned to a literal', () => {
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
  /**
   * `[]+` matches no string. A grammar from an empty alphabet refuses each name, which looks like
   * a strict validator and is a dead one.
   */
  it('an emptied alphabet throws instead of building a validator that matches nothing', () => {
    expect(() => buildEventNamePattern([], WORD_SEPARATORS)).toThrow(EmptyGrammarVocabularyError);
  });

  it('an emptied separator set throws for the same reason', () => {
    expect(() => buildEventNamePattern(LOWER_ALPHA, [])).toThrow(EmptyGrammarVocabularyError);
  });

  it('an impossible segment bound throws rather than silently building an empty repetition', () => {
    expect(() => buildEventNamePattern(LOWER_ALPHA, WORD_SEPARATORS, 1, 3)).toThrow(RangeError);
    expect(() => buildEventNamePattern(LOWER_ALPHA, WORD_SEPARATORS, 3, 2)).toThrow(RangeError);
  });

  /**
   * JavaScript does not read `{1.5,2}` or `{1,Infinity}` as a quantifier. The braces become
   * literal characters, and the pattern stops enforcing a segment count.
   */
  it('a non-integer segment bound throws rather than degrading the quantifier to literal braces', () => {
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

  /**
   * The builder concatenates its inputs into a regex source. A separator that is a metacharacter
   * must be a literal, or a narrowed vocabulary widens the pattern. The separator under test is
   * `+`.
   */
  it('escapes vocabulary characters instead of letting them mean something in the pattern', () => {
    const plusSeparated = buildEventNamePattern(LOWER_ALPHA, ['+']);
    expect(plusSeparated.test('workflow.plan+review')).toBe(true);
    expect(plusSeparated.test('workflow.planreview')).toBe(true);
    expect(plusSeparated.test('workflow.plan-review')).toBe(false);
  });
});

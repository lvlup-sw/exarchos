import { describe, it, expect } from 'vitest';
import { EventTypes } from './schemas.js';
import {
  classifyEventName,
  isWellFormedEventName,
  EVENT_NAME_DEFECTS,
  LOWER_ALPHA,
  WORD_SEPARATORS,
  MIN_NAME_SEGMENTS,
  MAX_NAME_SEGMENTS,
  MALFORMED_EVENT_NAMES,
  WELL_FORMED_EVENT_NAME_SAMPLES,
} from './event-name.js';

// @oracle-sources: ./schemas.ts, the ASCII lowercase alphabet and the regex literal transcribed
// from the shipped EVENT_NAME_PATTERN, both fixed outside this module
//
// The two authorities are the live event CATALOG (`EventTypes`, which nothing in this file can
// edit) and the RULE it is measured against. They can disagree, and the divergence suite below is
// the case where they already do: `EVENT_NAME_PATTERN` and the catalog contradict each other on 25
// names, and the test records the contradiction rather than reconciling it.
//
// The compile-time half of DR-3 lives in `event-name.ts` itself (`_EventName_*` proof aliases),
// because `tsconfig.json` excludes `*.test.ts` — a type-level assertion in this file would not be
// checked by the build's `tsc` and would be decoration. What this file adds is the RUNTIME mirror:
// `classifyEventName` is the seam task 015's census consumes, and it has to decide exactly what
// the type decides. Both rungs read the SAME fixture tables, so a divergence fails one of them.

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

describe('EventName_ShippedPattern_DivergesFromTheCatalog', () => {
  it('EVENT_NAME_PATTERN rejects the 25 snake_case built-ins it is supposed to govern', () => {
    // FINDING, pinned rather than fixed (see the `event-name.ts` header). `schemas.ts` ships
    // `EVENT_NAME_PATTERN` with no `_` in its character classes and applies it only to CUSTOM
    // registrations, so it has never been pointed at the corpus it claims to describe. This test
    // is the standing evidence: it fails the day someone repairs the pattern, which is exactly
    // when this note should be revisited.
    const shipped = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
    const rejectedByShipped = [...EventTypes].filter((name) => !shipped.test(name));

    expect(rejectedByShipped.length).toBe(25);
    // Every one of them is accepted by THIS grammar — the divergence is the pattern's, not ours.
    expect(rejectedByShipped.filter((name) => !isWellFormedEventName(name))).toEqual([]);
    // And the whole divergence is the underscore, nothing else.
    expect(rejectedByShipped.filter((name) => !name.includes('_'))).toEqual([]);
  });
});

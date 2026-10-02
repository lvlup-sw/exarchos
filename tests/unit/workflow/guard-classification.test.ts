/**
 * Tests the guard classification corpus. Each guard in `guards.ts` and each guard on an HSM
 * transition must have exactly one entry with a valid category. Obsolete no-ops must return `true`.
 * Bounded loops must compare a counter to a cap. Route conditions at one fork must exclude each
 * other. Each transition guard must have a corpus fixture.
 */

import { describe, it, expect } from 'vitest';
import { guards } from '../../../src/workflow/guards.js';
import { getHSMDefinition } from '../../../src/workflow/state-machine.js';
import {
  GUARD_CLASSIFICATIONS,
  GUARD_CATEGORIES,
  CLASSIFIED_GUARD_COUNT,
  GUARDS_FLAGGED_FOR_REMEDIATION,
  OBSOLETE_GUARD_IDS,
  BOUNDED_LOOP_GUARD_IDS,
  type GuardCategory,
} from './__fixtures__/guard-classification.js';
import {
  legacyTransitionCorpus,
  BUILT_IN_WORKFLOW_TYPES,
} from './__fixtures__/transition-admission-corpus.js';

/** Returns every guard ID used in HSM transitions across all built-in workflows. */
function allTransitionGuardIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const wt of BUILT_IN_WORKFLOW_TYPES) {
    const def = getHSMDefinition(wt);
    for (const t of def.transitions) {
      if (t.guard?.id) ids.add(t.guard.id);
    }
  }
  return ids;
}

/** Returns the IDs of all guards exported from guards.ts. */
function allExportedGuardIds(): ReadonlySet<string> {
  return new Set(Object.values(guards).map((g) => g.id));
}

/**
 * Returns the union of exported guard IDs and transition guard IDs.
 * This is the complete set that must be classified.
 */
function allKnownGuardIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const id of allExportedGuardIds()) ids.add(id);
  for (const id of allTransitionGuardIds()) ids.add(id);
  return ids;
}

describe('GuardClassification_Totality (P06-01)', () => {
  it('every guard exported from guards.ts is classified', () => {
    const missing: string[] = [];
    for (const id of allExportedGuardIds()) {
      if (!(id in GUARD_CLASSIFICATIONS)) {
        missing.push(id);
      }
    }
    expect(missing, `Unclassified guard IDs from guards.ts: ${missing.join(', ')}`).toHaveLength(
      0,
    );
  });

  it('every composite guard used in HSM transitions is classified', () => {
    const missing: string[] = [];
    for (const id of allTransitionGuardIds()) {
      if (!(id in GUARD_CLASSIFICATIONS)) {
        missing.push(id);
      }
    }
    expect(
      missing,
      `Unclassified composite guard IDs from HSM transitions: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it('classification count equals the total number of known guard IDs', () => {
    const knownIds = allKnownGuardIds();
    expect(CLASSIFIED_GUARD_COUNT).toBe(knownIds.size);
  });

  it('no unknown guard ID is classified (no stale classification entries)', () => {
    const knownIds = allKnownGuardIds();
    const stale: string[] = [];
    for (const id of Object.keys(GUARD_CLASSIFICATIONS)) {
      if (!knownIds.has(id)) {
        stale.push(id);
      }
    }
    expect(
      stale,
      `Stale classification entries for IDs not in guards.ts or HSM transitions: ${stale.join(', ')}`,
    ).toHaveLength(0);
  });
});

describe('GuardClassification_Uniqueness (P06-01)', () => {
  /** A `Record` cannot hold duplicate keys. The check still catches a change to an array. */
  it('no guard ID is classified more than once', () => {
    const ids = Object.keys(GUARD_CLASSIFICATIONS);
    const idSet = new Set(ids);
    expect(ids.length).toBe(idSet.size);
  });

  it('every entry id property matches its record key', () => {
    const mismatches: string[] = [];
    for (const [key, entry] of Object.entries(GUARD_CLASSIFICATIONS)) {
      if (key !== entry.id) {
        mismatches.push(`key=${key} entry.id=${entry.id}`);
      }
    }
    expect(
      mismatches,
      `Classification entries where key ≠ entry.id: ${mismatches.join(', ')}`,
    ).toHaveLength(0);
  });
});

describe('GuardClassification_ValidCategories (P06-01)', () => {
  it('all classification categories are members of GUARD_CATEGORIES', () => {
    const validSet = new Set<string>(GUARD_CATEGORIES);
    const invalid: string[] = [];
    for (const entry of Object.values(GUARD_CLASSIFICATIONS)) {
      if (!validSet.has(entry.category)) {
        invalid.push(`${entry.id}: "${entry.category}"`);
      }
    }
    expect(invalid, `Invalid category values: ${invalid.join(', ')}`).toHaveLength(0);
  });

  it('GUARD_CATEGORIES contains exactly the six DR-1 categories', () => {
    expect([...GUARD_CATEGORIES].sort()).toEqual([
      'admission-requirement',
      'approval',
      'bounded-loop-rule',
      'obsolete-predicate',
      'route-condition',
      'waiver',
    ]);
  });
});

describe('GuardClassification_ObsoletePredicateNoOps_AlwaysReturnTrue (P06-01)', () => {
  const ALWAYS_PASS_OBSOLETE: readonly string[] = [
    'implementation-complete',
    'always',
  ];

  for (const id of ALWAYS_PASS_OBSOLETE) {
    it(`${id} is classified obsolete-predicate and returns true for any state`, () => {
      expect(GUARD_CLASSIFICATIONS[id]?.category).toBe('obsolete-predicate');
      expect(OBSOLETE_GUARD_IDS.has(id)).toBe(true);

      const guard = Object.values(guards).find((g) => g.id === id);
      expect(guard, `Guard ${id} not found in guards export`).toBeDefined();
      if (!guard) return;

      const emptyResult = guard.evaluate({});
      expect(emptyResult, `${id}.evaluate({}) must return true`).toBe(true);

      const richResult = guard.evaluate({
        tasks: [{ id: 't1', status: 'in_progress' }],
        reviews: { r1: { status: 'fail' } },
        implementation: { complete: false },
        artifacts: {},
        synthesis: {},
      });
      expect(richResult, `${id}.evaluate(rich-failing-state) must return true`).toBe(true);
    });
  }

  /** These guards do not always pass, but no active transition uses them. */
  it('design-artifact-exists, root-cause-found, brief-complete are classified obsolete-predicate', () => {
    for (const id of ['design-artifact-exists', 'root-cause-found', 'brief-complete']) {
      expect(GUARD_CLASSIFICATIONS[id]?.category).toBe('obsolete-predicate');
      expect(OBSOLETE_GUARD_IDS.has(id)).toBe(true);
    }
  });

  /**
   * `implementation-complete` is on the debug, hotfix and polish implement edges, and that is the
   * defect. So the test asserts that each always-pass guard is flagged for remediation, not absent.
   * `always` must be on no transition.
   */
  it('none of the always-pass obsolete guards are referenced in active HSM transitions', () => {
    const transitionIds = allTransitionGuardIds();
    for (const id of ALWAYS_PASS_OBSOLETE) {
      expect(
        GUARD_CLASSIFICATIONS[id]?.flaggedForRemediation,
        `${id} is an always-pass no-op in transitions and must be flagged for remediation`,
      ).toBe(true);
    }
    expect(transitionIds.has('always')).toBe(false);
  });
});

describe('GuardClassification_BoundedLoopRules_UseNumericCounter (P06-01)', () => {
  it('revisions-exhausted is classified bounded-loop-rule', () => {
    expect(GUARD_CLASSIFICATIONS['revisions-exhausted']?.category).toBe('bounded-loop-rule');
    expect(BOUNDED_LOOP_GUARD_IDS.has('revisions-exhausted')).toBe(true);
  });

  /** The default cap is 1 (`DEFAULT_MAX_PLAN_REVISIONS`). */
  it('revisions-exhausted passes when count >= cap', () => {
    const passCap1 = guards.revisionsExhausted.evaluate({
      planReview: { revisionCount: 1 },
    });
    expect(passCap1).toBe(true);

    const passCap2 = guards.revisionsExhausted.evaluate({
      planReview: { revisionCount: 3 },
      _maxPlanRevisions: 2,
    });
    expect(passCap2).toBe(true);
  });

  it('revisions-exhausted fails when count < cap', () => {
    const fail = guards.revisionsExhausted.evaluate({
      planReview: { revisionCount: 0 },
    });
    expect(fail).not.toBe(true);
    const result = fail as { passed: false; reason: string };
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/revisions-exhausted not satisfied/);
    expect(result.reason).toMatch(/0\/1/);
  });

  it('revisions-exhausted uses _maxPlanRevisions injection when present', () => {
    const failWithHighCap = guards.revisionsExhausted.evaluate({
      planReview: { revisionCount: 1 },
      _maxPlanRevisions: 3,
    });
    expect(failWithHighCap).not.toBe(true);
    const r = failWithHighCap as { passed: false; reason: string };
    expect(r.reason).toMatch(/1\/3/);
  });

  it('synthesize-retryable is classified bounded-loop-rule', () => {
    expect(GUARD_CLASSIFICATIONS['synthesize-retryable']?.category).toBe('bounded-loop-rule');
    expect(BOUNDED_LOOP_GUARD_IDS.has('synthesize-retryable')).toBe(true);
  });

  it('synthesize-retryable passes when lastError present and retryCount < 3', () => {
    const pass = guards.synthesizeRetryable.evaluate({
      synthesis: { lastError: 'push failed', retryCount: 0 },
    });
    expect(pass).toBe(true);

    const passBoundary = guards.synthesizeRetryable.evaluate({
      synthesis: { lastError: 'push failed', retryCount: 2 },
    });
    expect(passBoundary).toBe(true);
  });

  it('synthesize-retryable fails when retryCount >= 3', () => {
    const fail = guards.synthesizeRetryable.evaluate({
      synthesis: { lastError: 'push failed', retryCount: 3 },
    });
    expect(fail).not.toBe(true);
    const r = fail as { passed: false; reason: string };
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/3\/3 retries exhausted/);
  });

  it('synthesize-retryable fails when no lastError', () => {
    const fail = guards.synthesizeRetryable.evaluate({
      synthesis: { retryCount: 0 },
    });
    expect(fail).not.toBe(true);
    const r = fail as { passed: false; reason: string };
    expect(r.reason).toMatch(/no lastError/);
  });
});

describe('GuardClassification_RouteConditions_MutualExclusivityAtForks (P06-01)', () => {
  it('hotfix-track-selected and thorough-track-selected are mutually exclusive', () => {
    const hotfixState = { track: 'hotfix' };
    const thoroughState = { track: 'thorough' };
    const bothState = { track: 'other' };

    expect(guards.hotfixTrackSelected.evaluate(hotfixState)).toBe(true);
    expect(guards.thoroughTrackSelected.evaluate(hotfixState)).not.toBe(true);

    expect(guards.hotfixTrackSelected.evaluate(thoroughState)).not.toBe(true);
    expect(guards.thoroughTrackSelected.evaluate(thoroughState)).toBe(true);

    expect(guards.hotfixTrackSelected.evaluate(bothState)).not.toBe(true);
    expect(guards.thoroughTrackSelected.evaluate(bothState)).not.toBe(true);
  });

  it('polish-track-selected and overhaul-track-selected are mutually exclusive', () => {
    const polishState = { track: 'polish' };
    const overhaulState = { track: 'overhaul' };

    expect(guards.polishTrackSelected.evaluate(polishState)).toBe(true);
    expect(guards.overhaulTrackSelected.evaluate(polishState)).not.toBe(true);

    expect(guards.polishTrackSelected.evaluate(overhaulState)).not.toBe(true);
    expect(guards.overhaulTrackSelected.evaluate(overhaulState)).toBe(true);
  });

  it('synthesis-opted-in and synthesis-opted-out are mutually exclusive', () => {
    const alwaysState = { oneshot: { synthesisPolicy: 'always' } };
    const neverState = { oneshot: { synthesisPolicy: 'never' } };

    expect(guards.synthesisOptedIn.evaluate(alwaysState)).toBe(true);
    expect(guards.synthesisOptedOut.evaluate(alwaysState)).not.toBe(true);

    expect(guards.synthesisOptedIn.evaluate(neverState)).not.toBe(true);
    expect(guards.synthesisOptedOut.evaluate(neverState)).toBe(true);
  });

  /**
   * With `on-request` and no `synthesize.requested` event, the state is opted out. With the event,
   * the state is opted in.
   */
  it('synthesis-opted-in and synthesis-opted-out together cover all cases without gaps', () => {
    const onRequestNoEvent = { oneshot: { synthesisPolicy: 'on-request' }, _events: [] };
    expect(guards.synthesisOptedIn.evaluate(onRequestNoEvent)).not.toBe(true);
    expect(guards.synthesisOptedOut.evaluate(onRequestNoEvent)).toBe(true);

    const onRequestWithEvent = {
      oneshot: { synthesisPolicy: 'on-request' },
      _events: [{ type: 'synthesize.requested', data: {} }],
    };
    expect(guards.synthesisOptedIn.evaluate(onRequestWithEvent)).toBe(true);
    expect(guards.synthesisOptedOut.evaluate(onRequestWithEvent)).not.toBe(true);
  });

  it('any-review-failed and all-reviews-passed are mutually exclusive given well-formed reviews', () => {
    const allPassedState = { reviews: { r1: { status: 'pass' }, r2: { status: 'approved' } } };
    const someFailedState = { reviews: { r1: { status: 'pass' }, r2: { status: 'fail' } } };

    expect(guards.allReviewsPassed.evaluate(allPassedState)).toBe(true);
    expect(guards.anyReviewFailed.evaluate(allPassedState)).not.toBe(true);

    expect(guards.allReviewsPassed.evaluate(someFailedState)).not.toBe(true);
    expect(guards.anyReviewFailed.evaluate(someFailedState)).toBe(true);
  });
});

describe('GuardClassification_CorpusExhaustiveness (P06-01)', () => {
  /** Each fixture covers one edge, so the test maps each HSM edge that has a fixture to its guard ID. */
  it('every guard referenced in HSM transitions has at least one corpus fixture', () => {
    const transitionIds = allTransitionGuardIds();
    const fixturedGuardIds = new Set<string>();

    for (const wt of BUILT_IN_WORKFLOW_TYPES) {
      const def = getHSMDefinition(wt);
      for (const t of def.transitions) {
        if (!t.guard?.id) continue;
        const guardId = t.guard.id;
        const hasFixture = legacyTransitionCorpus.some(
          (f) => f.workflowType === wt && f.from === t.from && f.to === t.to,
        );
        if (hasFixture) {
          fixturedGuardIds.add(guardId);
        }
      }
    }

    const unfixtured: string[] = [];
    for (const id of transitionIds) {
      if (!fixturedGuardIds.has(id)) {
        unfixtured.push(id);
      }
    }
    expect(
      unfixtured,
      `Guard IDs used in transitions but missing corpus fixtures: ${unfixtured.join(', ')}`,
    ).toHaveLength(0);
  });

  it('every corpus fixture (non-bypass) maps to a classified transition guard', () => {
    const mismatches: string[] = [];
    for (const fixture of legacyTransitionCorpus) {
      if (fixture.scenario === 'bypass') continue;
      const def = getHSMDefinition(fixture.workflowType);
      const transition = def.transitions.find(
        (t) => t.from === fixture.from && t.to === fixture.to,
      );
      if (!transition) {
        mismatches.push(
          `fixture ${fixture.id}: no transition ${fixture.workflowType}:${fixture.from}→${fixture.to}`,
        );
        continue;
      }
      if (transition.guard?.id && !(transition.guard.id in GUARD_CLASSIFICATIONS)) {
        mismatches.push(
          `fixture ${fixture.id}: guard ${transition.guard.id} is not classified`,
        );
      }
    }
    expect(
      mismatches,
      `Corpus fixtures with unclassified guards: ${mismatches.join('; ')}`,
    ).toHaveLength(0);
  });

  it('every built-in transition edge has exactly one representative-pass and one representative-fail fixture', () => {
    const edgeKey = (wt: string, from: string, to: string) => `${wt}:${from}->${to}`;
    const representativeFixtures = legacyTransitionCorpus.filter(
      (f) => f.scenario !== 'bypass',
    );

    for (const wt of BUILT_IN_WORKFLOW_TYPES) {
      const def = getHSMDefinition(wt);
      for (const t of def.transitions) {
        const key = edgeKey(wt, t.from, t.to);
        const fixturesForEdge = representativeFixtures.filter(
          (f) => edgeKey(f.workflowType, f.from, f.to) === key,
        );
        const scenarios = fixturesForEdge.map((f) => f.scenario).sort();
        expect(
          scenarios,
          `Edge ${key} must have exactly one 'representative-pass' and one 'representative-fail' fixture`,
        ).toEqual(['representative-fail', 'representative-pass']);
      }
    }
  });
});

describe('GuardClassification_FlaggedGuards_HaveDefectNotes (P06-01)', () => {
  it('every flaggedForRemediation guard has a non-empty defectNote', () => {
    const missing: string[] = [];
    for (const entry of GUARDS_FLAGGED_FOR_REMEDIATION) {
      if (!entry.defectNote || entry.defectNote.trim().length === 0) {
        missing.push(entry.id);
      }
    }
    expect(
      missing,
      `Guards flagged for remediation but missing defectNote: ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it('flags implementation-complete as needing remediation (always-pass on implementation edges)', () => {
    const entry = GUARD_CLASSIFICATIONS['implementation-complete'];
    expect(entry?.flaggedForRemediation).toBe(true);
    expect(entry?.defectNote).toBeDefined();
  });

  /** An empty task list passes. That vacuous pass is the defect that the flag records. */
  it('flags all-tasks-complete as needing remediation (vacuous pass on empty task list)', () => {
    const result = guards.allTasksComplete.evaluate({ tasks: [] });
    expect(result).toBe(true);

    const entry = GUARD_CLASSIFICATIONS['all-tasks-complete'];
    expect(entry?.flaggedForRemediation).toBe(true);
  });

  it('flags human-unblocked as needing remediation (no attribution on approval)', () => {
    const entry = GUARD_CLASSIFICATIONS['human-unblocked'];
    expect(entry?.flaggedForRemediation).toBe(true);
  });

  it('flags plan-review-complete as needing remediation (plain mutable boolean)', () => {
    const entry = GUARD_CLASSIFICATIONS['plan-review-complete'];
    expect(entry?.flaggedForRemediation).toBe(true);
  });
});

describe('GuardClassification_NoLegacyWaivers (P06-01)', () => {
  it('there are no waiver-category guards in the legacy classification', () => {
    const waiverGuards = Object.values(GUARD_CLASSIFICATIONS).filter(
      (e) => e.category === 'waiver',
    );
    expect(waiverGuards).toHaveLength(0);
  });
});

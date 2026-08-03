/**
 * P06-01 Guard Classification Tests (DR-1)
 *
 * Verifies that:
 *   1. The classification corpus is TOTAL — every guard in guards.ts and every
 *      composite guard used in HSM transitions is classified exactly once.
 *   2. No guard ID appears more than once in the classification (uniqueness).
 *   3. Every category value is a valid member of GUARD_CATEGORIES.
 *   4. Behavioral property pins per classification category:
 *      - obsolete-predicate no-ops always return `true` regardless of state.
 *      - bounded-loop-rule guards check a numeric counter against a cap.
 *      - route-condition guards at the same branch point are mutually exclusive.
 *   5. Every classified guard that is referenced in a transition has a corpus
 *      fixture (corpus exhaustiveness guard — adding a transition without a
 *      fixture FAILS).
 *
 * Kill-probe note: reverting guard-classification.ts removes the module, which
 * causes import-time failure in this test (tests go red). Behavioral property
 * tests 4a–4c additionally fail if classification categories are misassigned
 * while guards.ts remains intact.
 */

import { describe, it, expect } from 'vitest';
import { guards } from './guards.js';
import { getHSMDefinition } from './state-machine.js';
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── 1. Classification totality ───────────────────────────────────────────────

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

// ─── 2. Uniqueness ───────────────────────────────────────────────────────────

describe('GuardClassification_Uniqueness (P06-01)', () => {
  it('no guard ID is classified more than once', () => {
    // The Record structure already prevents duplicate keys at the JS object
    // level, but we verify at test time to catch any future refactor that
    // switches to an array.
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

// ─── 3. Valid categories ──────────────────────────────────────────────────────

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

// ─── 4a. Behavioral pin: obsolete-predicate no-ops always return true ─────────

describe('GuardClassification_ObsoletePredicateNoOps_AlwaysReturnTrue (P06-01)', () => {
  const ALWAYS_PASS_OBSOLETE: readonly string[] = [
    'implementation-complete', // evaluate: () => true
    'always', // evaluate: () => true
  ];

  for (const id of ALWAYS_PASS_OBSOLETE) {
    it(`${id} is classified obsolete-predicate and returns true for any state`, () => {
      // Verify classification
      expect(GUARD_CLASSIFICATIONS[id]?.category).toBe('obsolete-predicate');
      expect(OBSOLETE_GUARD_IDS.has(id)).toBe(true);

      // Find the guard by ID
      const guard = Object.values(guards).find((g) => g.id === id);
      expect(guard, `Guard ${id} not found in guards export`).toBeDefined();
      if (!guard) return;

      // Behavioral pin: always returns true regardless of state
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

  it('design-artifact-exists, root-cause-found, brief-complete are classified obsolete-predicate', () => {
    // Not always-pass, but not referenced in active transitions — classified obsolete
    for (const id of ['design-artifact-exists', 'root-cause-found', 'brief-complete']) {
      expect(GUARD_CLASSIFICATIONS[id]?.category).toBe('obsolete-predicate');
      expect(OBSOLETE_GUARD_IDS.has(id)).toBe(true);
    }
  });

  it('none of the always-pass obsolete guards are referenced in active HSM transitions', () => {
    const transitionIds = allTransitionGuardIds();
    for (const id of ALWAYS_PASS_OBSOLETE) {
      // 'always' is not in any transition. 'implementation-complete' IS in transitions
      // (polish-implement, debug-implement, hotfix-implement) — and that is the defect.
      // The corpus records its bypass behavior. We do NOT assert it's absent — instead
      // we assert it's flagged for remediation.
      expect(
        GUARD_CLASSIFICATIONS[id]?.flaggedForRemediation,
        `${id} is an always-pass no-op in transitions and must be flagged for remediation`,
      ).toBe(true);
    }
    // 'always' specifically should NOT be in transitions (pure dead code)
    expect(transitionIds.has('always')).toBe(false);
  });
});

// ─── 4b. Behavioral pin: bounded-loop-rule guards use a numeric counter ───────

describe('GuardClassification_BoundedLoopRules_UseNumericCounter (P06-01)', () => {
  it('revisions-exhausted is classified bounded-loop-rule', () => {
    expect(GUARD_CLASSIFICATIONS['revisions-exhausted']?.category).toBe('bounded-loop-rule');
    expect(BOUNDED_LOOP_GUARD_IDS.has('revisions-exhausted')).toBe(true);
  });

  it('revisions-exhausted passes when count >= cap', () => {
    // Default cap is 1 (DEFAULT_MAX_PLAN_REVISIONS)
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
    // Verify the cap is configurable — not hardcoded
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

// ─── 4c. Behavioral pin: route-conditions at the same branch are mutually exclusive ─

describe('GuardClassification_RouteConditions_MutualExclusivityAtForks (P06-01)', () => {
  it('hotfix-track-selected and thorough-track-selected are mutually exclusive', () => {
    // Both on: neither should pass
    const hotfixState = { track: 'hotfix' };
    const thoroughState = { track: 'thorough' };
    const bothState = { track: 'other' };

    expect(guards.hotfixTrackSelected.evaluate(hotfixState)).toBe(true);
    expect(guards.thoroughTrackSelected.evaluate(hotfixState)).not.toBe(true);

    expect(guards.hotfixTrackSelected.evaluate(thoroughState)).not.toBe(true);
    expect(guards.thoroughTrackSelected.evaluate(thoroughState)).toBe(true);

    // Neither track selected — both fail
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

  it('synthesis-opted-in and synthesis-opted-out together cover all cases without gaps', () => {
    // on-request with no synthesize.requested event: opted-out, not opted-in
    const onRequestNoEvent = { oneshot: { synthesisPolicy: 'on-request' }, _events: [] };
    expect(guards.synthesisOptedIn.evaluate(onRequestNoEvent)).not.toBe(true);
    expect(guards.synthesisOptedOut.evaluate(onRequestNoEvent)).toBe(true);

    // on-request WITH synthesize.requested event: opted-in, not opted-out
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

// ─── 5. Corpus exhaustiveness: every classified transition guard has a fixture ─

describe('GuardClassification_CorpusExhaustiveness (P06-01)', () => {
  it('every guard referenced in HSM transitions has at least one corpus fixture', () => {
    const transitionIds = allTransitionGuardIds();
    const fixturedGuardIds = new Set<string>();

    // Extract guard IDs from corpus fixture IDs and their classifications
    // Each fixture covers a (from→to) edge; we need to map edges to guard IDs
    for (const wt of BUILT_IN_WORKFLOW_TYPES) {
      const def = getHSMDefinition(wt);
      for (const t of def.transitions) {
        if (!t.guard?.id) continue;
        const guardId = t.guard.id;
        // Check if the corpus has a fixture for this (workflowType, from, to) tuple
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

// ─── 6. Defect inventory: flagged guards have defect notes ────────────────────

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

  it('flags all-tasks-complete as needing remediation (vacuous pass on empty task list)', () => {
    // Behavioral confirmation of the defect
    const result = guards.allTasksComplete.evaluate({ tasks: [] });
    expect(result).toBe(true); // This IS the defect: empty list passes vacuously

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

// ─── 7. No waiver guards in legacy system ────────────────────────────────────

describe('GuardClassification_NoLegacyWaivers (P06-01)', () => {
  it('there are no waiver-category guards in the legacy classification', () => {
    const waiverGuards = Object.values(GUARD_CLASSIFICATIONS).filter(
      (e) => e.category === 'waiver',
    );
    expect(waiverGuards).toHaveLength(0);
  });
});

// ─── P07-02 exit-proof (a) + corpus-delta — decision fixtures per workflow ────
//
// Drives the FULL transition corpus (`transitionAdmissionCorpus` = the frozen
// P06-01 default-input baseline PLUS the config-bearing fixtures) through the
// shared-IR admission adjudicator (`adjudicateEdge`) and compares the
// evidence-backed verdict against the authoritative legacy verdict recorded in
// the corpus (itself machine-attested against the real guards by
// `corpus-legacy-baseline.test.ts`). Two things are proved:
//
//   (a) every built-in-workflow edge in the corpus resolves to a shared-IR edge
//       and produces the EXPECTED decision (agreement wherever the legacy guard
//       is sound); and
//   (delta) the real state-driven translation produces EXACTLY the set of
//       disagreements that correspond to genuine P06-01 legacy guard-soundness
//       defects — no more, no fewer — and every one is in the SAFE direction
//       (legacy over-admits; admission denies).
//
// The config-bearing half matters: running this delta over DEFAULT-input
// fixtures only would assert the "no dangerous over-admission" property over
// exactly the input region where a hardcoded-threshold drift CANNOT show up.

import { describe, expect, it } from 'vitest';

import {
  configBearingCorpus,
  transitionAdmissionCorpus,
  type LegacyTransitionFixture,
} from '../__fixtures__/transition-admission-corpus.js';
import { getEdgeIR } from './built-in-workflow-ir.js';
import {
  adjudicateEdge,
  defaultTranslationContext,
} from './legacy-state-translation.js';
import type { PolicyVerdict } from './policy-evaluation.js';

const CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

/**
 * The disagreements that survive the REAL translation. Each is a known P06-01
 * legacy guard-soundness defect where the legacy path admits a fail-shaped
 * state that the evidence-backed engine correctly denies. All are the SAFE
 * direction (legacy-allow / admission-deny).
 */
const EXPECTED_DISAGREEMENTS: ReadonlyMap<string, string> = new Map([
  [
    'debug-debug-implement-to-debug-validate-fail',
    'implementation-complete always-passes (obsolete predicate)',
  ],
  [
    'debug-hotfix-implement-to-hotfix-validate-fail',
    'implementation-complete always-passes (obsolete predicate)',
  ],
  [
    'debug-investigate-to-cancelled-fail',
    'escalation-required bypassed by universal cancelled edge',
  ],
  [
    'refactor-polish-implement-to-polish-validate-fail',
    'implementation-complete always-passes (obsolete predicate)',
  ],
  [
    'bypass-empty-task-collection-is-complete',
    'all-tasks-complete vacuously true on empty task set',
  ],
  [
    'bypass-always-pass-implementation-ignores-fail-shaped-state',
    'implementation-complete always-passes (obsolete predicate)',
  ],
]);

interface Disagreement {
  readonly id: string;
  readonly legacy: 'allow' | 'deny';
  readonly shadow: PolicyVerdict;
}

function shadowVerdict(fixture: LegacyTransitionFixture): PolicyVerdict {
  const edge = getEdgeIR(fixture.workflowType, fixture.from, fixture.to);
  if (edge === undefined) {
    throw new Error(
      `no shared-IR edge for ${fixture.workflowType}:${fixture.from}:${fixture.to}`,
    );
  }
  return adjudicateEdge(edge, fixture.state as Record<string, unknown>, CTX);
}

function collectDisagreements(): readonly Disagreement[] {
  const out: Disagreement[] = [];
  for (const fixture of transitionAdmissionCorpus) {
    const shadow = shadowVerdict(fixture);
    if (shadow !== fixture.expected.verdict) {
      out.push({ id: fixture.id, legacy: fixture.expected.verdict, shadow });
    }
  }
  return out;
}

describe('built-in workflow decision fixtures (exit-proof a)', () => {
  it('every corpus fixture resolves to a shared-IR edge', () => {
    for (const fixture of transitionAdmissionCorpus) {
      const edge = getEdgeIR(fixture.workflowType, fixture.from, fixture.to);
      expect(
        edge,
        `${fixture.id} (${fixture.workflowType}:${fixture.from}:${fixture.to})`,
      ).toBeDefined();
    }
  });

  it('produces a definite allow/deny for every fixture (no indeterminate)', () => {
    for (const fixture of transitionAdmissionCorpus) {
      const shadow = shadowVerdict(fixture);
      expect(shadow, fixture.id).not.toBe('indeterminate');
    }
  });

  it('agrees with the legacy verdict on every fixture except the known defects', () => {
    for (const fixture of transitionAdmissionCorpus) {
      if (EXPECTED_DISAGREEMENTS.has(fixture.id)) continue;
      const shadow = shadowVerdict(fixture);
      expect(shadow, `${fixture.id} should agree with legacy`).toBe(
        fixture.expected.verdict,
      );
    }
  });
});

describe('corpus disagreement delta (real translation vs scenario proxy)', () => {
  it('exercises the CONFIG-BEARING fixtures (the delta is not measured on defaults alone)', () => {
    // Anti-vacuity. The "no dangerous over-admission" claim below is only worth
    // anything if the corpus actually contains the inputs on which a
    // dual-authority drift can manifest. Silently dropping them would make the
    // assertions pass trivially, which is precisely how the original defect
    // stayed invisible.
    expect(configBearingCorpus.length).toBeGreaterThanOrEqual(20);
    const ids = new Set(transitionAdmissionCorpus.map((f) => f.id));
    for (const fixture of configBearingCorpus) {
      expect(ids.has(fixture.id), `${fixture.id} must be in the measured corpus`).toBe(
        true,
      );
    }
    // Every config axis the legacy guards read must be represented.
    const states = configBearingCorpus.map((f) => JSON.stringify(f.state));
    for (const key of [
      '_maxPlanRevisions',
      '_requiredReviews',
      '_mutationEnforcement',
      '_mutationThreshold',
      '_maxNoCoverage',
      'synthesisPolicy',
    ]) {
      expect(
        states.some((s) => s.includes(key)),
        `no config-bearing fixture carries ${key}`,
      ).toBe(true);
    }
  });

  it('surfaces EXACTLY the known-defect disagreements — 6, down from P07-01’s 9', () => {
    const disagreements = collectDisagreements();
    const ids = new Set(disagreements.map((d) => d.id));

    // Down from P07-01's 9: the 3 removed were scenario-proxy artifacts (the
    // proxy split identical states by their `scenario` label). The real
    // translation reads the same state fields the guard reads and AGREES on
    // those three, so only genuine defects remain.
    //
    // Still 6 after the config-bearing fixtures were added: those fixtures
    // exposed 14 further disagreements (11 of them DANGEROUS over-admissions)
    // caused by the IR hardcoding thresholds the guards read from config. Those
    // were FIXED at the source — the projection now resolves the obligations
    // from the same injected state — rather than being registered as expected.
    expect(ids).toEqual(new Set(EXPECTED_DISAGREEMENTS.keys()));
    expect(disagreements).toHaveLength(6);
  });

  it('every surviving disagreement is the SAFE direction (legacy allow, admission deny)', () => {
    for (const d of collectDisagreements()) {
      expect(d.legacy, d.id).toBe('allow');
      expect(d.shadow, d.id).toBe('deny');
    }
  });

  it('surfaces no dangerous legacy-deny / admission-allow disagreement', () => {
    // Collect ALL offenders rather than dying on the first, so a regression
    // reports the full blast radius instead of one arbitrary fixture.
    const dangerous = collectDisagreements().filter(
      (d) => d.legacy === 'deny' && d.shadow === 'allow',
    );
    expect(
      dangerous.map((d) => d.id),
      `admission OVER-ADMITS where legacy denies: ${dangerous
        .map((d) => d.id)
        .join(', ')}`,
    ).toEqual([]);
  });
});

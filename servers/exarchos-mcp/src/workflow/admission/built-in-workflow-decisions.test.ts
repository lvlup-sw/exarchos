// ─── P07-02 exit-proof (a) + corpus-delta — decision fixtures per workflow ────
//
// Drives the FROZEN P06-01 legacy transition corpus (`legacyTransitionCorpus`)
// through the shared-IR admission adjudicator (`adjudicateEdge`) and compares
// the evidence-backed verdict against the authoritative legacy verdict recorded
// in the corpus. Two things are proved:
//
//   (a) every built-in-workflow edge in the corpus resolves to a shared-IR edge
//       and produces the EXPECTED decision (agreement wherever the legacy guard
//       is sound); and
//   (delta) the real state-driven translation produces EXACTLY the set of
//       disagreements that correspond to genuine P06-01 legacy guard-soundness
//       defects — no more, no fewer — and every one is in the SAFE direction
//       (legacy over-admits; admission denies).

import { describe, expect, it } from 'vitest';

import {
  legacyTransitionCorpus,
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
  for (const fixture of legacyTransitionCorpus) {
    const shadow = shadowVerdict(fixture);
    if (shadow !== fixture.expected.verdict) {
      out.push({ id: fixture.id, legacy: fixture.expected.verdict, shadow });
    }
  }
  return out;
}

describe('built-in workflow decision fixtures (exit-proof a)', () => {
  it('every corpus fixture resolves to a shared-IR edge', () => {
    for (const fixture of legacyTransitionCorpus) {
      const edge = getEdgeIR(fixture.workflowType, fixture.from, fixture.to);
      expect(
        edge,
        `${fixture.id} (${fixture.workflowType}:${fixture.from}:${fixture.to})`,
      ).toBeDefined();
    }
  });

  it('produces a definite allow/deny for every fixture (no indeterminate)', () => {
    for (const fixture of legacyTransitionCorpus) {
      const shadow = shadowVerdict(fixture);
      expect(shadow, fixture.id).not.toBe('indeterminate');
    }
  });

  it('agrees with the legacy verdict on every fixture except the known defects', () => {
    for (const fixture of legacyTransitionCorpus) {
      if (EXPECTED_DISAGREEMENTS.has(fixture.id)) continue;
      const shadow = shadowVerdict(fixture);
      expect(shadow, `${fixture.id} should agree with legacy`).toBe(
        fixture.expected.verdict,
      );
    }
  });
});

describe('corpus disagreement delta (real translation vs scenario proxy)', () => {
  it('surfaces EXACTLY the known-defect disagreements — 6, down from P07-01’s 9', () => {
    const disagreements = collectDisagreements();
    const ids = new Set(disagreements.map((d) => d.id));

    // Down from P07-01's 9: the 3 removed were scenario-proxy artifacts (the
    // proxy split identical states by their `scenario` label). The real
    // translation reads the same state fields the guard reads and AGREES on
    // those three, so only genuine defects remain.
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
    for (const d of collectDisagreements()) {
      expect(
        d.legacy === 'deny' && d.shadow === 'allow',
        `${d.id} must not be a dangerous over-admission`,
      ).toBe(false);
    }
  });
});

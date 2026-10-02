// Runs the full transition corpus through the shared-IR adjudicator
// `adjudicateEdge` and compares each verdict with the legacy verdict that the
// corpus records. `corpus-legacy-baseline.test.ts` checks those legacy verdicts
// against the real guards. Every corpus edge resolves to a shared-IR edge and
// agrees with the legacy verdict, except the known legacy guard defects. Each
// defect is in the safe direction: legacy allows and admission denies. The
// corpus holds config-bearing fixtures because threshold drift does not show on
// default inputs.

import { describe, expect, it } from 'vitest';

import {
  configBearingCorpus,
  transitionAdmissionCorpus,
  type LegacyTransitionFixture,
} from '../__fixtures__/transition-admission-corpus.js';
import { getEdgeIR } from '../../../../src/workflow/admission/built-in-workflow-ir.js';
import {
  adjudicateEdge,
  defaultTranslationContext,
} from '../../../../src/workflow/admission/legacy-state-translation.js';
import type { PolicyVerdict } from '../../../../src/workflow/admission/policy-evaluation.js';

const CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

/**
 * The disagreements that remain under the real translation. Each is a known
 * legacy guard defect: the legacy path admits a fail-shaped state and the
 * evidence-backed engine denies it.
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
  /**
   * The over-admission checks below mean nothing unless the corpus holds the
   * inputs where a dual-authority drift shows. Each config axis that the legacy
   * guards read must appear.
   */
  it('exercises the CONFIG-BEARING fixtures (the delta is not measured on defaults alone)', () => {
    expect(configBearingCorpus.length).toBeGreaterThanOrEqual(20);
    const ids = new Set(transitionAdmissionCorpus.map((f) => f.id));
    for (const fixture of configBearingCorpus) {
      expect(ids.has(fixture.id), `${fixture.id} must be in the measured corpus`).toBe(
        true,
      );
    }
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

  /**
   * The real translation reads the same state fields as the guards, and the IR
   * resolves config thresholds from the same injected state. So only the known
   * legacy guard defects disagree.
   */
  it('surfaces EXACTLY the known-defect disagreements — 6, down from P07-01’s 9', () => {
    const disagreements = collectDisagreements();
    const ids = new Set(disagreements.map((d) => d.id));

    expect(ids).toEqual(new Set(EXPECTED_DISAGREEMENTS.keys()));
    expect(disagreements).toHaveLength(6);
  });

  it('every surviving disagreement is the SAFE direction (legacy allow, admission deny)', () => {
    for (const d of collectDisagreements()) {
      expect(d.legacy, d.id).toBe('allow');
      expect(d.shadow, d.id).toBe('deny');
    }
  });

  /** Collects every offender, so a regression reports all of them and not only the first. */
  it('surfaces no dangerous legacy-deny / admission-allow disagreement', () => {
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

// ─── Dual-authority differential — admission vs the REAL legacy guards ────────
//
// The corpus proves agreement on a FIXED set of fixtures. That is necessary but
// not sufficient: the defect this test exists to prevent is a THRESHOLD that the
// legacy guard reads from injected config while the admission IR hardcodes a
// constant. Such a drift is invisible on any corpus generated from default /
// no-config inputs — the constant and the config agree exactly there — so a
// fixture list can assert the safety property over a set on which it cannot
// fail.
//
// This test instead ENUMERATES the config space and compares the two authorities
// pointwise:
//
//   legacy   = executeTransition(realHSM, state, to).success    (guards.ts)
//   admission = adjudicateEdge(sharedIR, state, ctx)            (the shadow)
//
// and asserts admission NEVER admits where legacy denies (the unsafe direction),
// and — for the edges whose obligations are config-derived — that the two agree
// outright. It also asserts LIVENESS: for every oneshot policy/event
// combination, at least one outbound edge of `implementing` is admitted, so the
// shadow authority can never deadlock a workflow the legacy path can advance.
//
// Like `corpus-legacy-baseline.test.ts`, this is a TEST that deliberately
// imports the legacy guard path — that import is what makes it a cross-check.
// The production shared-IR modules stay structurally guard-free
// (`built-in-workflow-ir.structure.test.ts`).

import { describe, expect, it } from 'vitest';

import { getEdgeIR, type WorkflowEdgeIR } from './built-in-workflow-ir.js';
import {
  adjudicateEdge,
  defaultTranslationContext,
  projectStateToFacts,
} from './legacy-state-translation.js';
import { executeTransition, getHSMDefinition } from '../state-machine.js';

const CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

interface EdgeRef {
  readonly workflowType: string;
  readonly from: string;
  readonly to: string;
}

function edgeIR(ref: EdgeRef): WorkflowEdgeIR {
  const edge = getEdgeIR(ref.workflowType, ref.from, ref.to);
  if (edge === undefined) {
    throw new Error(`no shared-IR edge for ${ref.workflowType}:${ref.from}:${ref.to}`);
  }
  return edge;
}

function legacyAllows(ref: EdgeRef, state: Record<string, unknown>): boolean {
  const hsm = getHSMDefinition(ref.workflowType);
  return executeTransition(hsm, { ...state, phase: ref.from }, ref.to).success;
}

function admissionAllows(ref: EdgeRef, state: Record<string, unknown>): boolean {
  return adjudicateEdge(edgeIR(ref), state, CTX) === 'allow';
}

/**
 * The load-bearing assertion. `admission allows ⇒ legacy allows` is the SAFETY
 * property (no over-admission). Where the obligation is config-derived we demand
 * full agreement, because a spurious admission-deny on a configured repo is a
 * liveness bug the cutover would ship.
 */
function expectAgreement(
  ref: EdgeRef,
  state: Record<string, unknown>,
  label: string,
): void {
  const legacy = legacyAllows(ref, state);
  const admission = admissionAllows(ref, state);
  expect(
    admission,
    `${label} — legacy ${legacy ? 'ALLOW' : 'DENY'} vs admission ` +
      `${admission ? 'ALLOW' : 'DENY'} on ${JSON.stringify(state)}`,
  ).toBe(legacy);
}

const FEATURE_BLOCKED: EdgeRef = {
  workflowType: 'feature',
  from: 'plan-review',
  to: 'blocked',
};
const REFACTOR_BLOCKED: EdgeRef = {
  workflowType: 'refactor',
  from: 'overhaul-plan-review',
  to: 'blocked',
};
const FEATURE_SYNTHESIZE: EdgeRef = {
  workflowType: 'feature',
  from: 'review',
  to: 'synthesize',
};
const ONESHOT_PLAN: EdgeRef = {
  workflowType: 'oneshot',
  from: 'plan',
  to: 'implementing',
};
const ONESHOT_SYNTHESIZE: EdgeRef = {
  workflowType: 'oneshot',
  from: 'implementing',
  to: 'synthesize',
};
const ONESHOT_DIRECT_COMMIT: EdgeRef = {
  workflowType: 'oneshot',
  from: 'implementing',
  to: 'completed',
};

// ─── DEFECT 1(a) — the plan-revision cap is CONFIG, not a constant ────────────

describe('plan-revision cap: admission reads the same injected cap as the guard', () => {
  const caps: readonly (number | undefined)[] = [undefined, 0, 1, 2, 3, 5];
  const counts: readonly number[] = [0, 1, 2, 3, 5, 6];

  for (const ref of [FEATURE_BLOCKED, REFACTOR_BLOCKED]) {
    it(`agrees across every (cap × revisionCount) pair — ${ref.workflowType}`, () => {
      for (const cap of caps) {
        for (const count of counts) {
          const state: Record<string, unknown> = {
            planReview: { revisionCount: count },
            ...(cap === undefined ? {} : { _maxPlanRevisions: cap }),
          };
          expectAgreement(ref, state, `cap=${String(cap)} count=${count}`);
        }
      }
    });
  }

  it('the projected cap tracks the injected value (not a frozen constant)', () => {
    // Directly pins the seam: had the cap stayed hardcoded, this fact would be
    // 1 regardless of config and the comparison above would over-admit.
    expect(projectStateToFacts({}).fields['policy.maxPlanRevisions']).toBe(1);
    expect(
      projectStateToFacts({ _maxPlanRevisions: 3 }).fields['policy.maxPlanRevisions'],
    ).toBe(3);
    expect(
      projectStateToFacts({ planReview: { revisionCount: 1 }, _maxPlanRevisions: 3 })
        .fields['planReview.revisionsExhausted'],
    ).toBe(false);
    expect(
      projectStateToFacts({ planReview: { revisionCount: 1 } }).fields[
        'planReview.revisionsExhausted'
      ],
    ).toBe(true);
  });

  it('a non-numeric injected cap falls back to the guard default of 1', () => {
    for (const bad of ['3', null, Number.NaN, {}]) {
      expectAgreement(
        FEATURE_BLOCKED,
        { planReview: { revisionCount: 1 }, _maxPlanRevisions: bad },
        `malformed cap ${JSON.stringify(bad)}`,
      );
    }
  });
});

// ─── DEFECT 1(b) — required review dimensions + mutation enforcement ──────────

describe('all-reviews-passed: admission enforces the same resolved obligations', () => {
  it('agrees across required-review-dimension permutations', () => {
    const reviewSets: readonly Record<string, unknown>[] = [
      { quality: { status: 'approved' } },
      { quality: { status: 'approved' }, security: { status: 'pass' } },
      { quality: { status: 'approved' }, security: {} },
      { quality: { status: 'approved' }, security: { status: 'failed' } },
      { quality: { passed: true }, security: { passed: true } },
      { quality: { verdict: 'PASS' }, security: { verdict: 'APPROVED' } },
      {},
    ];
    const requiredSets: readonly (readonly string[] | undefined)[] = [
      undefined,
      [],
      ['quality'],
      ['quality', 'security'],
      ['quality', 'security', 'performance'],
    ];
    for (const reviews of reviewSets) {
      for (const required of requiredSets) {
        const state: Record<string, unknown> = {
          reviews,
          ...(required === undefined ? {} : { _requiredReviews: required }),
        };
        expectAgreement(
          FEATURE_SYNTHESIZE,
          state,
          `reviews=${JSON.stringify(reviews)} required=${JSON.stringify(required)}`,
        );
      }
    }
  });

  it('agrees across HIGH-tier mutation score / NoCoverage enforcement', () => {
    const dims: readonly Record<string, unknown>[] = [
      { status: 'pass', mutationScore: 95, noCoverage: 0 },
      { status: 'pass', mutationScore: 42, noCoverage: 0 },
      { status: 'pass', mutationScore: 95, noCoverage: 7 },
      { status: 'pass', mutationScore: Number.NaN, noCoverage: 0 },
      { status: 'pass', degraded: true },
      { status: 'pass', skipped: true },
      { status: 'pass' },
    ];
    const enforcement: readonly (string | undefined)[] = [
      undefined,
      'advisory',
      'block',
    ];
    const thresholds: readonly (number | undefined)[] = [undefined, 80];
    const budgets: readonly (number | undefined)[] = [undefined, 0, 2];

    for (const dim of dims) {
      for (const mode of enforcement) {
        for (const threshold of thresholds) {
          for (const budget of budgets) {
            const state: Record<string, unknown> = {
              riskTier: 'high',
              reviews: { quality: { status: 'pass' }, 'mutation-adequacy': dim },
              ...(mode === undefined ? {} : { _mutationEnforcement: mode }),
              ...(threshold === undefined ? {} : { _mutationThreshold: threshold }),
              ...(budget === undefined ? {} : { _maxNoCoverage: budget }),
            };
            expectAgreement(
              FEATURE_SYNTHESIZE,
              state,
              `dim=${JSON.stringify(dim)} mode=${String(mode)} ` +
                `threshold=${String(threshold)} budget=${String(budget)}`,
            );
          }
        }
      }
    }
  });

  it('keeps the WEAKER debug review-passed contract on its own fact', () => {
    // `reviewPassed` (debug) does NOT read `_requiredReviews`; collapsing both
    // guards onto one fact would make one of the two edges wrong.
    const state = {
      reviews: { quality: { status: 'pass' } },
      _requiredReviews: ['quality', 'security'],
    };
    const facts = projectStateToFacts(state);
    expect(facts.fields['reviews.allPassed']).toBe(true);
    expect(facts.fields['reviews.requiredSatisfied']).toBe(false);
    expectAgreement(
      { workflowType: 'debug', from: 'debug-review', to: 'synthesize' },
      state,
      'debug review-passed ignores _requiredReviews',
    );
  });
});

// ─── DEFECT 1(c) — oneshot plan must be a TRIMMED NON-EMPTY STRING ────────────

describe('oneshot-plan-set: admission demands the same value SHAPE as the guard', () => {
  it('agrees across every plan value shape', () => {
    const plans: readonly unknown[] = [
      undefined,
      null,
      '',
      '   ',
      '\t\n ',
      'docs/plan.md',
      '  docs/plan.md  ',
      true,
      false,
      0,
      1,
      {},
      { path: 'docs/plan.md' },
      [],
      ['docs/plan.md'],
    ];
    for (const plan of plans) {
      expectAgreement(
        ONESHOT_PLAN,
        { artifacts: { plan } },
        `artifacts.plan=${JSON.stringify(plan) ?? 'undefined'}`,
      );
    }
  });

  it('holds the feature plan-artifact edge to the SAME typed-reference contract', () => {
    // DR-5 (T-08): `planArtifactExists` used to accept ANY non-null value, so
    // this test asserted the feature edge stayed loose while oneshot was
    // tightened. That divergence WAS the defect — `artifacts.plan = true`
    // satisfied a phase gate on the shipped transition path. Both surfaces now
    // demand a typed artifact reference (a trimmed non-empty string), and the
    // projection was tightened alongside so admission does not over-admit.
    const FEATURE_PLAN: EdgeRef = { workflowType: 'feature', from: 'plan', to: 'plan-review' };
    for (const plan of [true, false, 0, 1, {}, [], '', '   ', '\t\n ']) {
      expect(
        legacyAllows(FEATURE_PLAN, { artifacts: { plan } }),
        `feature plan-artifact must DENY ${JSON.stringify(plan)}`,
      ).toBe(false);
      expectAgreement(
        FEATURE_PLAN,
        { artifacts: { plan } },
        `feature plan-artifact rejects ${JSON.stringify(plan)}`,
      );
    }
    for (const plan of ['docs/plan.md', '  docs/plan.md  ']) {
      expect(
        legacyAllows(FEATURE_PLAN, { artifacts: { plan } }),
        `feature plan-artifact must ALLOW ${JSON.stringify(plan)}`,
      ).toBe(true);
      expectAgreement(
        FEATURE_PLAN,
        { artifacts: { plan } },
        `feature plan-artifact accepts ${JSON.stringify(plan)}`,
      );
    }
  });
});

// ─── DEFECT 2 — the oneshot synthesis branch, including the DEFAULT policy ────

describe('oneshot synthesis branch: agreement AND liveness', () => {
  const policies: readonly (string | undefined)[] = [
    undefined,
    'always',
    'never',
    'on-request',
    'sometimes', // unrecognized → collapses to the on-request default
  ];
  const eventSets: readonly Record<string, unknown>[][] = [
    [],
    [{ type: 'synthesize.requested' }],
    [{ type: 'task.completed' }],
    [{ type: 'task.completed' }, { type: 'synthesize.requested' }],
  ];

  function oneshotState(
    policy: string | undefined,
    events: readonly Record<string, unknown>[],
  ): Record<string, unknown> {
    return {
      ...(policy === undefined ? {} : { oneshot: { synthesisPolicy: policy } }),
      _events: events,
    };
  }

  it('agrees on BOTH outbound edges for every (policy × events) pair', () => {
    for (const policy of policies) {
      for (const events of eventSets) {
        const state = oneshotState(policy, events);
        const label = `policy=${String(policy)} events=${JSON.stringify(
          events.map((e) => e['type']),
        )}`;
        expectAgreement(ONESHOT_SYNTHESIZE, state, `${label} → synthesize`);
        expectAgreement(ONESHOT_DIRECT_COMMIT, state, `${label} → completed`);
      }
    }
  });

  it('NEVER deadlocks: some outbound edge of `implementing` is always admitted', () => {
    for (const policy of policies) {
      for (const events of eventSets) {
        const state = oneshotState(policy, events);
        const label = `policy=${String(policy)} events=${JSON.stringify(
          events.map((e) => e['type']),
        )}`;
        const synthesize = admissionAllows(ONESHOT_SYNTHESIZE, state);
        const direct = admissionAllows(ONESHOT_DIRECT_COMMIT, state);
        expect(
          synthesize || direct,
          `${label}: admission denied BOTH outbound edges — the workflow ` +
            `would deadlock under the shadow authority`,
        ).toBe(true);
        // The two branches are mutually exclusive (a choice state).
        expect(synthesize && direct, `${label}: both branches admitted`).toBe(false);
      }
    }
  });

  it('defaults a missing/unrecognized policy to on-request, as the guard does', () => {
    expect(projectStateToFacts({}).fields['oneshot.synthesisPolicy']).toBe(
      'on-request',
    );
    expect(
      projectStateToFacts({ oneshot: { synthesisPolicy: 'sometimes' } }).fields[
        'oneshot.synthesisPolicy'
      ],
    ).toBe('on-request');
    expect(
      projectStateToFacts({ oneshot: { synthesisPolicy: 'never' } }).fields[
        'oneshot.synthesisPolicy'
      ],
    ).toBe('never');
  });

  it('treats `never` as an ABSOLUTE opt-out (a stray request event cannot reopen it)', () => {
    const state = oneshotState('never', [{ type: 'synthesize.requested' }]);
    expect(legacyAllows(ONESHOT_SYNTHESIZE, state)).toBe(false);
    expect(admissionAllows(ONESHOT_SYNTHESIZE, state)).toBe(false);
  });
});

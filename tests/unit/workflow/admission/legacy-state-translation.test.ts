// ─── P07-02 exit-proof (d) — real legacy-state → admission-evidence translation ─
//
// Proves the translation produces GENUINE, content-addressed admission evidence
// records (not the P07-01 scenario proxy), and that the projection reads real
// legacy state the way the legacy guards do. The load-bearing anti-tautology
// property is that adjudication is scenario-BLIND: identical legacy state always
// yields identical evidence and an identical verdict — so a shadow disagreement
// reflects a genuine legacy/admission divergence, never a proxy label.

import { describe, expect, it } from 'vitest';

import { getEdgeIR } from '../../../../src/workflow/admission/built-in-workflow-ir.js';
import { EvidenceSubjectV1Schema } from '../../../../src/workflow/admission/types.js';
import {
  adjudicateEdge,
  defaultTranslationContext,
  factsDigest,
  projectStateToFacts,
  translateEdgeAdmission,
  TRANSLATION_PRODUCER_ID,
  TRANSLATION_PROVIDER_REF,
  TRANSLATION_POLICY_ID,
} from '../../../../src/workflow/admission/legacy-state-translation.js';

const EVAL_AT = '2025-01-01T00:00:00.000Z';
const CTX = defaultTranslationContext(EVAL_AT);
const HEX64 = /^[a-f0-9]{64}$/;

function gateEdge() {
  const edge = getEdgeIR('feature', 'plan', 'plan-review');
  if (!edge) throw new Error('missing feature plan→plan-review edge');
  return edge;
}
function approvalEdge() {
  const edge = getEdgeIR('feature', 'plan-review', 'delegate');
  if (!edge) throw new Error('missing feature plan-review→delegate edge');
  return edge;
}

describe('projectStateToFacts — reads real legacy state', () => {
  it('projects boolean facts DEFINITELY (absent → definite false)', () => {
    const facts = projectStateToFacts({});
    expect(facts.fields['planReview.approved']).toBe(false);
    expect(facts.fields['validation.testsPass']).toBe(false);
    expect(facts.fields['implementation.complete']).toBe(false);
  });

  it('coerces non-true boolean shapes to false (mirrors legacy === true)', () => {
    const facts = projectStateToFacts({ planReview: { approved: 'yes' } });
    expect(facts.fields['planReview.approved']).toBe(false);
    const facts2 = projectStateToFacts({ planReview: { approved: true } });
    expect(facts2.fields['planReview.approved']).toBe(true);
  });

  it('projects counters definitely (default 0) and presence facts only when present', () => {
    const empty = projectStateToFacts({});
    expect(empty.fields['tasks.count']).toBe(0);
    expect(empty.fields['planReview.revisionCount']).toBe(0);
    expect(empty.fields['artifacts.plan']).toBeUndefined();

    const withPlan = projectStateToFacts({ artifacts: { plan: 'docs/x.md' } });
    expect(withPlan.fields['artifacts.plan']).toBe('docs/x.md');
  });

  it('projects routing selectors definitely (absent → empty-string sentinel)', () => {
    expect(projectStateToFacts({}).fields['track']).toBe('');
    expect(projectStateToFacts({ track: 'hotfix' }).fields['track']).toBe('hotfix');
  });

  it('resolves CONFIG-BEARING obligations from the same injected state the guards read', () => {
    // The single-authority seam. Each of these facts is a RESOLVED obligation,
    // not a raw state read — the shared IR consumes them instead of hardcoding
    // the threshold, so admission cannot drift toward over-admission on a
    // configured project.
    const configured = projectStateToFacts({
      planReview: { revisionCount: 1 },
      _maxPlanRevisions: 3,
    });
    expect(configured.fields['policy.maxPlanRevisions']).toBe(3);
    expect(configured.fields['planReview.revisionsExhausted']).toBe(false);

    const defaulted = projectStateToFacts({ planReview: { revisionCount: 1 } });
    expect(defaulted.fields['policy.maxPlanRevisions']).toBe(1);
    expect(defaulted.fields['planReview.revisionsExhausted']).toBe(true);
  });

  it('projects artifact fields as TYPED REFERENCES, not bare presence', () => {
    // DR-5 (T-08): `oneshotPlanSet` AND `planArtifactExists` (and the rca /
    // fixDesign / report guards) now share one contract — a trimmed non-empty
    // string. The projection must not hand the admission engine a `<present>`
    // sentinel for a value the shipped transition path denies, or admission
    // over-admits relative to the legacy authority.
    for (const plan of [true, false, {}, 0, '   ', '']) {
      const facts = projectStateToFacts({ artifacts: { plan } });
      expect(facts.fields['artifacts.planNonEmpty'], JSON.stringify(plan)).toBe(false);
      expect(facts.fields['artifacts.plan'], JSON.stringify(plan)).toBeUndefined();
    }
    const ok = projectStateToFacts({ artifacts: { plan: '  docs/plan.md  ' } });
    expect(ok.fields['artifacts.planNonEmpty']).toBe(true);
    expect(ok.fields['artifacts.plan']).toBe('  docs/plan.md  ');
    // Same narrowing on every other artifact probe and on the legacy
    // top-level `plan` fallback.
    for (const field of ['plan', 'rca', 'fixDesign', 'report']) {
      expect(
        projectStateToFacts({ artifacts: { [field]: true } }).fields[`artifacts.${field}`],
        field,
      ).toBeUndefined();
      expect(
        projectStateToFacts({ artifacts: { [field]: 'docs/x.md' } }).fields[
          `artifacts.${field}`
        ],
        field,
      ).toBe('docs/x.md');
    }
    expect(projectStateToFacts({ plan: true }).fields['plan']).toBeUndefined();
    expect(projectStateToFacts({ plan: 'docs/plan.md' }).fields['plan']).toBe('docs/plan.md');
  });

  it('defaults a missing oneshot synthesis policy to on-request (not a sentinel)', () => {
    // An `''` sentinel matches NO branch, which denied both outbound edges of
    // `implementing` and deadlocked the DEFAULT oneshot flow.
    expect(projectStateToFacts({}).fields['oneshot.synthesisPolicy']).toBe(
      'on-request',
    );
    expect(
      projectStateToFacts({ oneshot: { synthesisPolicy: 'bogus' } }).fields[
        'oneshot.synthesisPolicy'
      ],
    ).toBe('on-request');
    expect(
      projectStateToFacts({ oneshot: { synthesisPolicy: 'always' } }).fields[
        'oneshot.synthesisPolicy'
      ],
    ).toBe('always');
  });

  it('folds required-review dimensions and mutation enforcement into ONE obligation fact', () => {
    const missingDimension = projectStateToFacts({
      reviews: { quality: { status: 'approved' } },
      _requiredReviews: ['quality', 'security'],
    });
    expect(missingDimension.fields['reviews.allPassed']).toBe(true);
    expect(missingDimension.fields['reviews.requiredSatisfied']).toBe(false);

    const blockedByScore = projectStateToFacts({
      reviews: {
        quality: { status: 'pass' },
        'mutation-adequacy': { status: 'pass', mutationScore: 42 },
      },
      _mutationEnforcement: 'block',
      _mutationThreshold: 80,
    });
    expect(blockedByScore.fields['reviews.requiredSatisfied']).toBe(false);

    const advisory = projectStateToFacts({
      reviews: {
        quality: { status: 'pass' },
        'mutation-adequacy': { status: 'pass', mutationScore: 42 },
      },
      _mutationEnforcement: 'advisory',
      _mutationThreshold: 80,
    });
    expect(advisory.fields['reviews.requiredSatisfied']).toBe(true);
  });

  it('mirrors the legacy nested / legacy-`passed` review shapes', () => {
    const nested = projectStateToFacts({
      reviews: { A1: { specReview: { status: 'pass' }, qualityReview: { verdict: 'APPROVED' } } },
    });
    expect(nested.fields['reviews.allPassed']).toBe(true);

    const legacyPassed = projectStateToFacts({ reviews: { a: { passed: false } } });
    expect(legacyPassed.fields['reviews.allPassed']).toBe(false);
    expect(legacyPassed.fields['reviews.anyFailed']).toBe(true);
  });

  it('derives review status from the legacy status/verdict vocabulary', () => {
    const passed = projectStateToFacts({
      reviews: { a: { status: 'approved' }, b: { verdict: 'PASS' } },
    });
    expect(passed.fields['reviews.allPassed']).toBe(true);
    expect(passed.fields['reviews.anyFailed']).toBe(false);

    const failed = projectStateToFacts({ reviews: { a: { status: 'failed' } } });
    expect(failed.fields['reviews.allPassed']).toBe(false);
    expect(failed.fields['reviews.anyFailed']).toBe(true);
  });

  it('derives task completion and merge-pending readiness from real state', () => {
    const tasks = projectStateToFacts({
      tasks: [{ status: 'complete' }, { status: 'complete' }],
    });
    expect(tasks.fields['tasks.count']).toBe(2);
    expect(tasks.fields['tasks.allComplete']).toBe(true);

    const entry = projectStateToFacts({
      _events: [{ type: 'task.completed', data: { worktree: '.worktrees/t1' } }],
    });
    expect(entry.fields['mergePending.entryReady']).toBe(true);
    expect(entry.events).toContain('task.completed');

    const noWorktree = projectStateToFacts({
      _events: [{ type: 'task.completed', data: {} }],
    });
    expect(noWorktree.fields['mergePending.entryReady']).toBe(false);
  });
});

describe('translateEdgeAdmission — mints genuine evidence, not a scenario proxy', () => {
  it('mints a gate-evidence record with real content-addressed provenance', () => {
    const t = translateEdgeAdmission(
      gateEdge(),
      { artifacts: { plan: 'docs/x.md' } },
      CTX,
    );
    expect(t.requirements).toHaveLength(1);
    expect(t.evidence).toHaveLength(1);
    const req = t.requirements[0];
    const ev = t.evidence[0];
    expect(req?.kind).toBe('gate-evidence');
    expect(ev?.kind).toBe('gate');
    if (ev?.kind !== 'gate') throw new Error('expected gate evidence');

    // Real provenance — a producer, a policy, a fresh timestamp.
    expect(ev.producer.producerId).toBe(TRANSLATION_PRODUCER_ID);
    expect(ev.producer.providerRef).toBe(TRANSLATION_PROVIDER_REF);
    expect(ev.policyId).toBe(TRANSLATION_POLICY_ID);
    expect(ev.createdAt).toBe(EVAL_AT);
    expect(ev.verdict).toBe('pass');

    // Genuine content-addressing — sha256 digests, not a scenario label.
    expect(ev.contentDigest.algorithm).toBe('sha256');
    expect(ev.contentDigest.value).toMatch(HEX64);
    expect(ev.subject.digest.value).toMatch(HEX64);
    expect(ev.policyDigest.value).toMatch(HEX64);
  });

  it('mints an approval record attributed to the translation principal', () => {
    const t = translateEdgeAdmission(
      approvalEdge(),
      { planReview: { approved: true } },
      CTX,
    );
    const ev = t.evidence[0];
    expect(ev?.kind).toBe('approval');
    if (ev?.kind !== 'approval') throw new Error('expected approval evidence');
    expect(ev.verdict).toBe('approved');
    expect(ev.attributedTo.principalId).toBe(TRANSLATION_PRODUCER_ID);
    expect(ev.attributedTo.principalKind).toBe('service');
  });

  it('mints NO satisfying evidence for a fail-shaped state (fails closed)', () => {
    const t = translateEdgeAdmission(gateEdge(), {}, CTX);
    expect(t.requirements).toHaveLength(1); // the obligation is still declared
    expect(t.evidence).toHaveLength(0); // but nothing certifies it
    expect(t.presence).toBe('false');
  });

  it('content digest is state-derived: different state → different digest', () => {
    const a = translateEdgeAdmission(gateEdge(), { artifacts: { plan: 'a' } }, CTX);
    const b = translateEdgeAdmission(gateEdge(), { artifacts: { plan: 'b' } }, CTX);
    const da = a.evidence[0]?.contentDigest.value;
    const db = b.evidence[0]?.contentDigest.value;
    expect(da).toMatch(HEX64);
    expect(db).toMatch(HEX64);
    expect(da).not.toBe(db); // content-addressed, not a fixed proxy token
  });

  it('does not throw on any corpus-shaped valid state', () => {
    expect(() =>
      translateEdgeAdmission(gateEdge(), { artifacts: { plan: 'x' } }, CTX),
    ).not.toThrow();
    expect(() => translateEdgeAdmission(gateEdge(), {}, CTX)).not.toThrow();
  });

  it('builds the evidence subject through the SCHEMA, not an `as` assertion', () => {
    // The subject used to be produced by `{...} as EvidenceSubjectV1` — an
    // unchecked assertion that would have let a malformed subject reach minted
    // evidence. It is now schema-parsed, so the result is genuinely valid.
    const t = translateEdgeAdmission(gateEdge(), { artifacts: { plan: 'x' } }, CTX);
    const ev = t.evidence[0];
    if (ev === undefined) throw new Error('expected minted evidence');
    // Round-tripping through the schema must be a no-op for a valid subject.
    expect(EvidenceSubjectV1Schema.parse(ev.subject)).toEqual(ev.subject);
    expect(ev.subject.kind).toBe('phase-attempt');
    // And the requirement carries the same validated subject.
    const req = t.requirements[0];
    if (req === undefined) throw new Error('expected a requirement');
    expect(EvidenceSubjectV1Schema.parse(req.subject)).toEqual(req.subject);
    // A structurally invalid subject is REJECTED (the parse is real, not a cast).
    expect(() =>
      EvidenceSubjectV1Schema.parse({ kind: 'phase-attempt', phaseAttemptId: 'x' }),
    ).toThrow();
  });
});

describe('anti-tautology — adjudication is scenario-blind (state only)', () => {
  it('identical state → identical verdict (deterministic, label-free)', () => {
    const state = { planReview: { approved: true }, _events: [] };
    const v1 = adjudicateEdge(approvalEdge(), state, CTX);
    const v2 = adjudicateEdge(approvalEdge(), { ...state }, CTX);
    expect(v1).toBe('allow');
    expect(v2).toBe('allow');
  });

  it('an irrelevant scenario-like field cannot change the verdict', () => {
    const base = { artifacts: { plan: 'docs/x.md' } };
    const labelled = { ...base, scenario: 'bypass', riskTier: 'unknown' };
    expect(adjudicateEdge(gateEdge(), base, CTX)).toBe(
      adjudicateEdge(gateEdge(), labelled, CTX),
    );
  });

  it('identical state → identical facts digest (content-addressed determinism)', () => {
    const s = { artifacts: { plan: 'docs/x.md' }, planReview: { approved: true } };
    expect(factsDigest(projectStateToFacts(s)).value).toBe(
      factsDigest(projectStateToFacts({ ...s })).value,
    );
  });
});

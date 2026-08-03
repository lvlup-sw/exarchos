// ─── P07-02 exit-proof (d) — real legacy-state → admission-evidence translation ─
//
// Proves the translation produces GENUINE, content-addressed admission evidence
// records (not the P07-01 scenario proxy), and that the projection reads real
// legacy state the way the legacy guards do. The load-bearing anti-tautology
// property is that adjudication is scenario-BLIND: identical legacy state always
// yields identical evidence and an identical verdict — so a shadow disagreement
// reflects a genuine legacy/admission divergence, never a proxy label.

import { describe, expect, it } from 'vitest';

import { getEdgeIR } from './built-in-workflow-ir.js';
import {
  adjudicateEdge,
  defaultTranslationContext,
  factsDigest,
  projectStateToFacts,
  translateEdgeAdmission,
  TRANSLATION_PRODUCER_ID,
  TRANSLATION_PROVIDER_REF,
  TRANSLATION_POLICY_ID,
} from './legacy-state-translation.js';

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

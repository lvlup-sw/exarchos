// ─── P07-03 exit-proofs (a,b,d) — builder decision parity over the corpus ─────
//
// This harness AUTHORS the five built-in workflows THROUGH the public builder
// combinators (`workflow-builder.ts`) and proves three things against the frozen
// P06-01 characterization corpus (108 deterministic fixtures):
//
//   (a) ROUND-TRIP — every builder-authored edge lowers to shared IR that is
//       byte-identical (serialize-equal) to the hand-authored `BUILT_IN_WORKFLOW_IR`
//       edge, and back through the compiler without loss.
//   (b) DECISION PARITY — for every corpus fixture, the decision produced via the
//       builder-authored definition equals the expected legacy decision (except
//       the six known legacy guard-soundness defects) AND equals the decision the
//       hand-authored IR produces. The equivalence relation is the three-valued
//       `PolicyVerdict` — a DECISION, never the shape of a legacy guard object.
//   (d) SHADOW DELTA — the disagreement set is unchanged (still exactly the six
//       explained, safe-direction defects) when the decisions come from
//       builder-authored definitions.
//
// The design instruction (P07-03): "compare compiled decisions rather than
// preserving legacy guard object shape." This harness never deep-equals a legacy
// guard object; parity is asserted purely over `adjudicateEdge`'s `PolicyVerdict`.

import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_WORKFLOW_IR,
  edgeKey,
  getEdgeIR,
  type EdgeObligation,
  type WorkflowEdgeIR,
} from './built-in-workflow-ir.js';
import { serializeEdgeCondition } from './edge-condition.js';
import {
  adjudicateEdge,
  defaultTranslationContext,
} from './legacy-state-translation.js';
import type { PolicyVerdict } from './policy-evaluation.js';
import {
  all,
  any,
  approval,
  buildEdges,
  compare,
  equals,
  event,
  gate,
  noObligation,
  not,
  present,
  type WorkflowEdgeSpec,
} from './workflow-builder.js';
import {
  transitionAdmissionCorpus,
  type LegacyTransitionFixture,
} from '../__fixtures__/transition-admission-corpus.js';

const CTX = defaultTranslationContext('2025-01-01T00:00:00.000Z');

/**
 * Canonicalize an obligation to a comparable string. This is a DECISION-shape
 * canonicalization (kind + id/class/threshold + compiled presence AST), NOT a
 * legacy guard object — the presence probe is serialized through the closed
 * edge-condition serializer, so two obligations compare equal iff they impose
 * the same admission requirement, however they were authored.
 */
function serializeObligation(obligation: EdgeObligation): string {
  switch (obligation.kind) {
    case 'none':
      return 'none';
    case 'gate':
      return `gate|${obligation.gateId}|${serializeEdgeCondition(obligation.presence)}`;
    case 'approval':
      return `approval|${obligation.approvalClass}|${obligation.minimumApprovals}|${serializeEdgeCondition(obligation.presence)}`;
  }
}

/** The MAX_SYNTHESIZE_RETRIES cap the hand IR uses. */
const MAX_SYNTHESIZE_RETRIES = 3;

// Shared presence probes, re-authored through the builder combinators (the same
// composition the hand IR expresses with its private helpers).
const PLAN_ARTIFACT_PRESENT = any(present('artifacts.plan'), present('plan'));
const PR_URL_PRESENT = any(present('synthesis.prUrl'), present('artifacts.pr'));
const TASKS_COMPLETE = all(
  compare('tasks.count', 'gte', 1),
  equals('tasks.allComplete', true),
);
const RETRYABLE = all(
  present('synthesis.lastError'),
  compare('synthesis.retryCount', 'lt', MAX_SYNTHESIZE_RETRIES),
);
// The plan-revision cap and the review obligations are NOT constants here: they
// are per-project config the legacy guards read, resolved by the projection and
// consumed as derived facts. Re-authoring them as a hardcoded
// `compare('planReview.revisionCount', 'gte', 1)` would reintroduce exactly the
// second authority the IR was fixed to remove.
const REVISIONS_EXHAUSTED = equals('planReview.revisionsExhausted', true);
const REQUIRED_REVIEWS_SATISFIED = equals('reviews.requiredSatisfied', true);
const SYNTHESIS_OPTED_IN = any(
  equals('oneshot.synthesisPolicy', 'always'),
  all(equals('oneshot.synthesisPolicy', 'on-request'), event('synthesize.requested')),
);
const SYNTHESIS_OPTED_OUT = any(
  equals('oneshot.synthesisPolicy', 'never'),
  all(
    equals('oneshot.synthesisPolicy', 'on-request'),
    not(event('synthesize.requested')),
  ),
);

// ─── Builder-authored built-in workflows (mirrors BUILT_IN_WORKFLOW_IR) ───────

const FEATURE_SPECS: readonly WorkflowEdgeSpec[] = [
  { workflowType: 'feature', from: 'plan', to: 'plan-review', toPhaseKind: 'PLAN', category: 'admission-requirement', legacyGuardId: 'plan-artifact-exists', obligation: gate('plan-artifact', PLAN_ARTIFACT_PRESENT) },
  { workflowType: 'feature', from: 'plan-review', to: 'delegate', toPhaseKind: 'IMPLEMENT', category: 'approval', legacyGuardId: 'plan-review-complete', obligation: approval('plan-review', equals('planReview.approved', true)) },
  { workflowType: 'feature', from: 'plan-review', to: 'blocked', toPhaseKind: 'GATHER', category: 'bounded-loop-rule', legacyGuardId: 'revisions-exhausted', route: REVISIONS_EXHAUSTED, obligation: noObligation },
  { workflowType: 'feature', from: 'plan-review', to: 'plan', toPhaseKind: 'PLAN', category: 'route-condition', legacyGuardId: 'plan-review-gaps-found', route: equals('planReview.gapsFound', true), obligation: noObligation },
  { workflowType: 'feature', from: 'delegate', to: 'review', toPhaseKind: 'REVIEW', category: 'admission-requirement', legacyGuardId: 'all-tasks-complete+team-disbanded', obligation: gate('tasks-and-team', all(TASKS_COMPLETE, equals('team.disbandedOk', true))) },
  { workflowType: 'feature', from: 'delegate', to: 'merge-pending', toPhaseKind: 'MERGE', category: 'admission-requirement', legacyGuardId: 'merge-pending-entry', obligation: gate('merge-pending-entry', equals('mergePending.entryReady', true)) },
  { workflowType: 'feature', from: 'merge-pending', to: 'delegate', toPhaseKind: 'IMPLEMENT', category: 'admission-requirement', legacyGuardId: 'merge-pending-exit', obligation: gate('merge-pending-exit', equals('mergePending.exitReady', true)) },
  { workflowType: 'feature', from: 'review', to: 'synthesize', toPhaseKind: 'SYNTHESIZE', category: 'approval', legacyGuardId: 'all-reviews-passed', obligation: approval('reviews', REQUIRED_REVIEWS_SATISFIED) },
  { workflowType: 'feature', from: 'review', to: 'delegate', toPhaseKind: 'IMPLEMENT', category: 'route-condition', legacyGuardId: 'any-review-failed', route: equals('reviews.anyFailed', true), obligation: noObligation },
  { workflowType: 'feature', from: 'synthesize', to: 'delegate', toPhaseKind: 'IMPLEMENT', category: 'bounded-loop-rule', legacyGuardId: 'synthesize-retryable', route: RETRYABLE, obligation: noObligation },
  { workflowType: 'feature', from: 'synthesize', to: 'completed', toPhaseKind: 'SYNTHESIZE', category: 'admission-requirement', legacyGuardId: 'pr-url-exists', obligation: gate('pr-url', PR_URL_PRESENT) },
  { workflowType: 'feature', from: 'blocked', to: 'delegate', toPhaseKind: 'IMPLEMENT', category: 'approval', legacyGuardId: 'human-unblocked', obligation: approval('unblock', equals('unblocked', true)) },
];

const DEBUG_SPECS: readonly WorkflowEdgeSpec[] = [
  { workflowType: 'debug', from: 'triage', to: 'investigate', toPhaseKind: 'GATHER', category: 'admission-requirement', legacyGuardId: 'triage-complete', obligation: gate('triage', present('triage.symptom')) },
  { workflowType: 'debug', from: 'investigate', to: 'rca', toPhaseKind: 'PLAN', category: 'route-condition', legacyGuardId: 'thorough-track-selected', route: equals('track', 'thorough'), obligation: noObligation },
  { workflowType: 'debug', from: 'investigate', to: 'hotfix-implement', toPhaseKind: 'IMPLEMENT', category: 'route-condition', legacyGuardId: 'hotfix-track-selected', route: equals('track', 'hotfix'), obligation: noObligation },
  { workflowType: 'debug', from: 'investigate', to: 'cancelled', toPhaseKind: 'GATHER', category: 'route-condition', legacyGuardId: 'escalation-required', route: equals('investigation.escalate', true), obligation: noObligation },
  { workflowType: 'debug', from: 'investigate', to: 'completed', toPhaseKind: 'GATHER', category: 'admission-requirement', legacyGuardId: 'fix-verified-directly', obligation: gate('fix-verified-directly', all(equals('resolution.directPush', true), present('resolution.commitSha'))) },
  { workflowType: 'debug', from: 'rca', to: 'design', toPhaseKind: 'PLAN', category: 'admission-requirement', legacyGuardId: 'rca-document-complete', obligation: gate('rca-document', present('artifacts.rca')) },
  { workflowType: 'debug', from: 'design', to: 'debug-implement', toPhaseKind: 'IMPLEMENT', category: 'admission-requirement', legacyGuardId: 'fix-design-complete', obligation: gate('fix-design', present('artifacts.fixDesign')) },
  { workflowType: 'debug', from: 'debug-implement', to: 'debug-validate', toPhaseKind: 'REVIEW', category: 'obsolete-predicate', legacyGuardId: 'implementation-complete', obligation: gate('implementation', equals('implementation.complete', true)) },
  { workflowType: 'debug', from: 'debug-validate', to: 'debug-review', toPhaseKind: 'REVIEW', category: 'admission-requirement', legacyGuardId: 'validation-passed', obligation: gate('validation', equals('validation.testsPass', true)) },
  { workflowType: 'debug', from: 'debug-review', to: 'synthesize', toPhaseKind: 'SYNTHESIZE', category: 'admission-requirement', legacyGuardId: 'review-passed', obligation: gate('review', equals('reviews.allPassed', true)) },
  { workflowType: 'debug', from: 'hotfix-implement', to: 'hotfix-validate', toPhaseKind: 'REVIEW', category: 'obsolete-predicate', legacyGuardId: 'implementation-complete', obligation: gate('implementation', equals('implementation.complete', true)) },
  { workflowType: 'debug', from: 'hotfix-validate', to: 'synthesize', toPhaseKind: 'SYNTHESIZE', category: 'admission-requirement', legacyGuardId: 'validation+pr-requested', obligation: gate('validation-and-pr', all(equals('validation.testsPass', true), equals('synthesis.requested', true))) },
  { workflowType: 'debug', from: 'hotfix-validate', to: 'completed', toPhaseKind: 'REVIEW', category: 'admission-requirement', legacyGuardId: 'validation-passed', obligation: gate('validation', equals('validation.testsPass', true)) },
  { workflowType: 'debug', from: 'synthesize', to: 'debug-implement', toPhaseKind: 'IMPLEMENT', category: 'bounded-loop-rule', legacyGuardId: 'synthesize-retryable+thorough-track', route: all(RETRYABLE, equals('track', 'thorough')), obligation: noObligation },
  { workflowType: 'debug', from: 'synthesize', to: 'hotfix-implement', toPhaseKind: 'IMPLEMENT', category: 'bounded-loop-rule', legacyGuardId: 'synthesize-retryable+hotfix-track', route: all(RETRYABLE, equals('track', 'hotfix')), obligation: noObligation },
  { workflowType: 'debug', from: 'synthesize', to: 'completed', toPhaseKind: 'SYNTHESIZE', category: 'admission-requirement', legacyGuardId: 'pr-url-exists', obligation: gate('pr-url', PR_URL_PRESENT) },
];

const REFACTOR_SPECS: readonly WorkflowEdgeSpec[] = [
  { workflowType: 'refactor', from: 'explore', to: 'brief', toPhaseKind: 'PLAN', category: 'admission-requirement', legacyGuardId: 'scope-assessment-complete', obligation: gate('scope-assessment', present('explore.scopeAssessment')) },
  { workflowType: 'refactor', from: 'brief', to: 'polish-implement', toPhaseKind: 'IMPLEMENT', category: 'route-condition', legacyGuardId: 'polish-track-selected', route: equals('track', 'polish'), obligation: noObligation },
  { workflowType: 'refactor', from: 'brief', to: 'overhaul-plan', toPhaseKind: 'PLAN', category: 'route-condition', legacyGuardId: 'overhaul-track-selected', route: equals('track', 'overhaul'), obligation: noObligation },
  { workflowType: 'refactor', from: 'polish-implement', to: 'polish-validate', toPhaseKind: 'REVIEW', category: 'obsolete-predicate', legacyGuardId: 'implementation-complete', obligation: gate('implementation', equals('implementation.complete', true)) },
  { workflowType: 'refactor', from: 'polish-validate', to: 'polish-update-docs', toPhaseKind: 'GATHER', category: 'admission-requirement', legacyGuardId: 'goals-verified', obligation: gate('goals-verified', equals('validation.testsPass', true)) },
  { workflowType: 'refactor', from: 'polish-update-docs', to: 'completed', toPhaseKind: 'GATHER', category: 'admission-requirement', legacyGuardId: 'docs-updated', obligation: gate('docs-updated', equals('validation.docsUpdated', true)) },
  { workflowType: 'refactor', from: 'overhaul-plan', to: 'overhaul-plan-review', toPhaseKind: 'PLAN', category: 'admission-requirement', legacyGuardId: 'plan-artifact-exists', obligation: gate('plan-artifact', PLAN_ARTIFACT_PRESENT) },
  { workflowType: 'refactor', from: 'overhaul-plan-review', to: 'overhaul-delegate', toPhaseKind: 'IMPLEMENT', category: 'approval', legacyGuardId: 'plan-review-complete', obligation: approval('plan-review', equals('planReview.approved', true)) },
  { workflowType: 'refactor', from: 'overhaul-plan-review', to: 'blocked', toPhaseKind: 'GATHER', category: 'bounded-loop-rule', legacyGuardId: 'revisions-exhausted', route: REVISIONS_EXHAUSTED, obligation: noObligation },
  { workflowType: 'refactor', from: 'overhaul-plan-review', to: 'overhaul-plan', toPhaseKind: 'PLAN', category: 'route-condition', legacyGuardId: 'plan-review-gaps-found', route: equals('planReview.gapsFound', true), obligation: noObligation },
  { workflowType: 'refactor', from: 'blocked', to: 'overhaul-delegate', toPhaseKind: 'IMPLEMENT', category: 'approval', legacyGuardId: 'human-unblocked', obligation: approval('unblock', equals('unblocked', true)) },
  { workflowType: 'refactor', from: 'overhaul-delegate', to: 'overhaul-review', toPhaseKind: 'REVIEW', category: 'admission-requirement', legacyGuardId: 'all-tasks-complete', obligation: gate('all-tasks-complete', TASKS_COMPLETE) },
  { workflowType: 'refactor', from: 'overhaul-review', to: 'overhaul-update-docs', toPhaseKind: 'GATHER', category: 'approval', legacyGuardId: 'all-reviews-passed', obligation: approval('reviews', REQUIRED_REVIEWS_SATISFIED) },
  { workflowType: 'refactor', from: 'overhaul-review', to: 'overhaul-delegate', toPhaseKind: 'IMPLEMENT', category: 'route-condition', legacyGuardId: 'any-review-failed', route: equals('reviews.anyFailed', true), obligation: noObligation },
  { workflowType: 'refactor', from: 'overhaul-update-docs', to: 'synthesize', toPhaseKind: 'SYNTHESIZE', category: 'admission-requirement', legacyGuardId: 'docs-updated', obligation: gate('docs-updated', equals('validation.docsUpdated', true)) },
  { workflowType: 'refactor', from: 'synthesize', to: 'overhaul-delegate', toPhaseKind: 'IMPLEMENT', category: 'bounded-loop-rule', legacyGuardId: 'synthesize-retryable', route: RETRYABLE, obligation: noObligation },
  { workflowType: 'refactor', from: 'synthesize', to: 'completed', toPhaseKind: 'SYNTHESIZE', category: 'admission-requirement', legacyGuardId: 'pr-url-exists', obligation: gate('pr-url', PR_URL_PRESENT) },
];

const ONESHOT_SPECS: readonly WorkflowEdgeSpec[] = [
  { workflowType: 'oneshot', from: 'plan', to: 'implementing', toPhaseKind: 'IMPLEMENT', category: 'admission-requirement', legacyGuardId: 'oneshot-plan-set', obligation: gate('oneshot-plan', equals('artifacts.planNonEmpty', true)) },
  { workflowType: 'oneshot', from: 'implementing', to: 'synthesize', toPhaseKind: 'SYNTHESIZE', category: 'route-condition', legacyGuardId: 'synthesis-opted-in', route: SYNTHESIS_OPTED_IN, obligation: noObligation },
  { workflowType: 'oneshot', from: 'implementing', to: 'completed', toPhaseKind: 'IMPLEMENT', category: 'route-condition', legacyGuardId: 'synthesis-opted-out', route: SYNTHESIS_OPTED_OUT, obligation: noObligation },
  { workflowType: 'oneshot', from: 'synthesize', to: 'completed', toPhaseKind: 'SYNTHESIZE', category: 'admission-requirement', legacyGuardId: 'merge-verified', obligation: gate('merge-verified', equals('cleanup.mergeVerified', true)) },
];

const DISCOVERY_SPECS: readonly WorkflowEdgeSpec[] = [
  { workflowType: 'discovery', from: 'gathering', to: 'synthesizing', toPhaseKind: 'GATHER', category: 'admission-requirement', legacyGuardId: 'sources-collected', obligation: gate('sources', compare('artifacts.sources.count', 'gte', 1)) },
  { workflowType: 'discovery', from: 'synthesizing', to: 'completed', toPhaseKind: 'GATHER', category: 'admission-requirement', legacyGuardId: 'report-artifact-exists', obligation: gate('report', present('artifacts.report')) },
];

/** All built-in-workflow edges authored through the builder, in IR order. */
const BUILDER_AUTHORED_IR: readonly WorkflowEdgeIR[] = buildEdges([
  ...FEATURE_SPECS,
  ...DEBUG_SPECS,
  ...REFACTOR_SPECS,
  ...ONESHOT_SPECS,
  ...DISCOVERY_SPECS,
]);

const BUILDER_INDEX: ReadonlyMap<string, WorkflowEdgeIR> = new Map(
  BUILDER_AUTHORED_IR.map((e) => [edgeKey(e.workflowType, e.from, e.to), e]),
);

function builderEdge(workflowType: string, from: string, to: string): WorkflowEdgeIR {
  const edge = BUILDER_INDEX.get(edgeKey(workflowType, from, to));
  if (edge === undefined) {
    throw new Error(`no builder-authored edge for ${workflowType}:${from}:${to}`);
  }
  return edge;
}

/** The DECISION (three-valued PolicyVerdict) — the ONLY equivalence compared. */
function decisionOf(edge: WorkflowEdgeIR, fixture: LegacyTransitionFixture): PolicyVerdict {
  return adjudicateEdge(edge, fixture.state as Record<string, unknown>, CTX);
}

/**
 * The six known P06-01 legacy guard-soundness defects (from
 * `built-in-workflow-decisions.test.ts`): fixtures where the legacy path admits
 * a fail-shaped state the evidence-backed engine correctly denies. All are the
 * SAFE direction (legacy allow / admission deny).
 */
const EXPECTED_DISAGREEMENTS: ReadonlySet<string> = new Set([
  'debug-debug-implement-to-debug-validate-fail',
  'debug-hotfix-implement-to-hotfix-validate-fail',
  'debug-investigate-to-cancelled-fail',
  'refactor-polish-implement-to-polish-validate-fail',
  'bypass-empty-task-collection-is-complete',
  'bypass-always-pass-implementation-ignores-fail-shaped-state',
]);

// ─── Exit-proof (a): builder output round-trips shared IR losslessly ──────────

describe('builder-authored edges round-trip the shared IR (exit-proof a)', () => {
  it('covers exactly the hand-authored IR edge set (no missing / extra edges)', () => {
    const handKeys = new Set(
      BUILT_IN_WORKFLOW_IR.map((e) => edgeKey(e.workflowType, e.from, e.to)),
    );
    const builderKeys = new Set(BUILDER_INDEX.keys());
    expect(builderKeys).toEqual(handKeys);
    expect(BUILDER_AUTHORED_IR).toHaveLength(BUILT_IN_WORKFLOW_IR.length);
  });

  it('lowers each edge to a route + obligation that serialize-equals the hand IR', () => {
    for (const hand of BUILT_IN_WORKFLOW_IR) {
      const built = builderEdge(hand.workflowType, hand.from, hand.to);
      const label = edgeKey(hand.workflowType, hand.from, hand.to);

      // Route legality: the compiled AST is byte-identical.
      expect(serializeEdgeCondition(built.routeCondition), `${label} route`).toBe(
        serializeEdgeCondition(hand.routeCondition),
      );
      // Admission obligation (requirement declaration): byte-identical.
      expect(serializeObligation(built.obligation), `${label} obligation`).toBe(
        serializeObligation(hand.obligation),
      );
      // Metadata the IR consumers key on.
      expect(built.toPhaseKind, `${label} phaseKind`).toBe(hand.toPhaseKind);
      expect(built.category, `${label} category`).toBe(hand.category);
      expect(built.legacyGuardId, `${label} legacyGuardId`).toBe(hand.legacyGuardId);
    }
  });

  it('every builder edge is a live IR edge (getEdgeIR resolves the same key)', () => {
    for (const built of BUILDER_AUTHORED_IR) {
      expect(getEdgeIR(built.workflowType, built.from, built.to)).toBeDefined();
    }
  });
});

// ─── Exit-proof (b): builder decisions match the corpus ───────────────────────

describe('builder-authored definitions produce the expected decisions (exit-proof b)', () => {
  it('resolves a builder edge for every corpus fixture', () => {
    for (const fixture of transitionAdmissionCorpus) {
      expect(
        () => builderEdge(fixture.workflowType, fixture.from, fixture.to),
        fixture.id,
      ).not.toThrow();
    }
  });

  it('produces a definite allow/deny for every fixture (no indeterminate)', () => {
    for (const fixture of transitionAdmissionCorpus) {
      const edge = builderEdge(fixture.workflowType, fixture.from, fixture.to);
      expect(decisionOf(edge, fixture), fixture.id).not.toBe('indeterminate');
    }
  });

  it('agrees with the expected legacy decision except on the six known defects', () => {
    for (const fixture of transitionAdmissionCorpus) {
      if (EXPECTED_DISAGREEMENTS.has(fixture.id)) continue;
      const edge = builderEdge(fixture.workflowType, fixture.from, fixture.to);
      expect(decisionOf(edge, fixture), `${fixture.id} should agree with legacy`).toBe(
        fixture.expected.verdict,
      );
    }
  });

  it('DECISION-matches the hand-authored IR on every fixture (parity is decisional, not structural)', () => {
    // The equivalence relation is `PolicyVerdict` — the DECISION — never a
    // deep-equal of any legacy guard object. Two edges are "the same" here iff
    // they decide the same way, which is the whole point of P07-03: compare
    // compiled decisions, not preserve legacy guard object shape.
    for (const fixture of transitionAdmissionCorpus) {
      const built = builderEdge(fixture.workflowType, fixture.from, fixture.to);
      const hand = getEdgeIR(fixture.workflowType, fixture.from, fixture.to);
      expect(hand, fixture.id).toBeDefined();
      if (hand === undefined) continue;
      expect(decisionOf(built, fixture), `${fixture.id} builder vs hand IR`).toBe(
        decisionOf(hand, fixture),
      );
    }
  });
});

// ─── Exit-proof (d): the shadow disagreement delta is unchanged ───────────────

function disagreementIds(resolve: (f: LegacyTransitionFixture) => WorkflowEdgeIR): Set<string> {
  const ids = new Set<string>();
  for (const fixture of transitionAdmissionCorpus) {
    if (decisionOf(resolve(fixture), fixture) !== fixture.expected.verdict) {
      ids.add(fixture.id);
    }
  }
  return ids;
}

describe('shadow disagreement delta stays at six under builder decisions (exit-proof d)', () => {
  it('surfaces exactly the six known-defect disagreements', () => {
    const ids = disagreementIds((f) => builderEdge(f.workflowType, f.from, f.to));
    expect(ids).toEqual(new Set(EXPECTED_DISAGREEMENTS));
    expect(ids.size).toBe(6);
  });

  it('the builder delta is identical to the hand-authored IR delta (no drift)', () => {
    const builderIds = disagreementIds((f) => builderEdge(f.workflowType, f.from, f.to));
    const handIds = disagreementIds((f) => {
      const e = getEdgeIR(f.workflowType, f.from, f.to);
      if (e === undefined) throw new Error(`no IR edge for ${f.id}`);
      return e;
    });
    expect(builderIds).toEqual(handIds);
  });

  it('every surviving disagreement is the SAFE direction (legacy allow, admission deny)', () => {
    for (const fixture of transitionAdmissionCorpus) {
      const edge = builderEdge(fixture.workflowType, fixture.from, fixture.to);
      const shadow = decisionOf(edge, fixture);
      if (shadow === fixture.expected.verdict) continue;
      expect(fixture.expected.verdict, fixture.id).toBe('allow');
      expect(shadow, fixture.id).toBe('deny');
    }
  });
});

/**
 * The five built-in workflows in the shared admission IR.
 *
 * Each edge has a route condition as a compiled {@link CompiledEdgeCondition} and an admission obligation as data.
 * It also carries the phase kind and the legacy guard id for the live shadow observer.
 * Route conditions and presence probes use one fact vocabulary, {@link FACT_DECLARATION}.
 * The `legacy-state-translation` module projects legacy state into it. Nothing here reads state.
 *
 * This module has no import path to a legacy guard module: `guards.ts`, `hsm-definitions.ts`, `config/guards.ts` or `config/register.ts`.
 * `built-in-workflow-ir.structure.test.ts` proves this.
 */

import {
  compileEdgeCondition,
  type CompiledEdgeCondition,
  type EdgeConditionDeclaration,
} from './edge-condition.js';
import type { PhaseKind } from '../phase-kind.js';

export type BuiltInWorkflowType =
  | 'feature'
  | 'debug'
  | 'refactor'
  | 'oneshot'
  | 'discovery';

export const BUILT_IN_WORKFLOW_TYPES: readonly BuiltInWorkflowType[] =
  Object.freeze(['feature', 'debug', 'refactor', 'oneshot', 'discovery']);

/**
 * The legacy-guard classification category of an edge.
 * It is a string union and not an import of the classification fixture, so this module has no fixture dependency.
 * A test checks it against the corpus.
 */
export type EdgeCategory =
  | 'route-condition'
  | 'admission-requirement'
  | 'bounded-loop-rule'
  | 'approval'
  | 'obsolete-predicate';

/**
 * The admission obligation of an edge after the route is legal.
 * `none` has no evidence obligation. `gate` and `approval` have a `presence` probe.
 * The translation evaluates the probe against the projected legacy state. The probe is separate from the route condition.
 */
export type EdgeObligation =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'gate';
      readonly gateId: string;
      readonly presence: CompiledEdgeCondition;
    }
  | {
      readonly kind: 'approval';
      readonly approvalClass: string;
      readonly minimumApprovals: number;
      readonly presence: CompiledEdgeCondition;
    };

/** One built-in-workflow edge, fully expressed in shared IR. */
export interface WorkflowEdgeIR {
  readonly workflowType: BuiltInWorkflowType;
  readonly from: string;
  readonly to: string;
  /** The phase kind that this edge enters. A final edge uses the source kind. */
  readonly toPhaseKind: PhaseKind;
  /** The classification category of this edge. */
  readonly category: EdgeCategory;
  /** The legacy guard id, as a string only and never a reference to guard code. `null` when the edge has no guard. */
  readonly legacyGuardId: string | null;
  /** The route legality. An edge without a route selector uses `all([])`, which is always legal. */
  readonly routeCondition: CompiledEdgeCondition;
  /** The admission obligation after the route is legal. */
  readonly obligation: EdgeObligation;
}

/**
 * The closed fact vocabulary of all route conditions and presence probes.
 * The projector of the translation produces exactly these facts. A test proves that it can fill each field that the IR uses.
 */
export const FACT_DECLARATION: EdgeConditionDeclaration = {
  fields: {
    'artifacts.plan': 'string',
    plan: 'string',
    'artifacts.pr': 'string',
    'synthesis.prUrl': 'string',
    'artifacts.rca': 'string',
    'artifacts.fixDesign': 'string',
    'artifacts.report': 'string',
    'triage.symptom': 'string',
    'explore.scopeAssessment': 'string',
    'resolution.commitSha': 'string',
    'synthesis.lastError': 'string',
    track: 'string',
    'oneshot.synthesisPolicy': 'string',
    'planReview.approved': 'boolean',
    'planReview.gapsFound': 'boolean',
    'validation.testsPass': 'boolean',
    'validation.docsUpdated': 'boolean',
    'implementation.complete': 'boolean',
    unblocked: 'boolean',
    'tasks.allComplete': 'boolean',
    'reviews.allPassed': 'boolean',
    'reviews.anyFailed': 'boolean',
    'synthesis.requested': 'boolean',
    'investigation.escalate': 'boolean',
    'resolution.directPush': 'boolean',
    'cleanup.mergeVerified': 'boolean',
    'mergePending.entryReady': 'boolean',
    'mergePending.exitReady': 'boolean',
    'team.disbandedOk': 'boolean',
    /**
     * This fact and the next two come from config. `projectStateToFacts` resolves them from the state that the legacy guard reads.
     * A hardcoded threshold here becomes a second authority that can drift and over-admit.
     */
    'planReview.revisionsExhausted': 'boolean',
    'reviews.requiredSatisfied': 'boolean',
    'artifacts.planNonEmpty': 'boolean',
    /** This counter and `policy.maxPlanRevisions` are evidence for an explanation. They do not make the decision. */
    'planReview.revisionCount': 'number',
    'policy.maxPlanRevisions': 'number',
    'synthesis.retryCount': 'number',
    'tasks.count': 'number',
    'artifacts.sources.count': 'number',
  },
  events: ['synthesize.requested'],
} as const satisfies EdgeConditionDeclaration;

function compile(node: unknown): CompiledEdgeCondition {
  return compileEdgeCondition(node, FACT_DECLARATION);
}

const present = (field: string): unknown => ({ kind: 'factPresent', field });
const eqBool = (field: string, value: boolean): unknown => ({
  kind: 'factEquals',
  field,
  value,
});
const eqStr = (field: string, value: string): unknown => ({
  kind: 'factEquals',
  field,
  value,
});
const cmp = (
  field: string,
  op: 'lt' | 'lte' | 'eq' | 'gte' | 'gt',
  value: number,
): unknown => ({ kind: 'counterCompare', field, op, value });
const all = (...operands: unknown[]): unknown => ({ kind: 'all', operands });
const any = (...operands: unknown[]): unknown => ({ kind: 'any', operands });
const not = (operand: unknown): unknown => ({ kind: 'not', operand });
const evt = (event: string): unknown => ({ kind: 'eventObserved', event });

/** The always-legal route (no branch selector on the edge). */
const ALWAYS_LEGAL: CompiledEdgeCondition = compile({ kind: 'all', operands: [] });

const NONE: EdgeObligation = Object.freeze({ kind: 'none' });
const gate = (gateId: string, presence: unknown): EdgeObligation =>
  Object.freeze({ kind: 'gate', gateId, presence: compile(presence) });
const approval = (
  approvalClass: string,
  presence: unknown,
  minimumApprovals = 1,
): EdgeObligation =>
  Object.freeze({
    kind: 'approval',
    approvalClass,
    minimumApprovals,
    presence: compile(presence),
  });

/**
 * The plan-revision cap is project config in `state._maxPlanRevisions`, not a constant here.
 * The projection resolves `revisionCount >= cap` and publishes it as `planReview.revisionsExhausted`.
 */
const REVISIONS_EXHAUSTED = eqBool('planReview.revisionsExhausted', true);

/**
 * The legacy `all-reviews-passed` guard checks the present reviews, the `_requiredReviews` dimensions and high-tier mutation enforcement.
 * The projection resolves all three from the injected state and publishes the conjunction.
 */
const REQUIRED_REVIEWS_SATISFIED = eqBool('reviews.requiredSatisfied', true);

/**
 * The oneshot synthesis branch. It matches `synthesisOptedIn` and `synthesisOptedOut`, with `'on-request'` as the default.
 * `never` is an absolute opt-out, and a stray `synthesize.requested` event does not reopen synthesis.
 * `on-request` without a request event takes the direct-commit edge.
 */
const SYNTHESIS_OPTED_IN = any(
  eqStr('oneshot.synthesisPolicy', 'always'),
  all(eqStr('oneshot.synthesisPolicy', 'on-request'), evt('synthesize.requested')),
);
const SYNTHESIS_OPTED_OUT = any(
  eqStr('oneshot.synthesisPolicy', 'never'),
  all(
    eqStr('oneshot.synthesisPolicy', 'on-request'),
    not(evt('synthesize.requested')),
  ),
);

/** The synthesize retry cap. */
const MAX_SYNTHESIZE_RETRIES = 3;

interface EdgeSpec {
  readonly from: string;
  readonly to: string;
  readonly toPhaseKind: PhaseKind;
  readonly category: EdgeCategory;
  readonly legacyGuardId: string | null;
  readonly route?: CompiledEdgeCondition;
  readonly obligation: EdgeObligation;
}

function buildEdges(
  workflowType: BuiltInWorkflowType,
  specs: readonly EdgeSpec[],
): readonly WorkflowEdgeIR[] {
  return specs.map((s) =>
    Object.freeze({
      workflowType,
      from: s.from,
      to: s.to,
      toPhaseKind: s.toPhaseKind,
      category: s.category,
      legacyGuardId: s.legacyGuardId,
      routeCondition: s.route ?? ALWAYS_LEGAL,
      obligation: s.obligation,
    }),
  );
}

/** The plan presence probe. More than one workflow uses it. */
const PLAN_ARTIFACT_PRESENT = any(present('artifacts.plan'), present('plan'));
const PR_URL_PRESENT = any(present('synthesis.prUrl'), present('artifacts.pr'));
const TASKS_COMPLETE = all(
  cmp('tasks.count', 'gte', 1),
  eqBool('tasks.allComplete', true),
);

/**
 * The compiled obligation that every planned task is complete. The capsule compiler uses it.
 * The feature delegate edge also requires team teardown, but teardown is a harness detail.
 * Thus a capsule that requires teardown binds every runtime to one harness.
 */
export const TASKS_COMPLETE_CONDITION: CompiledEdgeCondition = compile(TASKS_COMPLETE);
const RETRYABLE = all(
  present('synthesis.lastError'),
  cmp('synthesis.retryCount', 'lt', MAX_SYNTHESIZE_RETRIES),
);

const FEATURE_EDGES = buildEdges('feature', [
  {
    from: 'plan',
    to: 'plan-review',
    toPhaseKind: 'PLAN',
    category: 'admission-requirement',
    legacyGuardId: 'plan-artifact-exists',
    obligation: gate('plan-artifact', PLAN_ARTIFACT_PRESENT),
  },
  {
    from: 'plan-review',
    to: 'delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'approval',
    legacyGuardId: 'plan-review-complete',
    obligation: approval('plan-review', eqBool('planReview.approved', true)),
  },
  {
    from: 'plan-review',
    to: 'blocked',
    toPhaseKind: 'GATHER',
    category: 'bounded-loop-rule',
    legacyGuardId: 'revisions-exhausted',
    route: compile(REVISIONS_EXHAUSTED),
    obligation: NONE,
  },
  {
    from: 'plan-review',
    to: 'plan',
    toPhaseKind: 'PLAN',
    category: 'route-condition',
    legacyGuardId: 'plan-review-gaps-found',
    route: compile(eqBool('planReview.gapsFound', true)),
    obligation: NONE,
  },
  {
    from: 'delegate',
    to: 'review',
    toPhaseKind: 'REVIEW',
    category: 'admission-requirement',
    legacyGuardId: 'all-tasks-complete+team-disbanded',
    obligation: gate(
      'tasks-and-team',
      all(TASKS_COMPLETE, eqBool('team.disbandedOk', true)),
    ),
  },
  {
    from: 'delegate',
    to: 'merge-pending',
    toPhaseKind: 'MERGE',
    category: 'admission-requirement',
    legacyGuardId: 'merge-pending-entry',
    obligation: gate('merge-pending-entry', eqBool('mergePending.entryReady', true)),
  },
  {
    from: 'merge-pending',
    to: 'delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'admission-requirement',
    legacyGuardId: 'merge-pending-exit',
    obligation: gate('merge-pending-exit', eqBool('mergePending.exitReady', true)),
  },
  {
    from: 'review',
    to: 'synthesize',
    toPhaseKind: 'SYNTHESIZE',
    category: 'approval',
    legacyGuardId: 'all-reviews-passed',
    obligation: approval('reviews', REQUIRED_REVIEWS_SATISFIED),
  },
  {
    from: 'review',
    to: 'delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'route-condition',
    legacyGuardId: 'any-review-failed',
    route: compile(eqBool('reviews.anyFailed', true)),
    obligation: NONE,
  },
  {
    from: 'synthesize',
    to: 'delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'bounded-loop-rule',
    legacyGuardId: 'synthesize-retryable',
    route: compile(RETRYABLE),
    obligation: NONE,
  },
  {
    from: 'synthesize',
    to: 'completed',
    toPhaseKind: 'SYNTHESIZE',
    category: 'admission-requirement',
    legacyGuardId: 'pr-url-exists',
    obligation: gate('pr-url', PR_URL_PRESENT),
  },
  {
    from: 'blocked',
    to: 'delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'approval',
    legacyGuardId: 'human-unblocked',
    obligation: approval('unblock', eqBool('unblocked', true)),
  },
]);

const DEBUG_EDGES = buildEdges('debug', [
  {
    from: 'triage',
    to: 'investigate',
    toPhaseKind: 'GATHER',
    category: 'admission-requirement',
    legacyGuardId: 'triage-complete',
    obligation: gate('triage', present('triage.symptom')),
  },
  {
    from: 'investigate',
    to: 'rca',
    toPhaseKind: 'PLAN',
    category: 'route-condition',
    legacyGuardId: 'thorough-track-selected',
    route: compile(eqStr('track', 'thorough')),
    obligation: NONE,
  },
  {
    from: 'investigate',
    to: 'hotfix-implement',
    toPhaseKind: 'IMPLEMENT',
    category: 'route-condition',
    legacyGuardId: 'hotfix-track-selected',
    route: compile(eqStr('track', 'hotfix')),
    obligation: NONE,
  },
  {
    from: 'investigate',
    to: 'cancelled',
    toPhaseKind: 'GATHER',
    category: 'route-condition',
    legacyGuardId: 'escalation-required',
    route: compile(eqBool('investigation.escalate', true)),
    obligation: NONE,
  },
  {
    from: 'investigate',
    to: 'completed',
    toPhaseKind: 'GATHER',
    category: 'admission-requirement',
    legacyGuardId: 'fix-verified-directly',
    obligation: gate(
      'fix-verified-directly',
      all(eqBool('resolution.directPush', true), present('resolution.commitSha')),
    ),
  },
  {
    from: 'rca',
    to: 'design',
    toPhaseKind: 'PLAN',
    category: 'admission-requirement',
    legacyGuardId: 'rca-document-complete',
    obligation: gate('rca-document', present('artifacts.rca')),
  },
  {
    from: 'design',
    to: 'debug-implement',
    toPhaseKind: 'IMPLEMENT',
    category: 'admission-requirement',
    legacyGuardId: 'fix-design-complete',
    obligation: gate('fix-design', present('artifacts.fixDesign')),
  },
  {
    from: 'debug-implement',
    to: 'debug-validate',
    toPhaseKind: 'REVIEW',
    category: 'obsolete-predicate',
    legacyGuardId: 'implementation-complete',
    obligation: gate('implementation', eqBool('implementation.complete', true)),
  },
  {
    from: 'debug-validate',
    to: 'debug-review',
    toPhaseKind: 'REVIEW',
    category: 'admission-requirement',
    legacyGuardId: 'validation-passed',
    obligation: gate('validation', eqBool('validation.testsPass', true)),
  },
  {
    from: 'debug-review',
    to: 'synthesize',
    toPhaseKind: 'SYNTHESIZE',
    category: 'admission-requirement',
    legacyGuardId: 'review-passed',
    obligation: gate('review', eqBool('reviews.allPassed', true)),
  },
  {
    from: 'hotfix-implement',
    to: 'hotfix-validate',
    toPhaseKind: 'REVIEW',
    category: 'obsolete-predicate',
    legacyGuardId: 'implementation-complete',
    obligation: gate('implementation', eqBool('implementation.complete', true)),
  },
  {
    from: 'hotfix-validate',
    to: 'synthesize',
    toPhaseKind: 'SYNTHESIZE',
    category: 'admission-requirement',
    legacyGuardId: 'validation+pr-requested',
    obligation: gate(
      'validation-and-pr',
      all(eqBool('validation.testsPass', true), eqBool('synthesis.requested', true)),
    ),
  },
  {
    from: 'hotfix-validate',
    to: 'completed',
    toPhaseKind: 'REVIEW',
    category: 'admission-requirement',
    legacyGuardId: 'validation-passed',
    obligation: gate('validation', eqBool('validation.testsPass', true)),
  },
  {
    from: 'synthesize',
    to: 'debug-implement',
    toPhaseKind: 'IMPLEMENT',
    category: 'bounded-loop-rule',
    legacyGuardId: 'synthesize-retryable+thorough-track',
    route: compile(all(RETRYABLE, eqStr('track', 'thorough'))),
    obligation: NONE,
  },
  {
    from: 'synthesize',
    to: 'hotfix-implement',
    toPhaseKind: 'IMPLEMENT',
    category: 'bounded-loop-rule',
    legacyGuardId: 'synthesize-retryable+hotfix-track',
    route: compile(all(RETRYABLE, eqStr('track', 'hotfix'))),
    obligation: NONE,
  },
  {
    from: 'synthesize',
    to: 'completed',
    toPhaseKind: 'SYNTHESIZE',
    category: 'admission-requirement',
    legacyGuardId: 'pr-url-exists',
    obligation: gate('pr-url', PR_URL_PRESENT),
  },
]);

const ONESHOT_EDGES = buildEdges('oneshot', [
  {
    from: 'plan',
    to: 'implementing',
    toPhaseKind: 'IMPLEMENT',
    category: 'admission-requirement',
    legacyGuardId: 'oneshot-plan-set',
    /**
     * `oneshotPlanSet` requires a trimmed, non-empty string.
     * A bare `factPresent` admits `true`, `{}` or blanks, which the guard denies.
     */
    obligation: gate('oneshot-plan', eqBool('artifacts.planNonEmpty', true)),
  },
  {
    from: 'implementing',
    to: 'synthesize',
    toPhaseKind: 'SYNTHESIZE',
    category: 'route-condition',
    legacyGuardId: 'synthesis-opted-in',
    route: compile(SYNTHESIS_OPTED_IN),
    obligation: NONE,
  },
  {
    from: 'implementing',
    to: 'completed',
    toPhaseKind: 'IMPLEMENT',
    category: 'route-condition',
    legacyGuardId: 'synthesis-opted-out',
    route: compile(SYNTHESIS_OPTED_OUT),
    obligation: NONE,
  },
  {
    from: 'synthesize',
    to: 'completed',
    toPhaseKind: 'SYNTHESIZE',
    category: 'admission-requirement',
    legacyGuardId: 'merge-verified',
    obligation: gate('merge-verified', eqBool('cleanup.mergeVerified', true)),
  },
]);

const DISCOVERY_EDGES = buildEdges('discovery', [
  {
    from: 'gathering',
    to: 'synthesizing',
    toPhaseKind: 'GATHER',
    category: 'admission-requirement',
    legacyGuardId: 'sources-collected',
    obligation: gate('sources', cmp('artifacts.sources.count', 'gte', 1)),
  },
  {
    from: 'synthesizing',
    to: 'completed',
    toPhaseKind: 'GATHER',
    category: 'admission-requirement',
    legacyGuardId: 'report-artifact-exists',
    obligation: gate('report', present('artifacts.report')),
  },
]);

const REFACTOR_EDGES = buildEdges('refactor', [
  {
    from: 'explore',
    to: 'brief',
    toPhaseKind: 'PLAN',
    category: 'admission-requirement',
    legacyGuardId: 'scope-assessment-complete',
    obligation: gate('scope-assessment', present('explore.scopeAssessment')),
  },
  {
    from: 'brief',
    to: 'polish-implement',
    toPhaseKind: 'IMPLEMENT',
    category: 'route-condition',
    legacyGuardId: 'polish-track-selected',
    route: compile(eqStr('track', 'polish')),
    obligation: NONE,
  },
  {
    from: 'brief',
    to: 'overhaul-plan',
    toPhaseKind: 'PLAN',
    category: 'route-condition',
    legacyGuardId: 'overhaul-track-selected',
    route: compile(eqStr('track', 'overhaul')),
    obligation: NONE,
  },
  {
    from: 'polish-implement',
    to: 'polish-validate',
    toPhaseKind: 'REVIEW',
    category: 'obsolete-predicate',
    legacyGuardId: 'implementation-complete',
    obligation: gate('implementation', eqBool('implementation.complete', true)),
  },
  {
    from: 'polish-validate',
    to: 'polish-update-docs',
    toPhaseKind: 'GATHER',
    category: 'admission-requirement',
    legacyGuardId: 'goals-verified',
    obligation: gate('goals-verified', eqBool('validation.testsPass', true)),
  },
  {
    from: 'polish-update-docs',
    to: 'completed',
    toPhaseKind: 'GATHER',
    category: 'admission-requirement',
    legacyGuardId: 'docs-updated',
    obligation: gate('docs-updated', eqBool('validation.docsUpdated', true)),
  },
  {
    from: 'overhaul-plan',
    to: 'overhaul-plan-review',
    toPhaseKind: 'PLAN',
    category: 'admission-requirement',
    legacyGuardId: 'plan-artifact-exists',
    obligation: gate('plan-artifact', PLAN_ARTIFACT_PRESENT),
  },
  {
    from: 'overhaul-plan-review',
    to: 'overhaul-delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'approval',
    legacyGuardId: 'plan-review-complete',
    obligation: approval('plan-review', eqBool('planReview.approved', true)),
  },
  {
    from: 'overhaul-plan-review',
    to: 'blocked',
    toPhaseKind: 'GATHER',
    category: 'bounded-loop-rule',
    legacyGuardId: 'revisions-exhausted',
    route: compile(REVISIONS_EXHAUSTED),
    obligation: NONE,
  },
  {
    from: 'overhaul-plan-review',
    to: 'overhaul-plan',
    toPhaseKind: 'PLAN',
    category: 'route-condition',
    legacyGuardId: 'plan-review-gaps-found',
    route: compile(eqBool('planReview.gapsFound', true)),
    obligation: NONE,
  },
  {
    from: 'blocked',
    to: 'overhaul-delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'approval',
    legacyGuardId: 'human-unblocked',
    obligation: approval('unblock', eqBool('unblocked', true)),
  },
  {
    from: 'overhaul-delegate',
    to: 'overhaul-review',
    toPhaseKind: 'REVIEW',
    category: 'admission-requirement',
    legacyGuardId: 'all-tasks-complete',
    obligation: gate('all-tasks-complete', TASKS_COMPLETE),
  },
  {
    from: 'overhaul-review',
    to: 'overhaul-update-docs',
    toPhaseKind: 'GATHER',
    category: 'approval',
    legacyGuardId: 'all-reviews-passed',
    obligation: approval('reviews', REQUIRED_REVIEWS_SATISFIED),
  },
  {
    from: 'overhaul-review',
    to: 'overhaul-delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'route-condition',
    legacyGuardId: 'any-review-failed',
    route: compile(eqBool('reviews.anyFailed', true)),
    obligation: NONE,
  },
  {
    from: 'overhaul-update-docs',
    to: 'synthesize',
    toPhaseKind: 'SYNTHESIZE',
    category: 'admission-requirement',
    legacyGuardId: 'docs-updated',
    obligation: gate('docs-updated', eqBool('validation.docsUpdated', true)),
  },
  {
    from: 'synthesize',
    to: 'overhaul-delegate',
    toPhaseKind: 'IMPLEMENT',
    category: 'bounded-loop-rule',
    legacyGuardId: 'synthesize-retryable',
    route: compile(RETRYABLE),
    obligation: NONE,
  },
  {
    from: 'synthesize',
    to: 'completed',
    toPhaseKind: 'SYNTHESIZE',
    category: 'admission-requirement',
    legacyGuardId: 'pr-url-exists',
    obligation: gate('pr-url', PR_URL_PRESENT),
  },
]);

/** All built-in workflow edges in shared IR, in a fixed order. */
export const BUILT_IN_WORKFLOW_IR: readonly WorkflowEdgeIR[] = Object.freeze([
  ...FEATURE_EDGES,
  ...DEBUG_EDGES,
  ...REFACTOR_EDGES,
  ...ONESHOT_EDGES,
  ...DISCOVERY_EDGES,
]);

const EDGE_INDEX: ReadonlyMap<string, WorkflowEdgeIR> = new Map(
  BUILT_IN_WORKFLOW_IR.map((e) => [edgeKey(e.workflowType, e.from, e.to), e]),
);

/** The canonical key of an edge. The IR and the translation use the same key. */
export function edgeKey(
  workflowType: string,
  from: string,
  to: string,
): string {
  return `${workflowType}:${from}:${to}`;
}

/** Returns the shared-IR edge for a workflow, source and target, or undefined. */
export function getEdgeIR(
  workflowType: string,
  from: string,
  to: string,
): WorkflowEdgeIR | undefined {
  return EDGE_INDEX.get(edgeKey(workflowType, from, to));
}

/** All edges for one built-in workflow, in declaration order. */
export function edgesForWorkflow(
  workflowType: BuiltInWorkflowType,
): readonly WorkflowEdgeIR[] {
  return BUILT_IN_WORKFLOW_IR.filter((e) => e.workflowType === workflowType);
}

// ─── P07-02 / Transition tasks 029–032 — Built-in workflows as shared IR ──────
//
// The five built-in workflows (feature, debug, refactor, oneshot, discovery)
// expressed in the SHARED admission IR rather than as legacy guard closures:
//
//   - route conditions  — the "is this edge structurally legal?" selector, as a
//     compiled P06-02 {@link CompiledEdgeCondition} AST (closed, declarative,
//     no executable escape hatch);
//   - admission obligations — the gate/approval requirement each edge carries,
//     declared as data (never a guard reference);
//   - phase-kind and provenance metadata for the live shadow observer.
//
// Load-bearing property (P07-02 exit-proof b — proved structurally by
// `built-in-workflow-ir.structure.test.ts`): this module has NO import path to
// any LEGACY GUARD module — `guards.ts`, `hsm-definitions.ts`, `config/guards.ts`
// or `config/register.ts`. The IR is a self-contained projection of the P06-01
// classification, not a wrapper around legacy guard code. The legacy guard
// remains the authoritative decider until P07-05; what is true NOW is that these
// definitions do not reach back into legacy guard code.
//
// The route conditions and evidence-presence probes are BOTH expressed in the
// P06-02 edge-condition AST over ONE shared fact vocabulary
// ({@link FACT_DECLARATION}). The `legacy-state-translation` module owns the
// projection of real legacy state into that vocabulary; nothing here reads
// state.

import {
  compileEdgeCondition,
  type CompiledEdgeCondition,
  type EdgeConditionDeclaration,
} from './edge-condition.js';
import type { PhaseKind } from '../phase-kind.js';

// ─── Workflow identity ─────────────────────────────────────────────────────────

export type BuiltInWorkflowType =
  | 'feature'
  | 'debug'
  | 'refactor'
  | 'oneshot'
  | 'discovery';

export const BUILT_IN_WORKFLOW_TYPES: readonly BuiltInWorkflowType[] =
  Object.freeze(['feature', 'debug', 'refactor', 'oneshot', 'discovery']);

/**
 * The P06-01 classification category an edge is derived from. Kept as data (a
 * string union), NOT an import of the classification fixture — the cross-check
 * that this matches the P06-01 corpus lives in the test, so this module stays
 * free of any legacy-guard / fixture dependency.
 */
export type EdgeCategory =
  | 'route-condition'
  | 'admission-requirement'
  | 'bounded-loop-rule'
  | 'approval'
  | 'obsolete-predicate';

// ─── Admission obligation ──────────────────────────────────────────────────────

/**
 * The admission obligation an edge carries once routing legality is decided:
 *   - `none`     — pure routing / bounded-loop / universal edge; no evidence
 *                  obligation (routing legality is the whole decision);
 *   - `gate`     — a gate-evidence requirement; the `presence` probe decides
 *                  whether the certifying fact is genuinely present in state;
 *   - `approval` — a typed approval requirement; the `presence` probe decides
 *                  whether the approval signal is present.
 *
 * The `presence` condition is a P06-02 edge condition evaluated by the
 * translation against the projected legacy state; it is NOT re-derived from the
 * route condition.
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
  /** Phase kind entered by this edge (target kind, or source kind for finals). */
  readonly toPhaseKind: PhaseKind;
  /** P06-01 classification category this edge is derived from. */
  readonly category: EdgeCategory;
  /**
   * The legacy guard id this edge corresponds to, for cross-referencing the
   * P06-01 corpus. A STRING ONLY — never a reference to guard code. `null` for
   * an edge that carries no legacy guard.
   */
  readonly legacyGuardId: string | null;
  /** Route legality (P06-02). `all([])` (always legal) for single-target edges. */
  readonly routeCondition: CompiledEdgeCondition;
  /** Admission obligation once the edge is routable. */
  readonly obligation: EdgeObligation;
}

// ─── Shared fact vocabulary ────────────────────────────────────────────────────

/**
 * The closed vocabulary every route condition and evidence-presence probe is
 * declared against. The translation's projector produces EXACTLY these facts;
 * a test asserts every referenced field is projectable (so the IR can never
 * reference a fact the projector cannot populate).
 */
export const FACT_DECLARATION: EdgeConditionDeclaration = {
  fields: {
    // ── presence facts (string) ──
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
    // ── routing selector facts (string) ──
    track: 'string',
    'oneshot.synthesisPolicy': 'string',
    // ── boolean facts ──
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
    // ── CONFIG-DERIVED obligation facts (see the note below) ──
    'planReview.revisionsExhausted': 'boolean',
    'reviews.requiredSatisfied': 'boolean',
    'artifacts.planNonEmpty': 'boolean',
    // ── counter facts (number) ──
    'planReview.revisionCount': 'number',
    'policy.maxPlanRevisions': 'number',
    'synthesis.retryCount': 'number',
    'tasks.count': 'number',
    'artifacts.sources.count': 'number',
  },
  events: ['synthesize.requested'],
} as const satisfies EdgeConditionDeclaration;

// ─── Single authority for config-bearing obligations (P07-02 soundness fix) ────
//
// A transition boundary must have exactly ONE authority. The legacy guards read
// per-project configuration and resolved tier state that `workflow/tools.ts`
// injects onto the workflow state before the pure guard runs:
//
//   `_maxPlanRevisions`   → `revisionsExhausted`  (the plan-revision cap)
//   `_requiredReviews`    → `allReviewsPassed`    (required review dimensions)
//   `_mutationEnforcement` / `_mutationThreshold` / `_maxNoCoverage`
//                         → `allReviewsPassed`    (HIGH-tier mutation gates)
//   a MISSING `oneshot.synthesisPolicy` → `'on-request'` (the default branch)
//
// Expressing those obligations as HARDCODED CONSTANTS in this IR would create a
// SECOND authority that silently drifts from the first: with a configured cap of
// 3 and `revisionCount === 1`, a `revisionCount >= 1` constant admits an edge the
// legacy guard denies — an OVER-admission, the unsafe direction. The drift is
// invisible to a corpus generated from default/no-config fixtures, because that
// is exactly the input region where the constant and the config agree.
//
// So none of these thresholds live here. `legacy-state-translation`'s
// `projectStateToFacts` reads the SAME injected state the legacy guard reads and
// projects the resolved obligation as a DERIVED FACT
// (`planReview.revisionsExhausted`, `reviews.requiredSatisfied`,
// `artifacts.planNonEmpty`, and a policy-defaulted `oneshot.synthesisPolicy`).
// The IR consumes the resolved fact; the projection owns the resolution. One
// authority, one place to change, no constant to drift.
//
// `planReview.revisionCount` and `policy.maxPlanRevisions` remain declared as
// observable counters so a decision explanation can still name BOTH sides of the
// comparison — they are evidence, not the decision.

// ─── Node / obligation builders (compile-time validated) ───────────────────────

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
 * The plan-revision cap is NOT a constant here — it is per-project config the
 * legacy guard reads from `state._maxPlanRevisions`. The projection resolves
 * `revisionCount >= cap` against that injected value and publishes the result as
 * `planReview.revisionsExhausted`, so this edge consumes ONE authority's answer.
 */
const REVISIONS_EXHAUSTED = eqBool('planReview.revisionsExhausted', true);

/**
 * `all-reviews-passed` is not "the present reviews passed" — the legacy guard
 * ALSO denies on missing `_requiredReviews` dimensions and on HIGH-tier
 * mutation-score / NoCoverage enforcement. The projection resolves all three
 * axes from the same injected state and publishes the conjunction.
 */
const REQUIRED_REVIEWS_SATISFIED = eqBool('reviews.requiredSatisfied', true);

/**
 * The oneshot synthesis branch, mirroring `synthesisOptedIn` /
 * `synthesisOptedOut` EXACTLY — including the `'on-request'` DEFAULT for a
 * missing policy. `never` is an absolute opt-out (a stray `synthesize.requested`
 * event must not re-open the synthesize branch), and `on-request` with no
 * request event takes the DIRECT-COMMIT edge. Modelling only
 * `policy === 'never'` on the direct-commit edge deadlocked the DEFAULT oneshot
 * flow: both outbound edges of `implementing` denied.
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

/** Synthesize retry cap (MAX_SYNTHESIZE_RETRIES). */
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

// Shared presence probes reused across workflows.
const PLAN_ARTIFACT_PRESENT = any(present('artifacts.plan'), present('plan'));
const PR_URL_PRESENT = any(present('synthesis.prUrl'), present('artifacts.pr'));
const TASKS_COMPLETE = all(
  cmp('tasks.count', 'gte', 1),
  eqBool('tasks.allComplete', true),
);
const RETRYABLE = all(
  present('synthesis.lastError'),
  cmp('synthesis.retryCount', 'lt', MAX_SYNTHESIZE_RETRIES),
);

// ─── Feature workflow ──────────────────────────────────────────────────────────

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

// ─── Debug workflow ────────────────────────────────────────────────────────────

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

// ─── Oneshot workflow ──────────────────────────────────────────────────────────

const ONESHOT_EDGES = buildEdges('oneshot', [
  {
    from: 'plan',
    to: 'implementing',
    toPhaseKind: 'IMPLEMENT',
    category: 'admission-requirement',
    legacyGuardId: 'oneshot-plan-set',
    // NOT a bare presence probe: `oneshotPlanSet` requires a TRIMMED NON-EMPTY
    // STRING. A bare `factPresent` admits `artifacts.plan = true`, `{}` or
    // `'   '`, all of which the guard denies.
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

// ─── Discovery workflow ────────────────────────────────────────────────────────

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

// ─── Refactor workflow ─────────────────────────────────────────────────────────

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

// ─── Registry ──────────────────────────────────────────────────────────────────

/** All built-in-workflow edges expressed in shared IR (deterministic order). */
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

/** Canonical key for an edge, stable across the IR and the translation. */
export function edgeKey(
  workflowType: string,
  from: string,
  to: string,
): string {
  return `${workflowType}:${from}:${to}`;
}

/** Look up the shared-IR edge for a (workflow, from, to), or undefined. */
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

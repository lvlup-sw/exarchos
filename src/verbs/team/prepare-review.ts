// ─── Prepare Review Orchestrate Handler ──────────────────────────────────────
//
// Serves the quality check catalog as structured data so that any LLM agent on
// any MCP platform can receive the catalog, execute checks (greps, structural
// analysis), and feed findings back to check_review_verdict.
// ──────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../../format.js';
import type { NextAction } from '../../next-action.js';
import type { EventStore } from '../../events/store.js';
import { QUALITY_CHECK_CATALOG } from '../../review/check-catalog.js';
import { loadProjectConfig } from '../../config/yaml-loader.js';
import { resolveConfig, DEFAULTS } from '../../config/resolve.js';
import { DEFAULT_MAX_PLAN_REVISIONS } from '../../workflow/guards.js';
import { resolvePlanReviewDepth, type PlanReviewRung } from '../../workflow/phase-kind.js';
import type { DesignDepth } from '../../workflow/plan-depth-policy.js';
import { changedFilesAgainstBase, deriveIntent, persistIntent } from '../tasks/extract-intent.js';
import type { WorkflowIntent } from '../../workflow/schemas.js';
import { dispatchShapeFor, type DispatchShape } from '../../runtime/agents/dispatch-shape.js';
import type { AgentPosture } from '../../runtime/agents/types.js';

// ─── DR-25: the posture this verb provisions ────────────────────────────────

/**
 * Both `prepare_review` paths provision a REVIEWER, and a reviewer mutates
 * nothing — the posture is `read-only` on the plan-review path and the
 * code-review path alike.
 *
 * Declared once, so the emitted `posture` and the emitted `dispatch` are
 * derived from the SAME value and cannot drift apart. That is the whole point
 * of DR-25: before this, `posture` was declared and the launch shape was left
 * to orchestrator convention, and the convention lost.
 *
 * `satisfies` (not a `: AgentPosture` annotation) keeps the `'read-only'`
 * LITERAL type — which `PlanReviewProvisioning.posture` narrows to — while
 * still rejecting a typo against the declared posture vocabulary at compile
 * time. Same idiom as `DISPATCH_PHASE_KIND` in `prepare-delegation.ts`.
 */
const REVIEW_POSTURE = 'read-only' satisfies AgentPosture;

/**
 * The launch shape the orchestrator MUST use for this posture (DR-25):
 * anonymous async subagent, `name` omitted. Read from the posture table, not
 * restated here.
 */
const REVIEW_DISPATCH: DispatchShape = dispatchShapeFor(REVIEW_POSTURE);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PrepareReviewArgs {
  readonly featureId: string;
  /**
   * Review scope. `'plan'` / `'plan-review'` selects the DR-10 front-of-pipeline
   * plan-review provisioning (a dispatched, fresh-context, adversarial pass over
   * the unified artifact). Any other value (or absent) serves the back-of-pipeline
   * code-review quality-check catalog (unchanged).
   */
  readonly scope?: string;
  readonly dimensions?: readonly string[];
  readonly repoRoot?: string;
  /**
   * The unified `docs/specs/` artifact path under review (plan-review scope).
   * Required when `scope` is `'plan'` — the dispatched reviewer is provisioned
   * with this and the spec, NEVER the authoring transcript.
   */
  readonly artifact?: string;
  /**
   * The spec/requirements reference the plan must satisfy (plan-review scope).
   * Defaults to the unified artifact itself (the collapsed doc carries the
   * design-rationale § the decomposition is judged against).
   */
  readonly spec?: string;
  /**
   * The feature's frozen `designDepth` (plan-review scope). The SAME value the
   * `'plan-structure'` design-section resolver reads — plan-review is its second
   * consumer (DR-10). Absent ⇒ the `'standard'` rung.
   */
  readonly designDepth?: DesignDepth;
  /**
   * The authoring transcript (code-review scope, DR-1 #1593). When supplied, the
   * extracted `WorkflowIntent` is enriched beyond the diff floor. Used ONLY on
   * the back-of-pipeline code-review path; the plan-review path is deliberately
   * transcript-free (adversarial, fresh-context — DR-10) and never reads this.
   */
  readonly transcript?: string;
}

// ─── Finding Format Schema ──────────────────────────────────────────────────

const FINDING_FORMAT = `interface PluginFinding {
  source: string;        // "catalog" | "impeccable" | custom
  severity: "HIGH" | "MEDIUM" | "LOW";
  dimension?: string;    // e.g., "error-handling"
  file?: string;
  line?: number;
  message: string;
}`;

// ─── DR-1 (#1593): intended-vs-delivered review grounding ─────────────────────

/**
 * The structured review-grounding directive the orchestrator threads into the
 * review subagent on the code-review path (DR-1 task 005). It pins the
 * INTENDED change (the captured `artifacts.intent` — surfaces + summary +
 * optional transcript line) against the DELIVERED diff so the reviewer can flag
 * intended-but-missing and delivered-but-unintended (scope-creep) work.
 *
 * Emitted ONLY when the intent is meaningful (`intent.changedFiles.length > 0`).
 * On the `NoIntent` path (empty/un-resolvable diff) the directive is omitted and
 * the review degrades to diff-only — no fabricated intent. INV-6: no
 * `workflowType` branch; the same shape rides for every workflow type.
 */
export interface IntentGrounding {
  readonly mode: 'intended-vs-delivered';
  /** The captured intent the delivered diff is checked against. */
  readonly intended: {
    readonly surfaces: readonly string[];
    readonly summary: string;
    readonly transcriptSummary?: string;
  };
  /** The reviewer instruction: verify INTENDED vs DELIVERED, flag both gaps. */
  readonly instruction: string;
}

const INTENT_GROUNDING_INSTRUCTION =
  'Verify INTENDED vs DELIVERED. The orchestrator captured the intended change ' +
  'in `artifacts.intent` (the `intended` surfaces/summary below); the DELIVERED ' +
  'change is the diff under review. Confirm the diff fulfils the intended ' +
  'change, and flag (a) intended-but-missing work and (b) delivered-but-' +
  'unintended work (scope creep) as spec issues.';

/**
 * Build the grounding directive when the intent is meaningful, else `undefined`
 * (the `NoIntent` degrade-to-diff-only path). Pure — no `workflowType` branch.
 */
function buildIntentGrounding(intent: WorkflowIntent): IntentGrounding | undefined {
  if (intent.changedFiles.length === 0) return undefined;
  return {
    mode: 'intended-vs-delivered',
    intended: {
      surfaces: intent.surfaces,
      summary: intent.summary,
      ...(intent.transcriptSummary ? { transcriptSummary: intent.transcriptSummary } : {}),
    },
    instruction: INTENT_GROUNDING_INSTRUCTION,
  };
}

// ─── DR-10: plan-review provisioning (front-of-pipeline adversarial gate) ─────

/** Scope tokens that select the plan-review provisioning path. */
const PLAN_REVIEW_SCOPES = new Set(['plan', 'plan-review']);

/**
 * The evidence-emitting verdict shape the dispatched plan-reviewer returns.
 * `default-to-reject`: the plan must actively SURVIVE refutation — a verdict is
 * not a rubric pass but a list of concrete, located gaps. An empty `gaps` array
 * with `verdict: "survives"` is the only way the plan clears the gate.
 */
const PLAN_REVIEW_VERDICT_FORMAT = `interface PlanReviewVerdict {
  verdict: "refuted" | "survives";   // default-to-reject; "survives" only if no HIGH gaps remain
  gaps: Array<{
    claim: string;                   // the plan claim / task being refuted
    flaw: string;                    // the concrete gap, missing case, or unjustified leap
    location?: string;               // section / task id in the unified artifact
    severity: "HIGH" | "MEDIUM" | "LOW";
  }>;
}`;

/**
 * The refutation instruction handed to the dispatched, fresh-context reviewer.
 * Adversarial posture (DR-10): the reviewer is told to actively REFUTE the plan,
 * not to score it against a rubric, and is reminded it has NO access to the
 * authoring transcript (so it cannot rationalize the author's choices).
 */
const PLAN_REVIEW_INSTRUCTION =
  'You are a fresh-context adversarial reviewer. You did NOT write this plan and have ' +
  'no access to the authoring transcript — only the unified artifact and the spec it ' +
  'must satisfy. Default to REJECT: assume the plan is flawed and try to refute it. ' +
  'For every requirement in the spec, find the task(s) that satisfy it or record a HIGH ' +
  'gap. Surface unjustified leaps, missing edge cases, and untestable acceptance criteria ' +
  'as concrete, located gaps. Return a PlanReviewVerdict — "survives" only if no HIGH gap remains.';

/**
 * Assemble the dispatched plan-review provisioning payload (DR-10). The payload
 * is the contract a host fans out to a READ-ONLY (INV-11) reviewer that never
 * inherits the author's context: it carries ONLY `{ artifact, spec }`, a
 * refutation prompt, the depth-scaled rung, and the evidence-emitting verdict
 * format. `authoringTranscriptIncluded: false` is structural, not advisory —
 * the provisioning literally has no transcript field to populate.
 */
export interface PlanReviewProvisioning {
  readonly mode: 'plan-review';
  readonly posture: typeof REVIEW_POSTURE;
  /**
   * DR-25: the launch shape the orchestrator MUST use — anonymous async
   * subagent, `name` omitted. Required, not optional: a provisioning that
   * declares a posture without binding its dispatch is the defect this field
   * exists to remove. Carries its own `requires` / `fallback` so a host on a
   * runtime that cannot honour it resolves the DECLARED fallback rather than
   * improvising one.
   */
  readonly dispatch: DispatchShape;
  readonly adversarial: true;
  readonly instruction: string;
  readonly rung: PlanReviewRung;
  readonly provisionedContext: {
    readonly artifact: string;
    readonly spec: string;
    readonly authoringTranscriptIncluded: false;
  };
  readonly verdictFormat: string;
}

// ─── DR-2 (WLM-6): the stateful count+cap at the provisioning seam ─────────────

/**
 * The counted event the provisioning seam appends per plan-review dispatch. The
 * projection folds the MAX `ordinal` into `planReview.revisionCount` — the field
 * the `revisionsExhausted` guard reads — so the two agree on the bound.
 */
const PLAN_REVIEW_DISPATCHED_EVENT = 'workflow.plan-review-dispatched';

/**
 * Deterministic idempotency key (INV-8). SCOPE: it dedups a SAME-ordinal
 * re-append at the storage layer (a store-internal append retry within one
 * invocation), NOT a full handler re-invocation — a retry after a committed
 * append recomputes a higher `ordinal` from the durable count, so it yields a
 * different key and counts as a fresh re-dispatch. Bounding a genuine
 * re-invocation would need a client-supplied token (an `operationId` schema
 * field), which DR-2 deliberately does not add. Residual follow-up.
 */
function planReviewDispatchKey(featureId: string, ordinal: number): string {
  return `${featureId}:plan-review-dispatch:${ordinal}`;
}

/**
 * Resolve the plan-revision cap AT THE SEAM (DR-2). The seam cannot see the
 * transition-handler's `_maxPlanRevisions` state injection (`tools.ts`), so it
 * re-resolves from `.exarchos.yml` via the SAME resolver the guard's default
 * traces to: `resolveConfig(...).workflow.maxPlanRevisions`, which itself
 * defaults to `DEFAULT_MAX_PLAN_REVISIONS` (guards.ts) when unset. When no
 * `repoRoot` is supplied the seam falls back to that same constant directly, so
 * the seam and the `revisionsExhausted` backstop always read the identical cap.
 */
function resolveMaxPlanRevisions(repoRoot: string | undefined): number {
  if (!repoRoot) return DEFAULT_MAX_PLAN_REVISIONS;
  return resolveConfig(loadProjectConfig(repoRoot)).workflow.maxPlanRevisions;
}

/** The pure provisioning payload — the fresh-context adversarial contract (DR-10). */
function assemblePlanReviewProvisioning(args: PrepareReviewArgs): PlanReviewProvisioning {
  // Depth-scaled adversarial rung — the second consumer of the frozen
  // designDepth (DR-10). thin → light (1 voter); deep → multi-voter panel.
  const rung = resolvePlanReviewDepth(args.designDepth);
  return {
    mode: 'plan-review',
    posture: REVIEW_POSTURE,
    // DR-25: bound from the SAME literal the posture is emitted from.
    dispatch: REVIEW_DISPATCH,
    adversarial: true,
    instruction: PLAN_REVIEW_INSTRUCTION,
    rung,
    provisionedContext: {
      artifact: args.artifact as string,
      // In the collapsed world the artifact carries its own design-rationale §;
      // when no distinct spec ref is supplied the unified doc IS the spec.
      spec: args.spec ?? (args.artifact as string),
      // Structural guarantee — the dispatched reviewer is fresh-context and
      // never receives the authoring transcript (DR-10 / INV-11).
      authoringTranscriptIncluded: false,
    },
    verdictFormat: PLAN_REVIEW_VERDICT_FORMAT,
  };
}

/**
 * Stateful plan-review provisioning (DR-2, WLM-6). `prepare_review scope:plan`
 * is the ONE server action an agent MUST call to obtain a fresh-context
 * adversarial plan-review, so it is the seam that bounds the revision loop by
 * construction — closing the skippable-edge bypass (an agent could sit in
 * `plan-review`, re-provision + apply fixes + re-dispatch forever WITHOUT ever
 * traversing the counted `plan-review → plan` HSM edge, leaving `revisionCount`
 * at 0 and the `revisionsExhausted` guard permanently un-fed).
 *
 * On every call the seam reads the prior `workflow.plan-review-dispatched`
 * events for this feature to derive the dispatch `ordinal` (0-based) and the
 * folded `revisionCount` (= max prior ordinal = number of re-dispatches so far):
 *
 *   - INITIAL review (`ordinal 0`, no prior dispatch): append the ordinal-0
 *     marker and provision. The projection folds ordinal 0 → `revisionCount 0`,
 *     so the initial consumes NO revision. The marker is required: a traceless
 *     initial is indistinguishable from the first re-dispatch on a pure
 *     event-sourced stream, so it could not otherwise be told apart.
 *   - AT/OVER cap (`revisionCount >= maxPlanRevisions`): REFUSE at the seam with
 *     a structured park-at-`blocked` envelope (INV-5b/INV-12 — names the count
 *     and the cap, carries `validTargets`/`suggestedFix` + a `next_actions`
 *     affordance to transition to `blocked`) and provision NOTHING.
 *   - RE-DISPATCH under cap: append exactly one ordinal-N event (+1 revision)
 *     and provision.
 *
 * The append carries a deterministic idempotency key
 * (`${featureId}:plan-review-dispatch:${ordinal}`, INV-8) that dedups a
 * SAME-ordinal re-append at the storage layer (e.g. a store-internal append
 * retry). It does NOT make a full handler re-invocation idempotent: a retry
 * after a committed append recomputes a higher `ordinal` from the durable count
 * (see `planReviewDispatchKey`) → new key → a fresh re-dispatch is counted.
 * Genuine re-invocation idempotency would need a client token (out of DR-2
 * scope); the exposure is a single miscount only on a crash between the commit
 * and the response, noted as a follow-up.
 */
async function buildPlanReviewProvisioning(
  args: PrepareReviewArgs,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.artifact) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'artifact (the unified docs/specs/ path under review) is required for the plan-review provisioning scope ("plan" / "plan-review")',
      },
    };
  }

  const maxPlanRevisions = resolveMaxPlanRevisions(args.repoRoot);

  // Count prior dispatches for this feature. `ordinal` is the 0-based index of
  // THIS dispatch; the folded `revisionCount` (the value the guard reads) is the
  // max PRIOR ordinal = `priorDispatches - 1`, floored at 0 (0 when this is the
  // initial). The seam owns this counter, so we derive it from the durable
  // dispatch events directly rather than materializing the whole projection.
  const priorDispatches = await eventStore.query(args.featureId, {
    type: PLAN_REVIEW_DISPATCHED_EVENT,
  });
  const ordinal = priorDispatches.length;
  const revisionCount = Math.max(0, ordinal - 1);

  // Over-cap refusal — only reachable on a re-dispatch (the initial's
  // `revisionCount` is 0 and `maxPlanRevisions >= 1`, so it never parks).
  if (ordinal > 0 && revisionCount >= maxPlanRevisions) {
    const message =
      `plan-review revision cap reached: ${revisionCount}/${maxPlanRevisions} ` +
      `revisions consumed. No further adversarial plan-review will be provisioned — ` +
      `transition to "blocked" and escalate to a human to resolve the outstanding gaps ` +
      `(or raise workflow.maxPlanRevisions in .exarchos.yml).`;
    const nextActions: NextAction[] = [
      {
        verb: 'blocked',
        reason: `plan-review revisions exhausted (${revisionCount}/${maxPlanRevisions}); park for human resolution`,
        validTargets: ['blocked'],
        hint: 'exarchos_workflow transition → "blocked"',
      },
    ];
    return {
      success: false,
      error: {
        code: 'PLAN_REVISIONS_EXHAUSTED',
        message,
        validTargets: ['blocked'],
        suggestedFix: { tool: 'exarchos_workflow', params: { action: 'transition', to: 'blocked' } },
      },
      next_actions: nextActions,
    };
  }

  // Provision: append the counted dispatch marker (idempotent by ordinal key),
  // THEN return the provisioning contract. The initial (ordinal 0) folds to
  // revision 0; each re-dispatch (ordinal N) folds to revision N.
  await eventStore.append(
    args.featureId,
    {
      type: PLAN_REVIEW_DISPATCHED_EVENT,
      data: { featureId: args.featureId, ordinal },
    },
    { idempotencyKey: planReviewDispatchKey(args.featureId, ordinal) },
  );

  return { success: true, data: assemblePlanReviewProvisioning(args) };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handlePrepareReview(
  args: PrepareReviewArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  // 1. Validate required fields
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  // 1a. DR-10 — front-of-pipeline plan-review provisioning. A dispatched,
  // fresh-context, adversarial pass over the unified artifact; distinct from the
  // back-of-pipeline code-review catalog served below. The plan-review path is
  // deliberately transcript-free — NO intent extraction happens here. DR-2
  // (WLM-6): this is also the stateful count+cap seam that bounds the plan-review
  // revision loop (it appends the counted `workflow.plan-review-dispatched`
  // event via the `eventStore` and refuses over-cap re-dispatches).
  if (args.scope && PLAN_REVIEW_SCOPES.has(args.scope)) {
    return buildPlanReviewProvisioning(args, eventStore);
  }

  // 1b. Validate `dimensions` BEFORE any state mutation. An unknown dimension is
  // INVALID_INPUT and must fail without persisting intent — otherwise a bad
  // request would still mutate `artifacts.intent` before erroring.
  let dimensions = QUALITY_CHECK_CATALOG.dimensions;
  if (args.dimensions?.length) {
    const validIds = new Set(QUALITY_CHECK_CATALOG.dimensions.map((d) => d.id));
    const invalid = args.dimensions.filter((id) => !validIds.has(id));
    if (invalid.length > 0) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `Unknown dimension(s): ${invalid.join(', ')}. Valid: ${[...validIds].join(', ')}`,
        },
      };
    }
    const requested = new Set(args.dimensions);
    dimensions = QUALITY_CHECK_CATALOG.dimensions.filter((d) => requested.has(d.id));
  }

  // 1c. DR-1 (#1593) — back-of-pipeline code-review path ONLY: derive the
  // diff-floor intent (enriched when a transcript is supplied) and persist it to
  // `artifacts.intent` via a single state-patch event. This is the intent
  // FOUNDATION: REVIEW (task 005) and PR-body generation (task 006) read it
  // back. Fail-soft — `persistIntent` never throws, so the quality-check catalog
  // is still served even when the state-patch hiccups (an `intentWarning` rides
  // along on the response). INV-6: the derivation takes no `workflowType`, so
  // the same path runs for every workflow type. Runs AFTER dimension validation
  // so an invalid request never reaches this state-mutating step.
  const intent = deriveIntent(changedFilesAgainstBase(args.repoRoot), {
    transcript: args.transcript,
  });
  const persisted = await persistIntent(args.featureId, intent, stateDir, eventStore);
  // DR-1 task 005: the review-grounding directive the orchestrator passes into
  // the review subagent. Present only when the intent is meaningful;
  // omitted on the `NoIntent` path so the review degrades to diff-only.
  const intentGrounding = buildIntentGrounding(intent);

  // 3. Resolve plugin status from .exarchos.yml if repoRoot provided, else defaults
  const resolved = args.repoRoot
    ? resolveConfig(loadProjectConfig(args.repoRoot))
    : undefined;

  const pluginStatus = {
    impeccable: {
      enabled: resolved?.plugins.impeccable.enabled ?? DEFAULTS.plugins.impeccable.enabled,
      hint: 'Install with: claude plugin install impeccable@impeccable',
    },
  };

  return {
    success: true,
    data: {
      catalog: {
        version: QUALITY_CHECK_CATALOG.version,
        dimensions,
      },
      findingFormat: FINDING_FORMAT,
      pluginStatus,
      // DR-25: the back-of-pipeline code review is dispatched too, and to the
      // same read-only reviewer — so it carries the same bound pair. Emitting
      // `posture` without `dispatch` here would leave the identical
      // improvisation gap the plan-review path just closed.
      posture: REVIEW_POSTURE,
      dispatch: REVIEW_DISPATCH,
      // DR-1 (#1593): the derived intent rides along for convenience; the
      // load-bearing contract is its persistence to `artifacts.intent` above.
      // The warning surfaces a fail-soft persist so callers aren't silent.
      intent,
      ...(persisted.warning ? { intentWarning: persisted.warning } : {}),
      // DR-1 task 005: the intended-vs-delivered grounding directive — present
      // only when the intent is meaningful, omitted on the `NoIntent` path.
      ...(intentGrounding ? { intentGrounding } : {}),
    },
  };
}

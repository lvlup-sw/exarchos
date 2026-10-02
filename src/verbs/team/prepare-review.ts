/**
 * The `prepare_review` handler. It provisions a review in one of two scopes.
 *
 * The plan scope provisions a fresh-context adversarial review of the plan
 * artifact. It records each dispatch and refuses a dispatch past the revision
 * cap. The code scope serves the quality check catalog. An agent on any MCP
 * platform can run the checks and send the findings to `check_review_verdict`.
 */

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

/**
 * Both scopes provision a reviewer, and a reviewer changes nothing, so the
 * posture is `read-only`. The emitted `posture` and `dispatch` both derive from
 * this one value, so they cannot drift apart. `satisfies` keeps the literal
 * type and still rejects a posture that is not in the vocabulary.
 */
const REVIEW_POSTURE = 'read-only' satisfies AgentPosture;

/** The launch shape that the orchestrator must use for this posture, from the posture table. */
const REVIEW_DISPATCH: DispatchShape = dispatchShapeFor(REVIEW_POSTURE);

export interface PrepareReviewArgs {
  readonly featureId: string;
  /**
   * `'plan'` or `'plan-review'` selects plan-review provisioning. Any other
   * value, or no value, serves the code-review quality check catalog.
   */
  readonly scope?: string;
  readonly dimensions?: readonly string[];
  readonly repoRoot?: string;
  /**
   * The path of the plan artifact under review. The plan scope requires it.
   * The reviewer gets this path and the spec, never the authoring transcript.
   */
  readonly artifact?: string;
  /** The spec that the plan must satisfy, in the plan scope. The default is the artifact. */
  readonly spec?: string;
  /**
   * The frozen `designDepth` of the feature, in the plan scope. It selects the
   * review rung. Without it, the rung is `'standard'`.
   */
  readonly designDepth?: DesignDepth;
  /**
   * The authoring transcript, in the code scope only. When it is set, the
   * extracted `WorkflowIntent` holds more than the diff gives. The plan scope
   * never reads it, so the plan review stays fresh-context.
   */
  readonly transcript?: string;
}

/** The TypeScript shape of a review finding, sent to the agent as text. */
const FINDING_FORMAT = `interface PluginFinding {
  source: string;        // "catalog" | "impeccable" | custom
  severity: "HIGH" | "MEDIUM" | "LOW";
  dimension?: string;    // e.g., "error-handling"
  file?: string;
  line?: number;
  message: string;
}`;

/**
 * The directive that the orchestrator passes to the code-review subagent. It
 * sets the intended change from `artifacts.intent` against the delivered diff.
 * Then the reviewer can flag intended work that is missing and delivered work
 * that is not intended.
 *
 * The handler emits it only when the intent has changed files. Without it, the
 * review uses only the diff. The shape is the same for every workflow type.
 */
export interface IntentGrounding {
  readonly mode: 'intended-vs-delivered';
  /** The captured intent the delivered diff is checked against. */
  readonly intended: {
    readonly surfaces: readonly string[];
    readonly summary: string;
    readonly transcriptSummary?: string;
  };
  /** The reviewer instruction: compare the intended change with the diff, and flag both gaps. */
  readonly instruction: string;
}

const INTENT_GROUNDING_INSTRUCTION =
  'Verify INTENDED vs DELIVERED. The orchestrator captured the intended change ' +
  'in `artifacts.intent` (the `intended` surfaces/summary below); the DELIVERED ' +
  'change is the diff under review. Confirm the diff fulfils the intended ' +
  'change, and flag (a) intended-but-missing work and (b) delivered-but-' +
  'unintended work (scope creep) as spec issues.';

/** Builds the grounding directive, or returns `undefined` when the intent has no changed files. */
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

/** Scope tokens that select the plan-review provisioning path. */
const PLAN_REVIEW_SCOPES = new Set(['plan', 'plan-review']);

/**
 * The verdict shape that the plan reviewer returns: a verdict and a list of
 * located gaps. The default is reject.
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
 * The instruction for the fresh-context reviewer. It tells the reviewer to
 * refute the plan, not to score it. It also states that the reviewer has no
 * access to the authoring transcript.
 */
const PLAN_REVIEW_INSTRUCTION =
  'You are a fresh-context adversarial reviewer. You did NOT write this plan and have ' +
  'no access to the authoring transcript — only the unified artifact and the spec it ' +
  'must satisfy. Default to REJECT: assume the plan is flawed and try to refute it. ' +
  'For every requirement in the spec, find the task(s) that satisfy it or record a HIGH ' +
  'gap. Surface unjustified leaps, missing edge cases, and untestable acceptance criteria ' +
  'as concrete, located gaps. Return a PlanReviewVerdict — "survives" only if no HIGH gap remains.';

/**
 * The plan-review payload that a host sends to a read-only reviewer. It holds
 * the artifact and the spec, a refutation prompt, the rung, and the verdict
 * format. It has no transcript field, so `authoringTranscriptIncluded` is
 * always false.
 */
export interface PlanReviewProvisioning {
  readonly mode: 'plan-review';
  readonly posture: typeof REVIEW_POSTURE;
  /**
   * The launch shape that the orchestrator must use. It is required, so a
   * posture always comes with its dispatch. Its `requires` and `fallback` tell
   * a host that cannot honor the shape which fallback to use.
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

/**
 * The event that the handler appends for each plan-review dispatch. The
 * projection folds the highest `ordinal` into `planReview.revisionCount`, which
 * the `revisionsExhausted` guard reads.
 */
const PLAN_REVIEW_DISPATCHED_EVENT = 'workflow.plan-review-dispatched';

/**
 * The idempotency key for a dispatch event. It removes a second append of the
 * same ordinal inside the store. It does not make a handler retry idempotent.
 * A retry after a committed append computes a higher ordinal, so it counts as
 * a new dispatch.
 */
function planReviewDispatchKey(featureId: string, ordinal: number): string {
  return `${featureId}:plan-review-dispatch:${ordinal}`;
}

/**
 * Resolves the plan-revision cap from `.exarchos.yml`. The handler cannot see
 * the `_maxPlanRevisions` value that the transition handler injects, so it uses
 * the same resolver as the guard. Without `repoRoot`, it uses
 * `DEFAULT_MAX_PLAN_REVISIONS`. Thus the handler and the guard read the same cap.
 */
function resolveMaxPlanRevisions(repoRoot: string | undefined): number {
  if (!repoRoot) return DEFAULT_MAX_PLAN_REVISIONS;
  return resolveConfig(loadProjectConfig(repoRoot)).workflow.maxPlanRevisions;
}

/**
 * Builds the plan-review payload. The rung scales with `designDepth`. Without
 * a separate `spec`, the artifact is also the spec.
 */
function assemblePlanReviewProvisioning(args: PrepareReviewArgs): PlanReviewProvisioning {
  const rung = resolvePlanReviewDepth(args.designDepth);
  return {
    mode: 'plan-review',
    posture: REVIEW_POSTURE,
    dispatch: REVIEW_DISPATCH,
    adversarial: true,
    instruction: PLAN_REVIEW_INSTRUCTION,
    rung,
    provisionedContext: {
      artifact: args.artifact as string,
      spec: args.spec ?? (args.artifact as string),
      authoringTranscriptIncluded: false,
    },
    verdictFormat: PLAN_REVIEW_VERDICT_FORMAT,
  };
}

/**
 * Provisions a plan review and counts it against the revision cap.
 *
 * An agent must call this action to get a plan review, so the count occurs
 * here. Without it, an agent can loop in `plan-review` and never cross the
 * counted edge back to `plan`. The `ordinal` is the number of earlier dispatch
 * events. The first dispatch appends ordinal 0 and uses no revision, but its
 * marker lets the next dispatch count as a revision. At the cap, the handler
 * refuses with PLAN_REVISIONS_EXHAUSTED and a `blocked` next action.
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

  const priorDispatches = await eventStore.query(args.featureId, {
    type: PLAN_REVIEW_DISPATCHED_EVENT,
  });
  const ordinal = priorDispatches.length;
  const revisionCount = Math.max(0, ordinal - 1);

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

/**
 * Serves a plan review or the code-review catalog.
 *
 * The code scope checks `dimensions` before it writes any state, so a bad
 * request does not change `artifacts.intent`. Then it derives the intent from
 * the diff and the transcript, and persists it. `persistIntent` never throws,
 * so a failed write adds an `intentWarning` and the catalog is still served.
 */
export async function handlePrepareReview(
  args: PrepareReviewArgs,
  stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (args.scope && PLAN_REVIEW_SCOPES.has(args.scope)) {
    return buildPlanReviewProvisioning(args, eventStore);
  }

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

  const intent = deriveIntent(changedFilesAgainstBase(args.repoRoot), {
    transcript: args.transcript,
  });
  const persisted = await persistIntent(args.featureId, intent, stateDir, eventStore);
  const intentGrounding = buildIntentGrounding(intent);

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
      posture: REVIEW_POSTURE,
      dispatch: REVIEW_DISPATCH,
      intent,
      ...(persisted.warning ? { intentWarning: persisted.warning } : {}),
      ...(intentGrounding ? { intentGrounding } : {}),
    },
  };
}

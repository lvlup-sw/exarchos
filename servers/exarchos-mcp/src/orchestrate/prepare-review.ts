// ─── Prepare Review Orchestrate Handler ──────────────────────────────────────
//
// Serves the quality check catalog as structured data so that any LLM agent on
// any MCP platform can receive the catalog, execute checks (greps, structural
// analysis), and feed findings back to check_review_verdict.
// ──────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import { QUALITY_CHECK_CATALOG } from '../review/check-catalog.js';
import { loadProjectConfig } from '../config/yaml-loader.js';
import { resolveConfig, DEFAULTS } from '../config/resolve.js';
import { resolvePlanReviewDepth, type PlanReviewRung } from '../workflow/phase-kind.js';
import type { DesignDepth } from '../workflow/plan-depth-policy.js';
import { changedFilesAgainstBase, deriveIntent, persistIntent } from './extract-intent.js';

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
  readonly posture: 'read-only';
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

function buildPlanReviewProvisioning(args: PrepareReviewArgs): ToolResult {
  if (!args.artifact) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'artifact (the unified docs/specs/ path under review) is required for the plan-review provisioning scope ("plan" / "plan-review")',
      },
    };
  }

  // Depth-scaled adversarial rung — the second consumer of the frozen
  // designDepth (DR-10). thin → light (1 voter); deep → multi-voter panel.
  const rung = resolvePlanReviewDepth(args.designDepth);

  const provisioning: PlanReviewProvisioning = {
    mode: 'plan-review',
    posture: 'read-only',
    adversarial: true,
    instruction: PLAN_REVIEW_INSTRUCTION,
    rung,
    provisionedContext: {
      artifact: args.artifact,
      // In the collapsed world the artifact carries its own design-rationale §;
      // when no distinct spec ref is supplied the unified doc IS the spec.
      spec: args.spec ?? args.artifact,
      // Structural guarantee — the dispatched reviewer is fresh-context and
      // never receives the authoring transcript (DR-10 / INV-11).
      authoringTranscriptIncluded: false,
    },
    verdictFormat: PLAN_REVIEW_VERDICT_FORMAT,
  };

  return { success: true, data: provisioning };
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
  // deliberately transcript-free — NO intent extraction happens here.
  if (args.scope && PLAN_REVIEW_SCOPES.has(args.scope)) {
    return buildPlanReviewProvisioning(args);
  }

  // 1b. DR-1 (#1593) — back-of-pipeline code-review path ONLY: derive the
  // diff-floor intent (enriched when a transcript is supplied) and persist it to
  // `artifacts.intent` via a single state-patch event. This is the intent
  // FOUNDATION: REVIEW (task 005) and PR-body generation (task 006) read it
  // back. Fail-soft — `persistIntent` never throws, so the quality-check catalog
  // is still served even when the state-patch hiccups (an `intentWarning` rides
  // along on the response). INV-6: the derivation takes no `workflowType`, so
  // the same path runs for every workflow type.
  const intent = deriveIntent(changedFilesAgainstBase(args.repoRoot), {
    transcript: args.transcript,
  });
  const persisted = await persistIntent(args.featureId, intent, stateDir, eventStore);

  // 2. Filter catalog by dimensions if requested
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
      // DR-1 (#1593): the derived intent rides along for convenience; the
      // load-bearing contract is its persistence to `artifacts.intent` above.
      // The warning surfaces a fail-soft persist so callers aren't silent.
      intent,
      ...(persisted.warning ? { intentWarning: persisted.warning } : {}),
    },
  };
}

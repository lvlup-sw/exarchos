// ─── Composite Orchestrate Handler ──────────────────────────────────────────
//
// Routes an `action` field to the appropriate task handler function,
// replacing individual MCP tools with a single `exarchos_orchestrate` tool.
// ────────────────────────────────────────────────────────────────────────────

import { wrap, wrapWithPassthrough, type ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { EventStore } from '../event-store/store.js';
import { handleDescribe } from '../describe/handler.js';
import { handleRunbook } from '../runbooks/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { nextActionsFromResult } from '../next-actions-from-result.js';

const orchestrateActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_orchestrate')!.actions;

// ─── Task Handlers ──────────────────────────────────────────────────────────

import {
  handleTaskClaim,
  handleTaskComplete,
  handleTaskFail,
} from '../tasks/tools.js';
import { handleReviewTriage } from '../review/tools.js';
import { handlePrepareDelegation } from './prepare-delegation.js';
import { handlePrepareSynthesis } from './prepare-synthesis.js';
import { handleAssessStack } from './assess-stack.js';
import { handleDesignCompleteness } from './design-completeness.js';
import { handlePlanCoverage } from './plan-coverage.js';
import { handleTddCompliance } from './tdd-compliance.js';
import { handleTestAdequacy } from './test-adequacy-handler.js';
import { handleContractDrift } from './contract-drift-handler.js';
import { handleMockBoundary } from './mock-boundary-handler.js';
import { handlePostMerge } from './post-merge.js';
import { handleStaticAnalysis } from './static-analysis.js';
import { handleCheckIntegrationSuite } from './check-integration-suite.js';
import { handleSecurityScan } from './security-scan.js';
import { handleContextEconomy } from './context-economy.js';
import { handleOperationalResilience } from './operational-resilience.js';
import { handleWorkflowDeterminism } from './workflow-determinism.js';
import { handleReviewVerdict } from './review-verdict.js';
import { handleCheckConvergence } from './check-convergence.js';
import { handleProvenanceChain } from './provenance-chain.js';
import { handleTaskDecomposition } from './task-decomposition.js';
import { handleCheckEventEmissions } from './check-event-emissions.js';
import { handleAgentSpec } from '../agents/handler.js';
import { handleExtractTask } from './extract-task.js';
import { handleReviewDiff } from './review-diff.js';
import { handleVerifyWorktree } from './verify-worktree.js';
import { handleSelectDebugTrack } from './select-debug-track.js';
import { handleInvestigationTimer } from './investigation-timer.js';
import { handleCheckCoverageThresholds } from './check-coverage-thresholds.js';
import { handleAssessRefactorScope } from './assess-refactor-scope.js';
import { handleCheckPrComments } from './check-pr-comments.js';
import { handleValidatePrBody } from './validate-pr-body.js';
import { handleValidatePrStack } from './validate-pr-stack.js';
import { handleDebugReviewGate } from './debug-review-gate.js';
import { handleExtractFixTasks } from './extract-fix-tasks.js';
import { handleClassifyReviewItems } from './classify-review-items.js';
import { handleGenerateTraceability } from './generate-traceability.js';
import { handleSpecCoverageCheck } from './spec-coverage-check.js';
import { handleVerifyWorktreeBaseline } from './verify-worktree-baseline.js';
import { handleSetupWorktree, type SetupWorktreeArgs } from './setup-worktree.js';
import { handleVerifyDelegationSaga } from './verify-delegation-saga.js';
import { handlePostDelegationCheck } from './post-delegation-check.js';
import { handleReconcileState } from './reconcile-state.js';
import { handlePreSynthesisCheck } from './pre-synthesis-check.js';
import { handleCheckCoderabbit } from './check-coderabbit.js';
import { handleCheckPolishScope } from './check-polish-scope.js';
import { handleNeedsSchemaSync } from './needs-schema-sync.js';
import { handleVerifyDocLinks } from './verify-doc-links.js';
import { handleVerifyReviewTriage } from './verify-review-triage.js';
import { handlePrepareReview } from './prepare-review.js';
import { handleCheckInvariantConformance } from './check-invariant-conformance.js';
import { handlePruneStaleWorkflows } from './prune-stale-workflows.js';
import { handleRequestSynthesize } from './request-synthesize.js';
import { handleFinalizeOneshot } from './finalize-oneshot.js';
import { handleDoctor } from './doctor/index.js';
import { handleOnboard } from './onboard/index.js';
import { handleCreatePr } from './vcs/create-pr.js';
import { handleMergePr } from './vcs/merge-pr.js';
import { handleCheckCi } from './vcs/check-ci.js';
import { handleListPrs } from './vcs/list-prs.js';
import { handleGetPrComments } from './vcs/get-pr-comments.js';
import { handleAddPrComment } from './vcs/add-pr-comment.js';
import { handleCreateIssue } from './vcs/create-issue.js';
import type { HandleCreateIssueArgs } from './vcs/create-issue.js';
import { createVcsProvider } from '../vcs/factory.js';
import { handleMergeOrchestrate } from './merge-orchestrate.js';
import { handleScaffold } from './invariants/scaffold.js';
import type { HandleScaffoldArgs } from './invariants/scaffold.js';
import { handleAdd } from './invariants/add.js';
import type { HandleAddArgs } from './invariants/add.js';
import { realScaffoldDeps } from './invariants/fs-deps.js';
import { applyLadderGateSeverity } from './gate-utils.js';
import { resolveWorkflowState } from './resolve-state.js';

// ─── Action Router ──────────────────────────────────────────────────────────

type ActionHandler = (args: Record<string, unknown>, stateDir: string, ctx?: DispatchContext) => Promise<ToolResult>;

/** Wraps a typed handler as an ActionHandler, narrowing Record<string, unknown> to T. */
function adapt<T>(handler: (args: T, stateDir: string) => Promise<ToolResult>): ActionHandler {
  return (args, stateDir) => handler(args as unknown as T, stateDir);
}

/** Wraps a typed handler that receives (args, ctx: DispatchContext). */
function adaptCtx<T>(handler: (args: T, ctx: DispatchContext) => Promise<ToolResult>): ActionHandler {
  return async (args, _stateDir, ctx) => {
    if (!ctx) throw new Error('DispatchContext required for this handler');
    return handler(args as unknown as T, ctx);
  };
}

/** Wraps a typed handler that takes only args (no stateDir) and may be sync or async. */
function adaptArgs<T>(handler: (args: T) => ToolResult | Promise<ToolResult>): ActionHandler {
  return async (args) => handler(args as unknown as T);
}

/** Wraps a typed handler that receives (args, stateDir, ctx?). */
function adaptWithCtx<T>(
  handler: (args: T, stateDir: string, ctx?: DispatchContext) => Promise<ToolResult>,
): ActionHandler {
  return async (args, stateDir, ctx) => handler(args as unknown as T, stateDir, ctx);
}

/** Wraps a typed handler that needs eventStore from DispatchContext injected into args. */
function adaptArgsWithEventStore<T>(handler: (args: T) => ToolResult | Promise<ToolResult>): ActionHandler {
  return async (args, _stateDir, ctx) => {
    const enriched = ctx?.eventStore ? { ...args, eventStore: ctx.eventStore } : args;
    return handler(enriched as unknown as T);
  };
}

/**
 * Wraps a typed handler that takes `(args, stateDir, eventStore)` — the
 * canonical shape for orchestrate handlers that need to append events.
 * Threads `ctx.eventStore` as the third positional arg so handlers
 * obtain the EventStore from the dispatch context rather than from a
 * module-global registry. See docs/rca/2026-04-26-v29-event-projection-
 * cluster.md (constructor injection refactor).
 */
function adaptWithEventStore<T>(
  handler: (args: T, stateDir: string, eventStore: EventStore) => Promise<ToolResult>,
): ActionHandler {
  return async (args, stateDir, ctx) => {
    if (!ctx?.eventStore) {
      throw new Error(
        `${handler.name}: ctx.eventStore required (handler dispatched without DispatchContext)`,
      );
    }
    return handler(args as unknown as T, stateDir, ctx.eventStore);
  };
}

// ─── Verification-ladder severity dispatch (task 005) ────────────────────────
//
// The five verification-ladder gates are INV-5b advisory carriers
// (`success:true, data.passed`). To apply per-workflow severity (e.g. oneshot
// → warning) we resolve the ACTUAL workflowType from workflow state ONCE per
// dispatch and post-process the handler's advisory result with
// `applyLadderGateSeverity`. The `dimension` per gate mirrors the dimension
// each handler stamps on its `gate.executed` event; it only matters as the
// dimension-level severity FALLBACK, which the workflow default takes priority
// over for these gates.

/**
 * Resolve a featureId's workflow type from workflow state, with the canonical
 * event-store fallback (`resolveWorkflowState`). NEVER reads `.state.json`
 * from disk directly. Returns `'feature'` when the type is absent or state is
 * unreadable — mirrors `check-invariant-conformance`'s `'feature'` default so
 * the non-oneshot path is unchanged on any resolution miss.
 */
async function resolveWorkflowTypeForGate(
  featureId: string | undefined,
  eventStore: EventStore,
): Promise<string> {
  if (!featureId) return 'feature';
  try {
    const resolved = await resolveWorkflowState({ featureId, eventStore });
    if ('error' in resolved) return 'feature';
    const wt = (resolved.state as { workflowType?: unknown }).workflowType;
    return typeof wt === 'string' && wt.length > 0 ? wt : 'feature';
  } catch {
    return 'feature';
  }
}

/**
 * Adapter for a verification-ladder gate handler. Runs the underlying advisory
 * handler, then resolves the workflow type and applies per-workflow severity
 * to a failing advisory verdict via {@link applyLadderGateSeverity}. When the
 * dispatch context carries no `projectConfig`, the result passes through
 * unchanged (legacy / no-config behavior). The threading is centralized here so
 * all five gates pick it up from one place.
 */
function adaptLadderGate<T>(
  gateName: string,
  dimension: string,
  handler: (args: T, stateDir: string, eventStore: EventStore) => Promise<ToolResult>,
): ActionHandler {
  return async (args, stateDir, ctx) => {
    if (!ctx?.eventStore) {
      throw new Error(
        `${handler.name}: ctx.eventStore required (handler dispatched without DispatchContext)`,
      );
    }
    // task 004: thread the dispatch-time projectConfig into the handler args so
    // its `resolvePolicySkip` self-skip routing consumes the SAME config-
    // resolved policy the delegation stamp used. Without this the skip path
    // would silently use the built-in table while the stamp honored a
    // `.exarchos.yml` `verification:` cell — the exact desync this slice closes.
    // Only inject when the args don't already carry `projectConfig` (an explicit
    // arg-level override, e.g. from a test, still wins).
    const enrichedArgs =
      ctx.projectConfig !== undefined &&
      (args as { projectConfig?: unknown }).projectConfig === undefined
        ? { ...(args as Record<string, unknown>), projectConfig: ctx.projectConfig }
        : args;
    // The config the handler actually resolved its self-skip routing against:
    // an arg-level `projectConfig` override wins, else the injected ctx config.
    // Severity post-processing MUST read the SAME config so skip routing and
    // severity adaptation can never resolve against divergent configs in one
    // dispatch (INV-2: identical DispatchContext + args ⇒ identical ToolResult).
    const effectiveProjectConfig = (enrichedArgs as {
      projectConfig?: DispatchContext['projectConfig'];
    }).projectConfig;
    const result = await handler(enrichedArgs as unknown as T, stateDir, ctx.eventStore);
    const featureId = (args as { featureId?: string }).featureId;
    const workflowType = await resolveWorkflowTypeForGate(featureId, ctx.eventStore);
    return applyLadderGateSeverity(
      gateName,
      dimension,
      effectiveProjectConfig,
      result,
      workflowType,
    );
  };
}

/**
 * Like {@link adaptWithEventStore}, but for handlers whose third positional
 * `eventStore` parameter is OPTIONAL. These handlers resolve workflow state
 * from EITHER an explicit `stateFile` OR `featureId` + event store, so they
 * degrade to the file-based path when no event store is available (e.g.
 * select-debug-track, investigation-timer). Threads `ctx?.eventStore` through
 * as the third positional arg WITHOUT throwing when it is absent — using the
 * throwing {@link adaptWithEventStore} here would crash a file-based dispatch
 * that the handler is designed to serve.
 */
function adaptWithOptionalEventStore<T>(
  handler: (args: T, stateDir: string, eventStore?: EventStore) => Promise<ToolResult>,
): ActionHandler {
  return async (args, stateDir, ctx) => handler(args as unknown as T, stateDir, ctx?.eventStore);
}

/**
 * Wraps a typed handler that needs BOTH `stateDir` and `eventStore` from
 * DispatchContext injected into a single args object. Use this when the
 * underlying handler accepts a single bag of args containing all dependencies
 * (rather than the conventional `(args, stateDir)` positional shape) — e.g.,
 * `handleFinalizeOneshot` whose `FinalizeOneshotArgs` includes both fields.
 */
function adaptArgsWithStateDirAndEventStore<T>(
  handler: (args: T) => ToolResult | Promise<ToolResult>,
): ActionHandler {
  return async (args, stateDir, ctx) => {
    const enriched = {
      ...args,
      stateDir,
      ...(ctx?.eventStore ? { eventStore: ctx.eventStore } : {}),
    };
    return handler(enriched as unknown as T);
  };
}

/**
 * DR-3 (T-09, #1204): adapter for `setup_worktree` that pre-loads workflow
 * state when `featureId` and `ctx.eventStore` are both supplied. The handler
 * itself stays synchronous and source-of-truth for the resolution priority
 * (args.branch > workflowState.tasks[id].branch > legacy default); this
 * adapter just feeds it the materialized `tasks` list so it can look up the
 * planned branch. Falls back to no workflow state when either prerequisite
 * is missing — preserves the legacy default behavior.
 */
function adaptSetupWorktree(): ActionHandler {
  return async (args, stateDir, ctx) => {
    const featureId = (args as { featureId?: string }).featureId;
    let workflowState:
      | {
          tasks?: Array<{ id: string; branch?: string }>;
          synthesis?: { integrationBranch?: string };
        }
      | undefined;

    if (featureId && ctx?.eventStore) {
      try {
        const { getOrCreateMaterializer, queryDeltaEvents } = await import('../views/tools.js');
        const { WORKFLOW_STATE_VIEW } = await import('../views/workflow-state-projection.js');
        const materializer = getOrCreateMaterializer(stateDir);
        const events = await queryDeltaEvents(
          ctx.eventStore,
          materializer,
          featureId,
          WORKFLOW_STATE_VIEW,
        );
        const view = materializer.materialize<{
          tasks: Array<{ id: string; branch?: string }>;
          synthesis?: { integrationBranch?: string };
        }>(featureId, WORKFLOW_STATE_VIEW, events);
        // #1509/#1501: project synthesis.integrationBranch so the handler can
        // base managed worktrees on the integration tip, not a stale `main`.
        workflowState = { tasks: view.tasks, synthesis: view.synthesis };
      } catch {
        // Best-effort: missing/unreadable state is not a setup_worktree
        // failure — handler falls back to legacy default branch.
        workflowState = undefined;
      }
    }

    // fix-005 (review #1213): the previous double-cast
    // (`args as unknown as Parameters<typeof handleSetupWorktree>[0]`)
    // defeated the type system. Cast directly to the exported
    // SetupWorktreeArgs — the registry hands `args` as a generic record,
    // and handleSetupWorktree validates required fields at runtime, so a
    // single cast at this adapter boundary is the narrowest sound option.
    return handleSetupWorktree(args as unknown as SetupWorktreeArgs, workflowState);
  };
}

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  task_claim: adaptWithEventStore(handleTaskClaim),
  task_complete: adaptWithEventStore(handleTaskComplete),
  task_fail: adaptWithEventStore(handleTaskFail),
  review_triage: adaptWithEventStore(handleReviewTriage),
  prepare_delegation: adaptWithCtx(handlePrepareDelegation),
  prepare_synthesis: adaptWithEventStore(handlePrepareSynthesis),
  assess_stack: adaptWithEventStore(handleAssessStack),
  check_design_completeness: adaptWithEventStore(handleDesignCompleteness),
  check_plan_coverage: adaptWithEventStore(handlePlanCoverage),
  check_tdd_compliance: adaptWithEventStore(handleTddCompliance),
  // Verification-ladder gates (task 005): wrapped in adaptLadderGate so a
  // failing advisory verdict picks up its per-workflow severity (oneshot →
  // warning) from the resolved workflowType. The `dimension` mirrors each
  // handler's stamped gate.executed dimension (fallback only — the workflow
  // default takes priority for ladder gates).
  check_test_adequacy: adaptLadderGate('check_test_adequacy', 'D1', handleTestAdequacy),
  check_contract_drift: adaptLadderGate('check_contract_drift', 'D1', handleContractDrift),
  check_mock_boundary: adaptLadderGate('check_mock_boundary', 'D1', handleMockBoundary),
  check_post_merge: adaptWithEventStore(handlePostMerge),
  check_static_analysis: adaptLadderGate('check_static_analysis', 'D2', handleStaticAnalysis),
  check_integration_suite: adaptLadderGate('check_integration_suite', 'D2', handleCheckIntegrationSuite),
  check_security_scan: adaptWithEventStore(handleSecurityScan),
  check_context_economy: adaptWithEventStore(handleContextEconomy),
  check_operational_resilience: adaptWithEventStore(handleOperationalResilience),
  check_workflow_determinism: adaptWithEventStore(handleWorkflowDeterminism),
  check_review_verdict: adaptWithEventStore(handleReviewVerdict),
  check_convergence: adaptWithEventStore(handleCheckConvergence),
  check_provenance_chain: adaptWithEventStore(handleProvenanceChain),
  check_task_decomposition: adaptWithEventStore(handleTaskDecomposition),
  check_event_emissions: adaptWithEventStore(handleCheckEventEmissions),
  agent_spec: adapt(handleAgentSpec),
  extract_task: adapt(handleExtractTask),
  review_diff: adapt(handleReviewDiff),
  verify_worktree: adapt(handleVerifyWorktree),
  select_debug_track: adaptWithOptionalEventStore(handleSelectDebugTrack),
  investigation_timer: adaptWithOptionalEventStore(handleInvestigationTimer),
  check_coverage_thresholds: adaptArgs(handleCheckCoverageThresholds),
  assess_refactor_scope: adaptArgsWithEventStore(handleAssessRefactorScope),
  check_pr_comments: adaptArgs(handleCheckPrComments),
  validate_pr_body: adaptArgs(handleValidatePrBody),
  validate_pr_stack: adaptArgs(handleValidatePrStack),
  debug_review_gate: adaptArgs(handleDebugReviewGate),
  extract_fix_tasks: adaptArgsWithStateDirAndEventStore(handleExtractFixTasks),
  classify_review_items: adaptArgsWithEventStore(handleClassifyReviewItems),
  generate_traceability: adaptArgs(handleGenerateTraceability),
  spec_coverage_check: adaptArgs(handleSpecCoverageCheck),
  verify_worktree_baseline: adapt(handleVerifyWorktreeBaseline),
  setup_worktree: adaptSetupWorktree(),
  verify_delegation_saga: adaptArgs(handleVerifyDelegationSaga),
  post_delegation_check: adaptArgsWithEventStore(handlePostDelegationCheck),
  reconcile_state: adaptArgsWithEventStore(handleReconcileState),
  pre_synthesis_check: adaptArgsWithStateDirAndEventStore(handlePreSynthesisCheck),
  check_coderabbit: adaptArgs(handleCheckCoderabbit),
  check_polish_scope: adaptArgs(handleCheckPolishScope),
  needs_schema_sync: adaptArgs(handleNeedsSchemaSync),
  verify_doc_links: adaptArgs(handleVerifyDocLinks),
  verify_review_triage: adaptArgsWithStateDirAndEventStore(handleVerifyReviewTriage),
  prepare_review: adapt(handlePrepareReview),
  check_invariant_conformance: adaptWithEventStore(handleCheckInvariantConformance),
  // Oneshot + pruning (T4): handlePruneStaleWorkflows already matches the
  // ActionHandler `(args, stateDir, ctx?)` shape, so it is registered directly
  // without an adapter. The other two need their dependencies injected from
  // DispatchContext into a single args bag.
  //
  // The `as ActionHandler` cast is safe because:
  //   1. The handler's signature is `(args, stateDir, ctx?, deps?)` where
  //      `deps` has a default (`productionDeps(ctx)`) — meaning at runtime
  //      the router's 3-arg call `(args, stateDir, ctx)` produces a fully
  //      wired handler that matches `ActionHandler`'s `(args, stateDir, ctx)`.
  //   2. The 4th param is a testability seam only; production code never
  //      passes it, and no ActionHandler caller has reason to.
  // TypeScript's structural typing sees the extra optional parameter as a
  // mismatch with the strict `ActionHandler` signature, so the cast is the
  // minimal bridge. An adapter wrapper would just re-spread the same three
  // args with no narrowing benefit.
  prune_stale_workflows: handlePruneStaleWorkflows as ActionHandler,
  request_synthesize: adaptArgsWithStateDirAndEventStore(handleRequestSynthesize),
  finalize_oneshot: adaptArgsWithStateDirAndEventStore(handleFinalizeOneshot),
  // VCS actions — route through VcsProvider abstraction
  create_pr: adaptCtx(handleCreatePr),
  merge_pr: adaptCtx(handleMergePr),
  check_ci: adaptCtx(handleCheckCi),
  list_prs: adaptCtx(handleListPrs),
  get_pr_comments: adaptCtx(handleGetPrComments),
  add_pr_comment: adaptCtx(handleAddPrComment),
  // create_issue requires a provider-backed listIssuesByMarker for the
  // two-event-split recovery precheck (CodeRabbit #3224631237). Wire the
  // GitHub provider's searchIssuesByMarker here so the handler never falls
  // back to a no-op that would silently mask duplicate-issue bugs.
  create_issue: async (args, _stateDir, ctx) => {
    if (!ctx) throw new Error('DispatchContext required for this handler');
    const typedArgs = args as unknown as Omit<HandleCreateIssueArgs, 'listIssuesByMarker'> &
      Partial<Pick<HandleCreateIssueArgs, 'listIssuesByMarker'>>;
    // Lazy provider creation: only construct the VCS provider if the
    // caller hasn't injected a `listIssuesByMarker` (e.g. tests that
    // stub the recovery probe directly). Avoids surfacing provider
    // bootstrap errors before the handler's own input guards run.
    const listIssuesByMarker =
      typedArgs.listIssuesByMarker ??
      (async (operationId: string) => {
        const provider = await createVcsProvider({ config: ctx.projectConfig });
        return provider.searchIssuesByMarker(operationId);
      });
    return handleCreateIssue({ ...typedArgs, listIssuesByMarker }, ctx);
  },
  // Merge orchestrator (DR-MO-1) — composes preflight + executor under one
  // public entry point. The internal `handleExecuteMerge` (T15) is NOT
  // registered here; only `merge_orchestrate` is the public action verb.
  merge_orchestrate: adaptCtx(handleMergeOrchestrate),
};

/** Exported for sync test — ensures registry.ts stays in sync with handler keys. */
export const ACTION_HANDLER_KEYS: readonly string[] = Object.keys(ACTION_HANDLERS);

// ─── Envelope Wrapping (T038, DR-7) ─────────────────────────────────────────

/**
 * HATEOAS envelope wrapping for successful tool responses (T038 + T041, DR-7/DR-8).
 *
 * Successful results are re-shaped into `Envelope<T>` at the tool
 * boundary so agents see a stable contract with `next_actions`, `_meta`,
 * and `_perf` on every response. Mirrors the T036 treatment in
 * `workflow/composite.ts` — sub-handlers continue to return raw
 * `ToolResult` for internal callers (e.g. tests and parity harness).
 *
 * `next_actions` is derived by `nextActionsFromResult` — orchestrate task
 * handlers generally do not return workflow state in their response data
 * (task claims, reviews, diagnostics, etc.), so in practice this yields
 * `[]`. The call is retained for architectural symmetry with the workflow
 * composite; the function is a pure, cheap lookup.
 *
 * Error responses pass through unchanged so structured `error` payloads
 * (error codes, valid transition targets, suggested fixes) remain
 * accessible to callers for auto-correction flows.
 */
/**
 * Guard-clause validation for the fields shared by `invariants_scaffold` and
 * `invariants_add`. Returns an `INVALID_INPUT` `ToolResult` on the first
 * malformed field, or `null` when every present field is well-typed. Runs at
 * the dispatch boundary BEFORE the unchecked `rest.*` casts reach a handler
 * (#1487 review). `repoRoot`/`path`/`catalog`/`id` must be strings when
 * present; `tier` must be `'dev' | 'user'` when present.
 */
function validateInvariantsCommonArgs(
  rest: Record<string, unknown>,
): ToolResult | null {
  const stringFields: ReadonlyArray<'repoRoot' | 'path' | 'catalog' | 'id'> = [
    'repoRoot',
    'path',
    'catalog',
    'id',
  ];
  for (const field of stringFields) {
    if (rest[field] !== undefined && typeof rest[field] !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: `${field} must be a string when provided`,
        },
      };
    }
  }
  if (
    rest.tier !== undefined &&
    rest.tier !== 'dev' &&
    rest.tier !== 'user'
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: "tier must be 'dev' or 'user' when provided",
        expectedShape: { tier: "'dev' | 'user'" },
      },
    };
  }
  if (
    rest.allowReservedTier !== undefined &&
    typeof rest.allowReservedTier !== 'boolean'
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'allowReservedTier must be a boolean when provided',
        expectedShape: { allowReservedTier: 'boolean' },
      },
    };
  }
  return null;
}

/**
 * Guard-clause validation for `invariants_add`. Layers the entry/dryRun checks
 * on top of the common string/tier checks: `entry` must be a plain object (the
 * authored invariant), and `dryRun` must coerce cleanly to boolean (defaulting
 * to true downstream). Returns an `INVALID_INPUT` `ToolResult` or `null`.
 */
function validateInvariantsAddArgs(
  rest: Record<string, unknown>,
): ToolResult | null {
  const common = validateInvariantsCommonArgs(rest);
  if (common) return common;
  if (
    rest.entry === undefined ||
    rest.entry === null ||
    typeof rest.entry !== 'object' ||
    Array.isArray(rest.entry)
  ) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'entry must be an object describing the invariant to add',
        expectedShape: { entry: { dimension: 'string', summary: 'string' } },
      },
    };
  }
  return null;
}

function envelopeWrap(result: ToolResult, startedAt: number): ToolResult {
  if (!result.success) return result;

  const meta = (result._meta ?? {}) as Record<string, unknown>;
  const perf = result._perf ?? { ms: Date.now() - startedAt };
  const nextActions = nextActionsFromResult(result);
  return wrapWithPassthrough(result, wrap(result.data, meta, perf, nextActions));
}

// ─── Composite Handler ──────────────────────────────────────────────────────

/**
 * Routes the `action` field from args to the corresponding task handler.
 *
 * The `action` field is consumed by this router and stripped from the args
 * forwarded to the underlying handler.
 */
export async function handleOrchestrate(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const { stateDir } = ctx;
  const { action, ...rest } = args;

  // Handle describe specially — it needs the action list, not stateDir
  if (action === 'describe') {
    if (!Array.isArray(rest.actions) || !rest.actions.every(a => typeof a === 'string')) {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'describe requires actions: string[]',
          expectedShape: { actions: ['action_name_1', 'action_name_2'] },
        },
      };
    }
    return envelopeWrap(await handleDescribe(rest as { actions: string[] }, orchestrateActions), startedAt);
  }

  // Handle doctor specially — it needs the full DispatchContext (not
  // just stateDir) because handleDoctor reads ctx.eventStore to emit
  // diagnostic.executed and delegates further context access to
  // buildProbes.
  if (action === 'doctor') {
    return envelopeWrap(await handleDoctor(rest as Parameters<typeof handleDoctor>[0], ctx), startedAt);
  }

  // Handle onboard specially — like doctor, it needs the full DispatchContext
  // (not just stateDir) because handleOnboard reads ctx.eventStore to build the
  // two-event seam (`onboard.requested`/`onboard.executed`) and resolves the
  // repo cwd from ctx. This is what makes `exarchos onboard` (cli.ts) and the
  // MCP `exarchos_orchestrate {action:'onboard'}` path actually route — without
  // this branch (and absent from ACTION_HANDLERS) the action falls through to
  // UNKNOWN_ACTION.
  //
  // `onboard` SUPERSEDES the legacy `init` action (whose dispatch branch +
  // handler were removed in DR-5, task 018): it reuses the SAME writer list
  // (`getAllWriters()`) via the reconciler's GENERATE step and emits the
  // two-event contract in place of the retired `init.executed`. The `init` CLI
  // verb is now a rename stub (cli.ts).
  if (action === 'onboard') {
    return envelopeWrap(await handleOnboard(rest as Parameters<typeof handleOnboard>[0], ctx), startedAt);
  }

  // invariants_scaffold (P2/T7) — writes a starter catalog + registers it in
  // `.exarchos.yml`. No events; needs real fs hooks (injected so the handler
  // stays pure-by-default for tests). repoRoot defaults to process.cwd().
  // Guard-clause validation runs BEFORE constructing the handler args so a
  // malformed dispatch returns a structured INVALID_INPUT envelope rather than
  // letting an unchecked cast reach the handler (#1487 review).
  if (action === 'invariants_scaffold') {
    const invalid = validateInvariantsCommonArgs(rest);
    if (invalid) return envelopeWrap(invalid, startedAt);
    const scaffoldArgs: HandleScaffoldArgs = {
      repoRoot: typeof rest.repoRoot === 'string' ? rest.repoRoot : process.cwd(),
      path: rest.path as string | undefined,
      tier: rest.tier as 'dev' | 'user' | undefined,
      allowReservedTier: rest.allowReservedTier as boolean | undefined,
    };
    return envelopeWrap(await handleScaffold(scaffoldArgs, realScaffoldDeps()), startedAt);
  }

  // invariants_add (P2/T11) — validates + (on commit) appends an entry and
  // emits invariant.authored / catalog.registered. Like init, it needs the
  // full DispatchContext because it uses ctx.eventStore to emit events.
  if (action === 'invariants_add') {
    const invalid = validateInvariantsAddArgs(rest);
    if (invalid) return envelopeWrap(invalid, startedAt);
    const addArgs: HandleAddArgs = {
      repoRoot: typeof rest.repoRoot === 'string' ? rest.repoRoot : process.cwd(),
      entry: rest.entry as Record<string, unknown>,
      catalog: rest.catalog as string | undefined,
      tier: rest.tier as 'dev' | 'user' | undefined,
      id: rest.id as string | undefined,
      dryRun: rest.dryRun === undefined ? true : Boolean(rest.dryRun),
      allowReservedTier: rest.allowReservedTier as boolean | undefined,
    };
    return envelopeWrap(await handleAdd(addArgs, ctx, realScaffoldDeps()), startedAt);
  }

  // Handle runbook specially — it doesn't need stateDir
  if (action === 'runbook') {
    if (rest.phase !== undefined && typeof rest.phase !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'runbook phase must be a string if provided',
        },
      };
    }
    if (rest.id !== undefined && typeof rest.id !== 'string') {
      return {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'runbook id must be a string if provided',
        },
      };
    }
    return envelopeWrap(await handleRunbook(rest as { phase?: string; id?: string }), startedAt);
  }

  const handler = typeof action === 'string' ? ACTION_HANDLERS[action] : undefined;
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ACTION',
        message: `Unknown orchestrate action '${String(action)}'. Valid actions: ${Object.keys(ACTION_HANDLERS).join(', ')}, describe, runbook, doctor, onboard, invariants_scaffold, invariants_add`,
      },
    };
  }

  return envelopeWrap(await handler(rest as Record<string, unknown>, stateDir, ctx), startedAt);
}

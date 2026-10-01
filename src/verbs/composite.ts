/**
 * Composite handler for the `exarchos_orchestrate` tool. It routes the `action` field to the matching handler.
 */

import { type ToolResult } from '../format.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import type { EventStore } from '../events/store.js';
import { handleDescribe } from '../describe/handler.js';
import { handleRunbook } from '../runbooks/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import { envelopeWrap } from '../envelope-wrap.js';
import { orchestrateLogger } from '../logger.js';

const orchestrateActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_orchestrate')!.actions;

import {
  handleTaskClaim,
  handleTaskComplete,
  handleTaskFail,
} from './tasks/tools.js';
import { handleReviewTriage } from '../review/tools.js';
import { handlePrepareDelegation } from './team/prepare-delegation.js';
import { handlePrepareSynthesis } from './team/prepare-synthesis.js';
import { handleAssessStack } from './vcs/assess-stack.js';
import { handleDesignCompleteness } from './gates/design-completeness.js';
import { handlePlanCoverage } from './gates/plan-coverage.js';
import { handleCheckExplorationDepth } from './gates/check-exploration-depth.js';
import { handleTestAdequacy } from './gates/test-adequacy-handler.js';
import { handleContractDrift } from './gates/contract-drift-handler.js';
import { handleMockBoundary } from './gates/mock-boundary-handler.js';
import { handleMutationAdequacy, MUTATION_GATE_NAME } from './gates/mutation-adequacy.js';
import { handlePostMerge } from './gates/post-merge.js';
import { handleStaticAnalysis } from './gates/static-analysis.js';
import { handleCheckIntegrationSuite } from './gates/check-integration-suite.js';
import { handleSecurityScan } from './gates/security-scan.js';
import { handleContextEconomy } from './gates/context-economy.js';
import { handleOperationalResilience } from './gates/operational-resilience.js';
import { handleWorkflowDeterminism } from './gates/workflow-determinism.js';
import { handleReviewVerdict } from './review/review-verdict.js';
import { handleCheckConvergence } from './gates/check-convergence.js';
import { handleProvenanceChain } from './gates/provenance-chain.js';
import { handleTaskDecomposition } from './tasks/task-decomposition.js';
import { handleCheckEventEmissions } from './gates/check-event-emissions.js';
import { handleAgentSpec } from '../runtime/agents/handler.js';
import { handleExtractTask } from './tasks/extract-task.js';
import { handleReviewDiff } from './review/review-diff.js';
import { handleVerifyWorktree } from './gates/verify-worktree.js';
import { handleSelectDebugTrack } from './review/select-debug-track.js';
import { handleInvestigationTimer } from './review/investigation-timer.js';
import { handleCheckCoverageThresholds } from './gates/check-coverage-thresholds.js';
import { handleAssessRefactorScope } from './gates/assess-refactor-scope.js';
import { handleCheckPrComments } from './vcs/check-pr-comments.js';
import { handleValidatePrBody } from './vcs/validate-pr-body.js';
import { handleValidatePrStack } from './vcs/validate-pr-stack.js';
import { handleDebugReviewGate } from './review/debug-review-gate.js';
import { handleExtractFixTasks } from './tasks/extract-fix-tasks.js';
import { handleClassifyReviewItems } from './review/classify-review-items.js';
import { handleGenerateTraceability } from './gates/generate-traceability.js';
import { handleSpecCoverageCheck } from './gates/spec-coverage-check.js';
import { handleVerifyWorktreeBaseline } from './gates/verify-worktree-baseline.js';
import { handleSetupWorktree, type SetupWorktreeArgs } from './team/setup-worktree.js';
import { handleVerifyDelegationSaga } from './team/verify-delegation-saga.js';
import { handlePostDelegationCheck } from './team/post-delegation-check.js';
import { handleReconcileState } from './reconcile-state.js';
import { handlePreSynthesisCheck } from './gates/pre-synthesis-check.js';
import { handleCheckCoderabbit } from './vcs/check-coderabbit.js';
import { handleCheckPolishScope } from './gates/check-polish-scope.js';
import { handleNeedsSchemaSync } from './gates/needs-schema-sync.js';
import { handleVerifyDocLinks } from './gates/verify-doc-links.js';
import { handleVerifyReviewTriage } from './review/verify-review-triage.js';
import { handlePrepareReview } from './team/prepare-review.js';
import { handleDiscoverBridge } from './tasks/discover-bridge.js';
import { handleCheckInvariantConformance } from './gates/check-invariant-conformance.js';
import { handlePruneStaleWorkflows } from './team/prune-stale-workflows.js';
import { handleRequestSynthesize } from './team/request-synthesize.js';
import { handleFinalizeOneshot } from './tasks/finalize-oneshot.js';
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
import { handleMergeOrchestrate } from './merge/merge-orchestrate.js';
import { handleStackPlace } from './stack/tools.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
  handlePruneWorktrees,
  handleReconcileWorktrees,
  handleSerializeMerge,
} from './worktree/handlers.js';
import {
  handleCutoverDecide,
  handleCutoverReadiness,
} from './gates/cutover-readiness.js';
import { handleScaffold } from './invariants/scaffold.js';
import type { HandleScaffoldArgs } from './invariants/scaffold.js';
import { handleAdd } from './invariants/add.js';
import { handleAmend } from './invariants/amend.js';
import type { HandleAmendArgs } from './invariants/amend.js';
import type { HandleAddArgs } from './invariants/add.js';
import { realScaffoldDeps } from './invariants/fs-deps.js';
import { applyLadderGateSeverity, resolvePhaseMode } from './gates/gate-utils.js';
import { resolveWorkflowState } from './resolve-state.js';
import { handleExecuteIntent, productionExecuteDeps } from './execute/executor.js';
import { handlePrepare } from './prepare/handler.js';
import { handleSettle } from './settle/handler.js';

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

/** Wraps a typed handler that takes only args (no stateDir) and can be sync or async. */
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
 * Wraps a typed handler of shape `(args, stateDir, eventStore)`, the usual shape for a handler that appends events.
 * It passes `ctx.eventStore` as the third argument, so the handler gets the store from the dispatch context and not from a module-global registry.
 * It throws when the context has no event store.
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

/**
 * Like {@link adaptWithEventStore}, but it also copies `ctx.projectConfig` into the handler args.
 * An explicit `projectConfig` in the args, such as from a test, wins.
 * It serves a handler that needs both the event store and the resolved config, such as `prepare_synthesis`.
 */
function adaptWithEventStoreAndConfig<T>(
  handler: (args: T, stateDir: string, eventStore: EventStore) => Promise<ToolResult>,
): ActionHandler {
  return async (args, stateDir, ctx) => {
    if (!ctx?.eventStore) {
      throw new Error(
        `${handler.name}: ctx.eventStore required (handler dispatched without DispatchContext)`,
      );
    }
    const enrichedArgs =
      ctx.projectConfig !== undefined &&
      (args as { projectConfig?: unknown }).projectConfig === undefined
        ? { ...(args as Record<string, unknown>), projectConfig: ctx.projectConfig }
        : args;
    return handler(enrichedArgs as unknown as T, stateDir, ctx.eventStore);
  };
}

/**
 * Resolves the workflow type of a feature from the event store, through `resolveWorkflowState`.
 * It returns `'feature'` when the type is absent or the state does not resolve, the same default as `check-invariant-conformance`.
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
 * Adapter for a verification-ladder gate. The gate handler returns an advisory result (`success: true` with `data.passed`).
 * The adapter resolves the workflow type once, then applies {@link applyLadderGateSeverity} with the IMPLEMENT-phase mode from `resolvePhaseMode`.
 * Only `oneshot` resolves to `audit`, which records a failing finding but does not block. Other workflow types resolve to `enforce`.
 * Without a `projectConfig`, an `enforce` result passes through unchanged, but an `audit` result still downgrades.
 *
 * The adapter copies `ctx.projectConfig` into the args when the args carry none, so the self-skip routing of the handler uses the dispatch config.
 * Severity reads the same effective config, and mode and severity read the same workflow type.
 * One dispatch thus never mixes two configs or two workflow types.
 * `dimension` is only a fallback for severity. For ladder gates, the workflow default takes priority over it.
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
    const enrichedArgs =
      ctx.projectConfig !== undefined &&
      (args as { projectConfig?: unknown }).projectConfig === undefined
        ? { ...(args as Record<string, unknown>), projectConfig: ctx.projectConfig }
        : args;
    const effectiveProjectConfig = (enrichedArgs as {
      projectConfig?: DispatchContext['projectConfig'];
    }).projectConfig;
    const result = await handler(enrichedArgs as unknown as T, stateDir, ctx.eventStore);
    const featureId = (args as { featureId?: string }).featureId;
    const workflowType = await resolveWorkflowTypeForGate(featureId, ctx.eventStore);
    const mode = resolvePhaseMode('IMPLEMENT', workflowType);
    return applyLadderGateSeverity(
      gateName,
      dimension,
      effectiveProjectConfig,
      result,
      workflowType,
      mode,
    );
  };
}

/**
 * Like {@link adaptWithEventStore}, but the `eventStore` argument is optional, and the adapter does not throw without it.
 * These handlers resolve state from `stateFile`, or from `featureId` with the event store, so they can serve a dispatch with no event store.
 * Examples are `select_debug_track` and `investigation_timer`.
 */
function adaptWithOptionalEventStore<T>(
  handler: (args: T, stateDir: string, eventStore?: EventStore) => Promise<ToolResult>,
): ActionHandler {
  return async (args, stateDir, ctx) => handler(args as unknown as T, stateDir, ctx?.eventStore);
}

/**
 * Wraps a handler that takes one args object, and adds `stateDir` and `ctx.eventStore` to that object.
 * An example is `handleFinalizeOneshot`, whose `FinalizeOneshotArgs` holds both fields.
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
 * Adapter for `setup_worktree`. With `featureId` and `ctx.eventStore`, it folds the workflow state to the tail and passes `tasks` and `synthesis` to the handler.
 * The handler owns the branch priority: `args.branch`, then the planned task branch, then the default.
 * `synthesis.integrationBranch` lets the handler base a managed worktree on the integration tip and not on a stale `main`.
 *
 * A coverage failure from the fold returns a refusal, because a fallback to `main` hides an integration tip that the fold cannot prove.
 * Any other fold error leaves the workflow state undefined, and the handler uses its default.
 * The handler validates its required fields at runtime, so the adapter casts the args without a check.
 */
function adaptSetupWorktree(): ActionHandler {
  return async (args, stateDir, ctx) => {
    const featureId = (args as { featureId?: string }).featureId;
    let workflowState:
      | {
          tasks?: Array<{ id: string; branch?: string }>;
          synthesis?: { integrationBranch?: string } | undefined;
        }
      | undefined;

    if (featureId && ctx?.eventStore) {
      try {
        const { getOrCreateMaterializer } = await import('../projections/views/tools.js');
        const { foldToTail } = await import('../projections/fold-at-tail.js');
        const { WORKFLOW_STATE_VIEW } = await import('../projections/views/workflow-state-projection.js');
        const materializer = getOrCreateMaterializer(stateDir);
        const { view } = await foldToTail<{
          tasks: Array<{ id: string; branch?: string }>;
          synthesis?: { integrationBranch?: string };
        }>(ctx.eventStore, materializer, featureId, WORKFLOW_STATE_VIEW);
        workflowState = { tasks: view.tasks, synthesis: view.synthesis };
      } catch (err) {
        const { toCoverageFailure } = await import('../projections/degraded-result.js');
        const refusal = toCoverageFailure(err, {
          tool: 'exarchos_orchestrate',
          action: 'setup_worktree',
        });
        if (refusal) return refusal;
        workflowState = undefined;
      }
    }

    return handleSetupWorktree(args as unknown as SetupWorktreeArgs, workflowState);
  };
}

/**
 * The tool that owns `ACTION_HANDLERS`.
 * The executor uses it to refuse a leaf whose tool differs from this owner. It does not assume that every key belongs to `exarchos_orchestrate`.
 */
const ACTION_HANDLERS_TOOL = 'exarchos_orchestrate';

/**
 * The routing table. The bounded action executor calls a compiled leaf through the same entry that this composite routes to.
 * A second copy of the mapping can drift from the registry, so this table is the only copy.
 * The executor gets the table as an argument from the `execute_intent` entry and does not import it, so the modules form no runtime import cycle.
 */
export const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  task_claim: adaptWithEventStore(handleTaskClaim),
  task_complete: adaptWithEventStore(handleTaskComplete),
  task_fail: adaptWithEventStore(handleTaskFail),
  review_triage: adaptWithEventStore(handleReviewTriage),
  prepare_delegation: adaptWithCtx(handlePrepareDelegation),
  prepare_synthesis: adaptWithEventStoreAndConfig(handlePrepareSynthesis),
  assess_stack: adaptWithEventStoreAndConfig(handleAssessStack),
  check_design_completeness: adaptWithEventStore(handleDesignCompleteness),
  check_plan_coverage: adaptWithEventStore(handlePlanCoverage),
  /**
   * Exploration-citation gate for the deep depth. At thin and standard depth, it skips itself.
   * At deep depth, it verifies that the `### Exploration` section of the spec cites the discover pass by path and `correlationId`.
   */
  check_exploration_depth: adaptWithEventStore(handleCheckExplorationDepth),
  /** Verification-ladder gate. {@link adaptLadderGate} applies the per-workflow severity to a failing advisory verdict. */
  check_test_adequacy: adaptLadderGate('check_test_adequacy', 'D1', handleTestAdequacy),
  check_contract_drift: adaptLadderGate('check_contract_drift', 'D1', handleContractDrift),
  check_mock_boundary: adaptLadderGate('check_mock_boundary', 'D1', handleMockBoundary),
  /**
   * Action of the mutation-adequacy review dimension. It is advisory by default, because its seeded gate default is warning-only.
   * A score under the threshold shows survivor `next_actions` and does not block.
   * An explicit `review.gates['mutation-adequacy']` override can make it blocking.
   */
  [MUTATION_GATE_NAME]: adaptLadderGate(MUTATION_GATE_NAME, 'D1', handleMutationAdequacy),
  check_post_merge: adaptWithEventStore(handlePostMerge),
  check_static_analysis: adaptLadderGate('check_static_analysis', 'D2', handleStaticAnalysis),
  check_integration_suite: adaptLadderGate('check_integration_suite', 'D2', handleCheckIntegrationSuite),
  check_security_scan: adaptWithEventStore(handleSecurityScan),
  check_context_economy: adaptWithEventStore(handleContextEconomy),
  check_operational_resilience: adaptWithEventStore(handleOperationalResilience),
  check_workflow_determinism: adaptWithEventStore(handleWorkflowDeterminism),
  check_review_verdict: adaptWithEventStoreAndConfig(handleReviewVerdict),
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
  check_coverage_thresholds: adaptWithEventStore(handleCheckCoverageThresholds),
  assess_refactor_scope: adaptArgsWithEventStore(handleAssessRefactorScope),
  check_pr_comments: adaptArgs(handleCheckPrComments),
  validate_pr_body: adaptWithOptionalEventStore(handleValidatePrBody),
  validate_pr_stack: adaptWithEventStore(handleValidatePrStack),
  debug_review_gate: adaptWithEventStore(handleDebugReviewGate),
  extract_fix_tasks: adaptArgsWithStateDirAndEventStore(handleExtractFixTasks),
  classify_review_items: adaptArgsWithEventStore(handleClassifyReviewItems),
  generate_traceability: adaptArgs(handleGenerateTraceability),
  spec_coverage_check: adaptWithEventStore(handleSpecCoverageCheck),
  verify_worktree_baseline: adapt(handleVerifyWorktreeBaseline),
  setup_worktree: adaptSetupWorktree(),
  verify_delegation_saga: adaptArgs(handleVerifyDelegationSaga),
  post_delegation_check: adaptArgsWithStateDirAndEventStore(handlePostDelegationCheck),
  reconcile_state: adaptArgsWithEventStore(handleReconcileState),
  pre_synthesis_check: adaptArgsWithStateDirAndEventStore(handlePreSynthesisCheck),
  check_coderabbit: adaptArgs(handleCheckCoderabbit),
  check_polish_scope: adaptArgs(handleCheckPolishScope),
  needs_schema_sync: adaptArgs(handleNeedsSchemaSync),
  verify_doc_links: adaptArgs(handleVerifyDocLinks),
  verify_review_triage: adaptArgsWithStateDirAndEventStore(handleVerifyReviewTriage),
  prepare_review: adaptWithEventStore(handlePrepareReview),
  discover_bridge: adaptWithOptionalEventStore(handleDiscoverBridge),
  check_invariant_conformance: adaptWithEventStore(handleCheckInvariantConformance),
  /**
   * `handlePruneStaleWorkflows` takes `(args, stateDir, ctx?, deps?)`, and `deps` defaults to `productionDeps(ctx)`.
   * The router calls it with three arguments, so at runtime it is a complete `ActionHandler`. The fourth parameter is a test seam only.
   * TypeScript rejects the extra parameter against the strict `ActionHandler` signature, so a cast bridges the two types.
   */
  prune_stale_workflows: handlePruneStaleWorkflows as ActionHandler,
  request_synthesize: adaptArgsWithStateDirAndEventStore(handleRequestSynthesize),
  finalize_oneshot: adaptArgsWithStateDirAndEventStore(handleFinalizeOneshot),
  /** VCS action, routed through the `VcsProvider` abstraction. */
  create_pr: adaptCtx(handleCreatePr),
  merge_pr: adaptCtx(handleMergePr),
  check_ci: adaptCtx(handleCheckCi),
  list_prs: adaptCtx(handleListPrs),
  get_pr_comments: adaptCtx(handleGetPrComments),
  add_pr_comment: adaptCtx(handleAddPrComment),
  /**
   * `create_issue` needs a provider-backed `listIssuesByMarker` for its recovery precheck.
   * The entry wires `searchIssuesByMarker` of the VCS provider, so the handler never uses a no-op that hides duplicate issues.
   * It creates the provider only when the caller injects no `listIssuesByMarker`.
   * A provider startup error thus cannot come before the input checks of the handler.
   */
  create_issue: async (args, _stateDir, ctx) => {
    if (!ctx) throw new Error('DispatchContext required for this handler');
    const typedArgs = args as unknown as Omit<HandleCreateIssueArgs, 'listIssuesByMarker'> &
      Partial<Pick<HandleCreateIssueArgs, 'listIssuesByMarker'>>;
    const listIssuesByMarker =
      typedArgs.listIssuesByMarker ??
      (async (operationId: string) => {
        const provider = await createVcsProvider({ config: ctx.projectConfig });
        return provider.searchIssuesByMarker(operationId);
      });
    return handleCreateIssue({ ...typedArgs, listIssuesByMarker }, ctx);
  },
  /** Merge orchestrator. It composes the preflight and the executor under one public action. The internal `handleExecuteMerge` is not in this table. */
  merge_orchestrate: adaptCtx(handleMergeOrchestrate),
  /**
   * Worktree lifecycle action. Each handler delegates to the in-process `WorktreeManager` over `ctx.eventStore`.
   * The third handler parameter is a test seam, left at its default. The read action, `worktrees`, is on `exarchos_view`.
   */
  acquire_worktree: adaptCtx(handleAcquireWorktree),
  release_worktree: adaptCtx(handleReleaseWorktree),
  prune_worktrees: adaptCtx(handlePruneWorktrees),
  /** Runs the three ground-truth reconcile passes. A read verb carries no writes, so this action declares the events that the passes append. */
  reconcile_worktrees: adaptCtx(handleReconcileWorktrees),
  /** Records a stack position and appends `stack.position-filled`. Its registration names this tool as the effect provider. */
  stack_place: adaptWithEventStore(handleStackPlace),
  /**
   * Integration-branch merge serializer: an optimistic lease for each `integrationRef` that composes `merge_orchestrate` unchanged.
   * It adds no visible tool. The third handler parameter keeps its production default.
   */
  serialize_merge: adaptCtx(handleSerializeMerge),
  /**
   * Cutover promotion: the read action. Its pair, `cutover_decide`, is the decision that an operator gates.
   * Both handlers take `(args, stateDir, eventStore)`. The fourth parameter is a test seam, left at its default.
   */
  cutover_readiness: adaptWithEventStore(handleCutoverReadiness),
  cutover_decide: adaptWithEventStore(handleCutoverDecide),
  /**
   * The bounded action executor. `handleExecuteIntent` requires a `DispatchContext`, because it re-enters admission and the store for each leaf.
   * The entry hands the table in, because an import of it from the executor makes a runtime cycle through the dispatch core.
   * The closure reads `ACTION_HANDLERS` only after the literal is bound, so the self-reference is safe.
   */
  execute_intent: async (args, stateDir, ctx) => {
    if (!ctx) throw new Error('DispatchContext required for execute_intent');
    return handleExecuteIntent(args, stateDir, ctx, productionExecuteDeps(ACTION_HANDLERS, ACTION_HANDLERS_TOOL));
  },
  /**
   * The settlement endpoint. It needs a real `DispatchContext`, because it reads the operation claim and commits through the store.
   * A settled batch runs the task-completion segment of each accepted task through the executor, so the entry also hands in the table.
   */
  settle: async (args, stateDir, ctx) => {
    if (!ctx) throw new Error('DispatchContext required for settle');
    return handleSettle(args, stateDir, ctx, {
      execute: productionExecuteDeps(ACTION_HANDLERS, ACTION_HANDLERS_TOOL),
    });
  },
  /** The compilation endpoint, the pair of `settle`. It reads the workflow and commits through the store, so it needs the real context. */
  prepare: async (args, stateDir, ctx) => {
    if (!ctx) throw new Error('DispatchContext required for prepare');
    return handlePrepare(args, stateDir, ctx);
  },
};

/** Exported for sync test — ensures registry.ts stays in sync with handler keys. */
export const ACTION_HANDLER_KEYS: readonly string[] = Object.keys(ACTION_HANDLERS);

/**
 * Guard-clause validation for the fields that `invariants_scaffold`, `invariants_add`, and `invariants_amend` share.
 * It returns an `INVALID_INPUT` result for the first bad field, or `null`. It runs before the unchecked `rest.*` casts reach a handler.
 * When present, `repoRoot`, `path`, `catalog`, and `id` must be strings, `tier` must be `'dev'` or `'user'`, and `allowReservedTier` must be a boolean.
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
 * Guard-clause validation for `invariants_add`. It runs the common checks, then requires `entry` to be a plain object.
 * It returns an `INVALID_INPUT` result, or `null`.
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

/**
 * Guard-clause validation for `invariants_amend`. It runs the common checks, then requires `id` and a plain-object `patch`.
 * `id` is required here, because it names the entry to correct. For `invariants_add`, `id` is an optional override.
 * It builds the handler args from the narrowed values, so the call site needs no `as` cast.
 */
function validateInvariantsAmendArgs(
  rest: Record<string, unknown>,
): { ok: false; result: ToolResult } | { ok: true; args: HandleAmendArgs } {
  const common = validateInvariantsCommonArgs(rest);
  if (common) return { ok: false, result: common };

  const { id, patch, repoRoot, catalog, tier, dryRun, allowReservedTier } = rest;

  if (typeof id !== 'string' || id.length === 0) {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            'id is required and must name the existing invariant entry to amend',
          expectedShape: { id: 'INV-17' },
        },
      },
    };
  }
  if (patch === undefined || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message:
            'patch must be an object naming the top-level entry fields to replace',
          expectedShape: { patch: { summary: 'the corrected summary text' } },
        },
      },
    };
  }

  return {
    ok: true,
    args: {
      repoRoot: typeof repoRoot === 'string' ? repoRoot : process.cwd(),
      id,
      patch: { ...patch },
      ...(typeof catalog === 'string' ? { catalog } : {}),
      ...(tier === 'dev' || tier === 'user' ? { tier } : {}),
      dryRun: dryRun === undefined ? true : Boolean(dryRun),
      ...(typeof allowReservedTier === 'boolean' ? { allowReservedTier } : {}),
    },
  };
}

/**
 * Routes the `action` field to its handler and strips `action` from the forwarded args.
 * It wraps a handler result in the HATEOAS envelope through `envelopeWrap`. Sub-handlers return a raw `ToolResult` for internal callers.
 *
 * Some actions have their own branch, because they need the full `DispatchContext`, the action list, or no `stateDir`.
 * A branch action needs both a registry entry and a branch here. Without the branch, it returns `UNKNOWN_ACTION`.
 * The `invariants_*` branches validate their args before the handler gets them.
 *
 * The `no-handler-throw` rule reads these `if (action === '<verb>')` branches to find the registered handlers. It reports a branch shape that it cannot read.
 * The router does not refuse a projection-derived verb on a `projection.degraded` marker. Such a verb folds a lagging projection forward before it answers.
 */
export async function handleOrchestrate(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const { stateDir } = ctx;
  const { action, ...rest } = args;

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

  if (action === 'doctor') {
    return envelopeWrap(await handleDoctor(rest as Parameters<typeof handleDoctor>[0], ctx), startedAt);
  }

  if (action === 'onboard') {
    return envelopeWrap(await handleOnboard(rest as Parameters<typeof handleOnboard>[0], ctx), startedAt);
  }

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

  if (action === 'invariants_amend') {
    const validated = validateInvariantsAmendArgs(rest);
    if (!validated.ok) return envelopeWrap(validated.result, startedAt);
    return envelopeWrap(
      await handleAmend(validated.args, ctx, realScaffoldDeps()),
      startedAt,
    );
  }

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
        message: `Unknown orchestrate action '${String(action)}'. Valid actions: ${Object.keys(ACTION_HANDLERS).join(', ')}, describe, runbook, doctor, onboard, invariants_scaffold, invariants_add, invariants_amend`,
      },
    };
  }

  return envelopeWrap(await handler(rest as Record<string, unknown>, stateDir, ctx), startedAt);
}

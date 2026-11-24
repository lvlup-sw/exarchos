/**
 * Composite handler for the `exarchos_orchestrate` tool. It routes the `action` field to the matching handler.
 */

import { canonicalJson } from '../contract/request-context.js';
import { TaskVerificationCoordinateSchema } from '../contract/capsule/exarchos-capsule.js';
import { type ToolResult } from '../format.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import type { EventType } from '../events/schemas.js';
import type { EventStore } from '../events/store.js';
import { handleDescribe } from '../describe/handler.js';
import { handleRunbook } from '../runbooks/handler.js';
import { TOOL_REGISTRY, type ToolAction } from '../registry.js';
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
import { handleDesignCompleteness } from './gates/design-completeness.js';
import { handlePlanCoverage } from './gates/plan-coverage.js';
import { handleCheckExplorationDepth } from './gates/check-exploration-depth.js';
import { handleContractDrift } from './gates/contract-drift-handler.js';
import { handleMockBoundary } from './gates/mock-boundary-handler.js';
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
import { handleValidatePrBody } from './vcs/validate-pr-body.js';
import { handleDebugReviewGate } from './review/debug-review-gate.js';
import { handleExtractFixTasks } from './tasks/extract-fix-tasks.js';
import { handleClassifyReviewItems } from './review/classify-review-items.js';
import { handleGenerateTraceability } from './gates/generate-traceability.js';
import { handleSpecCoverageCheck } from './gates/spec-coverage-check.js';
import { handleVerifyWorktreeBaseline } from './gates/verify-worktree-baseline.js';
import { handleVerifyDelegationSaga } from './team/verify-delegation-saga.js';
import { handlePostDelegationCheck } from './team/post-delegation-check.js';
import { handleReconcileState } from './reconcile-state.js';
import { handlePreSynthesisCheck, type PreSynthesisCheckArgs } from './gates/pre-synthesis-check.js';
import { handleCheckPolishScope, type CheckPolishScopeArgs } from './gates/check-polish-scope.js';
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
import { handleMergeOrchestrate } from './merge/merge-orchestrate.js';
import { handleStackPlace } from './stack/tools.js';
import {
  handleAcquireWorktree,
  handleReleaseWorktree,
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
import { withGateSeverity, type GateSeverityDescriptor } from './gates/gate-severity.js';
import { resolveWorkflowState } from './resolve-state.js';
import { TASK_COMPLETION } from '../runbooks/definitions.js';
import { handleExecuteIntent, productionExecuteDeps, derivedLeafOperationId } from './execute/executor.js';
import { handlePrepare } from './prepare/handler.js';
import { handleReadPreparedCapsule } from './prepare/read-prepared-capsule.js';
import { handleSettle } from './settle/handler.js';

type ActionHandler = (args: Record<string, unknown>, stateDir: string, ctx?: DispatchContext) => Promise<ToolResult>;

/**
 * The private terms of the retired verifier host. No handler reads them, and an adapter removes a caller copy from the args.
 * An old caller can still send them, so the removal keeps each handler call unchanged.
 */
const RETIRED_VERIFIER_TERMS: readonly string[] = ['verificationHost', 'hostAdequacy', 'hostCheck'];

/** The args without a caller copy of the retired verifier terms. */
function withoutPrivateTerms(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => !RETIRED_VERIFIER_TERMS.includes(key)));
}

/** The handler `inner` with a caller copy of the retired verifier terms removed from the args. */
function privateTermsRemoved(inner: ActionHandler): ActionHandler {
  return (args, stateDir, ctx) => inner(withoutPrivateTerms(args), stateDir, ctx);
}

/** Wraps a typed handler as an ActionHandler. The handler reads the args as its own type. */
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
 * It throws when the context has no event store. A handler with a fourth parameter of its own keeps its three-argument call.
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
        ? { ...args, projectConfig: ctx.projectConfig }
        : args;
    return handler(enrichedArgs as unknown as T, stateDir, ctx.eventStore);
  };
}

/**
 * Resolves the workflow type of a feature from the event store, through `resolveWorkflowState`.
 * It returns `'feature'` when `featureId` or the type is absent, or the state does not resolve. `check-invariant-conformance` uses the same default.
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

/** Refuses unbound or mismatched coordinate inputs before provider effects. */
function coordinateRefusal(args: Record<string, unknown>, ctx: DispatchContext | undefined, coordinateAware: boolean): ToolResult | undefined {
  const supplied = args.coordinate;
  const trusted = ctx?.verificationInput;
  if (supplied !== undefined || (coordinateAware && trusted !== undefined)) {
    const parsed = TaskVerificationCoordinateSchema.safeParse(supplied);
    if (!coordinateAware || trusted === undefined || !parsed.success
      || trusted.segmentOperationId.length === 0
      || parsed.data.taskId !== args.taskId || parsed.data.capsule.workflowId !== args.featureId
      || canonicalJson(parsed.data) !== canonicalJson(trusted.coordinate)) {
      return { success: false, error: { code: 'TASK_COORDINATE_REFUSED', message: 'The leaf coordinate requires matching bound segment authority.' } };
    }
  }
  return undefined;
}

/**
 * Adapter for a verification-ladder gate. It copies `ctx.projectConfig` into the args when the args carry none.
 * The self-skip routing of the handler thus reads the dispatch config. An explicit `projectConfig` in the args, such as from a test, wins.
 * The severity wrapper of the action table applies the severity and the IMPLEMENT-phase audit mode, so this adapter does not.
 *
 * `verificationProfile` comes only from the context. The adapter removes a value that the args carry, so a wire caller cannot pin a profile.
 * The adapter removes a caller copy of the retired verifier terms `hostAdequacy`, `hostCheck` and `verificationHost` from the args.
 * A check gate and the adequacy gate run in the local approved-check executor.
 * The adapter has two parameters, so the envelope rule resolves the handler of a call with a literal Boolean option.
 *
 * @internal Exported so that a test can call the adapter with a gate of its own.
 */
export function adaptLadderGate<T>(
  handler: (args: T, stateDir: string, eventStore: EventStore) => Promise<ToolResult>,
  coordinateAware = false,
): ActionHandler {
  return async (args, stateDir, ctx) => {
    if (!ctx?.eventStore) {
      throw new Error(
        `${handler.name}: ctx.eventStore required (handler dispatched without DispatchContext)`,
      );
    }
    const refusal = coordinateRefusal(args, ctx, coordinateAware);
    if (refusal !== undefined) return refusal;
    const enrichedArgs =
      ctx.projectConfig !== undefined &&
      (args as { projectConfig?: unknown }).projectConfig === undefined
        ? { ...(args as Record<string, unknown>), projectConfig: ctx.projectConfig }
        : args;
    const { verificationProfile: _carried, hostAdequacy: _host, hostCheck: _check, verificationHost: _verifier, ...unprofiledArgs } = enrichedArgs;
    const gateArgs =
      ctx.verificationProfile === undefined
        ? unprofiledArgs
        : { ...unprofiledArgs, verificationProfile: ctx.verificationProfile };
    const selectedArgs = coordinateAware && ctx.verificationInput !== undefined
      ? { ...gateArgs, coordinate: ctx.verificationInput.coordinate } : gateArgs;
    return handler(selectedArgs as unknown as T, stateDir, ctx.eventStore);
  };
}

/**
 * The workflow type of one gate call, for the severity wrapper. It reads `featureId` from the args.
 * A call with no event store in its context gets `'feature'`, the default of {@link resolveWorkflowTypeForGate}.
 */
async function workflowTypeOfCall(
  args: Readonly<Record<string, unknown>>,
  ctx: DispatchContext | undefined,
): Promise<string> {
  const featureId = typeof args.featureId === 'string' ? args.featureId : undefined;
  return ctx?.eventStore === undefined ? 'feature' : resolveWorkflowTypeForGate(featureId, ctx.eventStore);
}

/** The event of the gate signal row. */
const GATE_SIGNAL_EVENT = 'gate.executed' satisfies EventType;

/** True when the action contract declares an `always` row of the gate signal. */
function declaresGateSignal(contract: ToolAction['actionContract']): boolean {
  const ensures = contract?.ensures;
  if (ensures === undefined || ensures.kind !== 'declared') return false;
  return ensures.values.some(
    (postcondition) =>
      postcondition.source === 'event-append' &&
      postcondition.when === 'always' &&
      postcondition.event === GATE_SIGNAL_EVENT,
  );
}

/**
 * Wraps the handler of each gate action in the severity wrapper. A gate action is an action whose registration has `gate` metadata.
 * The builder reads the gate name, the dimension and the declared gate signal from that registration, and gives them to the wrapper.
 * Each other entry stays as it is.
 */
function withSeverityOfEachGate(
  table: Readonly<Record<string, ActionHandler>>,
): Readonly<Record<string, ActionHandler>> {
  const gateActions = new Map<string, GateSeverityDescriptor>();
  for (const action of orchestrateActions) {
    if (action.gate === undefined) continue;
    gateActions.set(action.name, {
      name: action.name,
      dimension: action.gate.dimension ?? '',
      signal: declaresGateSignal(action.actionContract),
    });
  }
  return Object.fromEntries(
    Object.entries(table).map(([name, handler]): [string, ActionHandler] => {
      const gate = gateActions.get(name);
      return [name, gate === undefined ? handler : withGateSeverity(gate, handler, workflowTypeOfCall)];
    }),
  );
}

/**
 * Like {@link adaptWithEventStore}, but the `eventStore` argument is optional, and the adapter does not throw without it.
 * The handlers can serve a dispatch with no event store.
 * For example, `select_debug_track` and `investigation_timer` resolve state from `stateFile`, or from `featureId` with the event store.
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
 * The tool that owns `ACTION_HANDLERS`.
 * The executor uses it to refuse a leaf whose tool differs from this owner. It does not assume that every key belongs to `exarchos_orchestrate`.
 */
const ACTION_HANDLERS_TOOL = 'exarchos_orchestrate';

/**
 * The routing table. The bounded action executor calls a compiled leaf through the same entry that this composite routes to.
 * A second copy of the mapping can drift from the registry, so this table is the only copy.
 * The executor gets the table as an argument from the `execute_intent` entry and does not import it, so the modules form no runtime import cycle.
 *
 * The statement after the literal replaces each gate entry with the handler that the severity wrapper returns.
 * Thus a direct call and a compiled leaf get one severity. The literal keeps its typed form, because the route scanner and the handler-throw rule read it.
 */
export const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  task_claim: adaptWithEventStore(handleTaskClaim),
  task_complete: async (args, stateDir, ctx) => {
    if (ctx === undefined) throw new Error('Task completion requires dispatch context');
    const refusal = coordinateRefusal(args, ctx, true);
    if (refusal !== undefined) return refusal;
    const trusted = ctx.verificationInput;
    if (trusted === undefined) {
      const observer = ctx.treeObserver;
      return privateTermsRemoved(adaptWithEventStore((typedArgs: Parameters<typeof handleTaskComplete>[0], dir, store) =>
        observer === undefined ? handleTaskComplete(typedArgs, dir, store) : handleTaskComplete(typedArgs, dir, store, observer)))(args, stateDir, ctx);
    }
    const staticSteps = TASK_COMPLETION.steps.flatMap((step, index) => step.action === 'check_static_analysis' ? [index] : []);
    const staticIndex = staticSteps[0];
    if (staticSteps.length !== 1 || staticIndex === undefined
      || (args.streamId ?? args.featureId) !== trusted.coordinate.capsule.workflowId) {
      return { success: false, error: { code: 'TASK_COORDINATE_REFUSED', message: 'Completion requires one selected static leaf and the bound stream.' } };
    }
    const authority = { ...trusted, staticOperationId: derivedLeafOperationId(trusted.segmentOperationId, staticIndex, 'check_static_analysis') };
    return adaptWithEventStore((typedArgs: Parameters<typeof handleTaskComplete>[0], dir, store) =>
      handleTaskComplete(typedArgs, dir, store, ctx.treeObserver, authority))(args, stateDir, ctx);
  },
  task_fail: adaptWithEventStore(handleTaskFail),
  review_triage: adaptWithEventStore(handleReviewTriage),
  prepare_delegation: adaptWithCtx(handlePrepareDelegation),
  prepare_synthesis: privateTermsRemoved(adaptWithEventStoreAndConfig(handlePrepareSynthesis)),
  check_design_completeness: adaptWithEventStore(handleDesignCompleteness),
  check_plan_coverage: adaptWithEventStore(handlePlanCoverage),
  /**
   * Exploration-citation gate for the deep depth. At any other depth, or with no depth stamp, it skips itself.
   * At deep depth, it verifies that the `### Exploration` section of the spec cites the discover pass by path and `correlationId`.
   */
  check_exploration_depth: adaptWithEventStore(handleCheckExplorationDepth),
  /** Verification-ladder gate. {@link adaptLadderGate} copies the dispatch config into the args, and the severity wrapper applies the severity. */
  check_contract_drift: adaptLadderGate(handleContractDrift, true),
  check_mock_boundary: adaptLadderGate(handleMockBoundary, true),
  check_post_merge: privateTermsRemoved(adaptWithEventStore(handlePostMerge)),
  check_static_analysis: adaptLadderGate(handleStaticAnalysis, true),
  check_integration_suite: adaptLadderGate(handleCheckIntegrationSuite, true),
  check_security_scan: adaptWithEventStore(handleSecurityScan),
  check_context_economy: privateTermsRemoved(adaptWithEventStore(handleContextEconomy)),
  check_operational_resilience: privateTermsRemoved(adaptWithEventStore(handleOperationalResilience)),
  check_workflow_determinism: privateTermsRemoved(adaptWithEventStore(handleWorkflowDeterminism)),
  check_review_verdict: adaptWithEventStoreAndConfig(handleReviewVerdict),
  check_convergence: adaptWithEventStore(handleCheckConvergence),
  check_provenance_chain: adaptWithEventStore(handleProvenanceChain),
  check_task_decomposition: adaptWithEventStore(handleTaskDecomposition),
  check_event_emissions: adaptWithEventStore(handleCheckEventEmissions),
  agent_spec: adapt(handleAgentSpec),
  extract_task: adapt(handleExtractTask),
  review_diff: privateTermsRemoved(adapt(handleReviewDiff)),
  verify_worktree: adapt(handleVerifyWorktree),
  select_debug_track: adaptWithOptionalEventStore(handleSelectDebugTrack),
  investigation_timer: adaptWithOptionalEventStore(handleInvestigationTimer),
  check_coverage_thresholds: adaptWithEventStore(handleCheckCoverageThresholds),
  assess_refactor_scope: adaptArgsWithEventStore(handleAssessRefactorScope),
  validate_pr_body: adaptWithOptionalEventStore(handleValidatePrBody),
  debug_review_gate: privateTermsRemoved(adaptWithEventStore(handleDebugReviewGate)),
  extract_fix_tasks: adaptArgsWithStateDirAndEventStore(handleExtractFixTasks),
  classify_review_items: adaptArgsWithEventStore(handleClassifyReviewItems),
  generate_traceability: adaptArgs(handleGenerateTraceability),
  /** Spec coverage runs its declared tests in the local approved-check executor. */
  spec_coverage_check: adaptWithEventStore(handleSpecCoverageCheck),
  verify_worktree_baseline: privateTermsRemoved(adaptWithEventStore(handleVerifyWorktreeBaseline)),
  verify_delegation_saga: adaptArgs(handleVerifyDelegationSaga),
  post_delegation_check: privateTermsRemoved(adaptArgsWithStateDirAndEventStore(handlePostDelegationCheck)),
  reconcile_state: adaptArgsWithEventStore(handleReconcileState),
  pre_synthesis_check: privateTermsRemoved(adaptArgsWithStateDirAndEventStore((args: PreSynthesisCheckArgs) => handlePreSynthesisCheck(args))),
  check_polish_scope: privateTermsRemoved(adapt((args: CheckPolishScopeArgs) => handleCheckPolishScope(args))),
  needs_schema_sync: privateTermsRemoved(adapt((args: Parameters<typeof handleNeedsSchemaSync>[0]) => handleNeedsSchemaSync(args))),
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
  /** Merge orchestrator. It composes the preflight and the executor under one public action. The internal `handleExecuteMerge` is not in this table. */
  merge_orchestrate: adaptCtx(handleMergeOrchestrate),
  /**
   * Worktree lifecycle action. Each handler delegates to the in-process `WorktreeManager` over `ctx.eventStore`.
   * The third handler parameter is a test seam, left at its default. The read action, `worktrees`, is on `exarchos_view`.
   */
  acquire_worktree: adaptCtx(handleAcquireWorktree),
  release_worktree: adaptCtx(handleReleaseWorktree),
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
   * The closure reads `ACTION_HANDLERS` only at call time, after the gate entries are wrapped, so the self-reference is safe.
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
  read_prepared_capsule: async (args, stateDir, ctx) => {
    if (!ctx) throw new Error('DispatchContext required for read_prepared_capsule');
    return handleReadPreparedCapsule(args, stateDir, ctx, ctx.preparedDetailWarnings);
  },
  /** The compilation endpoint, the pair of `settle`. It reads the workflow and commits through the store, so it needs the real context. */
  prepare: async (args, stateDir, ctx) => {
    if (!ctx) throw new Error('DispatchContext required for prepare');
    return handlePrepare(args, stateDir, ctx);
  },
};

Object.assign(ACTION_HANDLERS, withSeverityOfEachGate(ACTION_HANDLERS));

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
 * The `no-handler-throw` rule reads these `if (action === '<verb>')` branches to find the handlers that are not in `ACTION_HANDLERS`.
 * It reports a branch shape that it cannot read.
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

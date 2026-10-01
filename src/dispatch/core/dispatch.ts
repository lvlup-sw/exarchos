/**
 * The transport-agnostic dispatch core. The MCP and CLI adapters both route tool calls through
 * {@link dispatch}, so validation, the gates and the response-economy cap apply to both.
 * The telemetry middleware and the composite handlers load through dynamic imports. The middleware
 * creates a TraceWriter at import, and each composite pulls a large module graph. A CLI call
 * dispatches one tool, so static imports of all of them slow the cold start.
 *
 * The response-economy seam and ActionId admission live in leaf modules, so their other callers
 * do not import this module. The economy no-bypass gate in `dispatch.economy-seam.ts` reads the
 * `coreHandler` sites in this file.
 */

import type { ToolResult } from '../../format.js';
import { logger } from '../../logger.js';
import type { EventStore } from '../../events/store.js';
import type { ExarchosConfig } from '../../config/define.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { VcsProvider } from '../../vcs/provider.js';
import type { ConfigHookRunner } from '../../hooks/config-hooks.js';
import type { Outbox } from '../../sync/outbox.js';
import type { ChannelEmitter } from '../../adapters/channel/emitter.js';
import type { CapabilityResolver } from '../../workflow/capabilities/resolver.js';
import type { StorageBackend } from '../../storage/backend.js';
import type { RootsClient } from '../../runtime/workspace/discovery.js';
import type { ElicitationClient } from '../elicitation-dispatch.js';
import { hasCustomToolHandlers, getCustomToolActionHandler, getFullRegistry, findActionInRegistry, type ToolAction } from '../../registry.js';
import { enforceResponseEconomy, ECONOMY_CARRIER_KEYS } from './response-economy.js';
export { enforceResponseEconomy, ECONOMY_CARRIER_KEYS };
import type { NextAction } from '../../next-action.js';
import {
  formatValidationError,
  buildInvalidInput,
} from '../../adapters/cli/schema-to-flags.js';
import { runSessionMachineryConsumedInterceptor } from './interceptors/session-machinery.js';
import {
  describeEmissionIndeterminacy,
  emissionIndeterminacyBlocks,
  emissionIndeterminacyWarning,
  emissionViolationBlocks,
  EMISSION_INDETERMINATE_ERROR_CODE,
  observationStreamId,
  runEmissionVerifierInterceptor,
  verifierDeclaredEmissions,
} from './interceptors/emission-verifier.js';
import { evaluateInstallFreshness } from '../../install/freshness-gate.js';
import {
  mintDispatchContextFromRequest,
  runWithDispatchContext,
} from '../dispatch-context.js';
import {
  snapshotCallerAuthorization,
  type CallerIdentity,
} from '../caller-identity.js';
import {
  isTaskAugmented,
  extractTaskOptions,
  runTasksAugmented,
} from '../tasks-augmented.js';
import {
  selectForwardedParameters,
  findIgnoredParameters,
  buildIgnoredParameterError,
} from '../undeclared-parameters.js';
import { applyInferredValues } from './inferred-values.js';
import path from 'node:path';
import {
  detectActiveStoreDivergence,
  describeStoreDivergence,
  resolveStateDir,
  toPosix,
  ALLOW_STORE_DIVERGENCE_ENV,
} from '../../utils/paths.js';
import type { EventSourcedTaskStore } from '../../projections/task-store/event-sourced-task-store.js';
import type { ActionContract } from '../../registry/action-contract.js';
import { evaluateDispatchAdmission, readActionContract } from './dispatch-admission.js';
import {
  applicableEnsures,
  observeActionPostconditions,
  type ActionPostconditionObservation,
} from './action-postconditions.js';
import { evidenceArtifactResolver } from '../../workflow/admission/evidence-artifact.js';

export type CompositeHandler = (
  args: Record<string, unknown>,
  ctx: DispatchContext,
) => Promise<ToolResult>;

export interface DispatchContext {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly enableTelemetry: boolean;
  /**
   * The runtime-owned caller identity, with no PII. Adapters derive it from MCP session state or
   * the local installation, never from action args.
   */
  readonly callerIdentity?: CallerIdentity;
  readonly config?: ExarchosConfig;
  readonly projectConfig?: ResolvedProjectConfig;
  readonly vcsProvider?: VcsProvider;
  readonly hookRunner?: ConfigHookRunner;
  readonly slimRegistration?: boolean;
  readonly outbox?: Outbox;
  readonly channelEmitter?: ChannelEmitter;
  /**
   * The runtime capability resolver. A composite tool that emits cache-control hints asks it whether
   * the host understands the hint shape. The default resolver reports `anthropic_native_caching`.
   * `EXARCHOS_DISABLE_CACHE_HINTS=1` drops that token, so the wire output omits `_cacheHints`.
   */
  readonly capabilityResolver?: CapabilityResolver;
  /**
   * The storage backend that startup opens once, so consumers do not import `bun:sqlite` directly.
   * When present, the same backend serves `eventStore`. It is optional because some CLI cold-start
   * paths and many tests build a context without it.
   */
  readonly storage?: StorageBackend | undefined;
  /**
   * The MCP roots-list adapter. When the client declares the `roots` capability, dispatch fetches the
   * workspace roots through it to infer `featureId`. CLI and direct-call contexts omit it and use
   * the cwd walk.
   */
  readonly rootsClient?: RootsClient;
  /** The start directory for the cwd walk in `resolveWorkspace`. The default is `process.cwd()`. */
  readonly cwd?: string;
  /**
   * The MCP `elicitation/create` adapter. When the client declares the `elicitation` capability,
   * dispatch asks the client for one missing required field instead of returning `INVALID_INPUT`.
   * It is the last resort, because it costs a transport round trip. CLI contexts omit it.
   */
  readonly elicitationClient?: ElicitationClient;
  /**
   * The event-sourced SDK TaskStore. With it, a call that carries the SDK `task: { ttl? }` key goes
   * through `runTasksAugmented` and returns a `CreateTaskResult`-shaped envelope. Without it,
   * dispatch uses the one-shot path even when the call carries `task`.
   */
  readonly taskStore?: EventSourcedTaskStore;
}

/**
 * Returns the one top-level required field that a Zod error reports as missing, or `undefined`.
 * The elicitation hand-off asks only for a single missing field.
 * Zod uses `invalid_type` for a missing field and for a wrong type. Only `issue.input === undefined`
 * tells them apart, so the `safeParse` call must pass `{ reportInput: true }`.
 * A `received` value other than absent (Zod v4) or `'undefined'` (Zod v3) also rejects the issue.
 */
export function extractSingleMissingRequiredField(
  error: import('zod').z.ZodError,
): string | undefined {
  const issues = error.issues;
  if (issues.length !== 1) return undefined;
  const only = issues[0];
  if (only === undefined) return undefined;
  if (only.code !== 'invalid_type') return undefined;
  if (only.input !== undefined) return undefined;
  if (only.path.length !== 1) return undefined;
  const key = only.path[0];
  if (typeof key !== 'string') return undefined;
  const received = (only as { received?: unknown }).received;
  if (received !== 'undefined' && received !== undefined) return undefined;
  return key;
}

function actionIsReadOnly(tool: string, actionName: string, action: ToolAction | undefined): boolean {
  return action?.annotations?.readOnly === true || isReadOnlyAction(tool, actionName);
}

function isReadOnlyReasonedAbstention(
  tool: string,
  actionName: string,
  action: ToolAction | undefined,
): boolean {
  if (action === undefined) return false;
  if (!actionIsReadOnly(tool, actionName, action)) return false;
  const contract = readActionContract(action);
  if (contract === undefined) return false;
  return contract.ensures.kind === 'none';
}

function formatMissingEnsures(missing: readonly { readonly source: string }[]): string {
  return missing.map((item) => item.source).join(', ');
}

function ensureContractViolatedResult(
  tool: string,
  actionName: string,
  result: ToolResult,
  missing: readonly { readonly source: string }[],
): ToolResult {
  return {
    success: false,
    data: result.data,
    error: {
      code: 'ENSURE_CONTRACT_VIOLATED',
      message:
        `${tool}.${actionName} declared an ensure that was not observed after dispatch ` +
        `(${formatMissingEnsures(missing)}). A branded witness or a declaration is not ` +
        'observation — the store or the persisted-evidence reader must show the fact.',
    },
  };
}

/**
 * The composite-tool actions that the `mcp:exarchos:readonly` tier admits. The readonly gate denies
 * any other action with `CAPABILITY_DENIED` when the caller holds the readonly tier but not
 * `mcp:exarchos`. A caller with both tiers keeps full access. `'*'` marks a tool where every action
 * is read-only.
 */
export const READ_ONLY_ACTIONS = {
  /**
   * `reconcile` and `rehydrate` are absent, because both write to the event or state store.
   * A read-only viewer reads state through `get`.
   */
  exarchos_workflow: ['get', 'describe'],
  exarchos_event: ['query', 'describe'],
  /**
   * Actions that append events or change state are absent. `doctor` and `check_convergence` are
   * absent, because their handlers append an event on each call. The listed `check_*` gates stay,
   * because the tier counts their audit-trail append as a logged read.
   */
  exarchos_orchestrate: [
    'describe',
    'runbook',
    'agent_spec',
    'check_static_analysis',
    'check_security_scan',
    'check_context_economy',
    'check_operational_resilience',
    'check_workflow_determinism',
    'check_review_verdict',
    'check_provenance_chain',
    'check_design_completeness',
    'check_plan_coverage',
    'check_post_merge',
    'check_task_decomposition',
    'check_event_emissions',
    'check_coderabbit',
    'check_polish_scope',
    'check_coverage_thresholds',
    'check_ci',
    'extract_task',
    'review_diff',
    'verify_worktree',
    'verify_worktree_baseline',
    'verify_delegation_saga',
    'verify_doc_links',
    'verify_review_triage',
    'select_debug_track',
    'investigation_timer',
    'assess_refactor_scope',
    'validate_pr_body',
    'validate_pr_stack',
    'spec_coverage_check',
    'needs_schema_sync',
    'generate_traceability',
    'classify_review_items',
    'prepare_review',
    'list_prs',
    'get_pr_comments',
  ],
  exarchos_view: '*',
} as const;

export type ReadOnlyActionsMap = typeof READ_ONLY_ACTIONS;

/**
 * The actions that stay available on a stale or mixed install, so an operator can diagnose and
 * repair it. `doctor` emits `diagnostic.executed`, so it is not in {@link READ_ONLY_ACTIONS}.
 * Without this exemption, the freshness gate blocks `doctor`.
 */
const FRESHNESS_GATE_DIAGNOSTIC_EXEMPT: ReadonlySet<string> = new Set([
  'doctor',
]);

/** True when the install-freshness gate must not block the action: it is read-only or a diagnostic exemption. */
function isFreshnessGateExempt(tool: string, action: string): boolean {
  return isReadOnlyAction(tool, action) || FRESHNESS_GATE_DIAGNOSTIC_EXEMPT.has(action);
}

/**
 * True when `action` on `tool` only reads. The store-divergence check calls it directly, not through
 * {@link isFreshnessGateExempt}, so `doctor` gets no exemption from that check.
 */
function isReadOnlyAction(tool: string, action: string): boolean {
  const allowed = (READ_ONLY_ACTIONS as Record<string, readonly string[] | '*'>)[tool];
  if (allowed === '*') return true;
  return allowed !== undefined && allowed.includes(action);
}
/**
 * Applies the readonly capability gate. It returns `CAPABILITY_DENIED` when the caller holds
 * `mcp:exarchos:readonly` but not `mcp:exarchos`, and {@link READ_ONLY_ACTIONS} omits the action.
 * Otherwise it returns `null`.
 */
export function enforceReadonlyGate(
  tool: string,
  action: string,
  resolver: CapabilityResolver | undefined,
): ToolResult | null {
  if (!resolver) return null;
  if (!resolver.has('mcp:exarchos:readonly')) return null;
  if (resolver.has('mcp:exarchos')) return null;

  const allowed = (READ_ONLY_ACTIONS as Record<string, readonly string[] | '*'>)[tool];
  if (allowed === '*') return null;
  if (allowed && allowed.includes(action)) return null;

  return {
    success: false,
    error: {
      code: 'CAPABILITY_DENIED',
      message: `Action "${action}" on tool "${tool}" requires the mcp:exarchos capability; only mcp:exarchos:readonly is granted.`,
      tool,
      action,
    },
  };
}

/**
 * The composite handlers by tool name. `loadCompositeHandler()` reads this map first, and the lazy
 * loaders in {@link COMPOSITE_HANDLER_LOADERS} fill it on first use. A value set here takes
 * precedence over the loader. Production code must not write to this map. Tests use
 * {@link stubCompositeHandler}, which returns a restore function.
 */
export const COMPOSITE_HANDLERS: Record<string, CompositeHandler> = {};

/**
 * The tools whose composite handler is a test stub. `COMPOSITE_HANDLERS` cannot tell this, because
 * the lazy loader writes real handlers into the same map. The emission verifier skips a stub,
 * because the emission contract belongs to the registered handler.
 */
const STUBBED_COMPOSITES = new Set<string>();

/**
 * Installs a test override for a composite handler. It returns a function that restores the prior
 * value, which can be an absent key.
 */
export function stubCompositeHandler(
  tool: string,
  handler: CompositeHandler,
): () => void {
  const hadPrev = tool in COMPOSITE_HANDLERS;
  const prev = COMPOSITE_HANDLERS[tool];
  const wasStubbed = STUBBED_COMPOSITES.has(tool);
  COMPOSITE_HANDLERS[tool] = handler;
  STUBBED_COMPOSITES.add(tool);
  return () => {
    if (hadPrev) {
      COMPOSITE_HANDLERS[tool] = prev as CompositeHandler;
    } else {
      delete COMPOSITE_HANDLERS[tool];
    }
    if (wasStubbed) STUBBED_COMPOSITES.add(tool);
    else STUBBED_COMPOSITES.delete(tool);
  };
}

/**
 * The dynamic-import factories for each built-in composite. The map is mutable, so a test can inject
 * a throwing loader for the `COMPOSITE_LOAD_FAILED` path. Production code must not change it.
 */
export const COMPOSITE_HANDLER_LOADERS: Record<string, () => Promise<CompositeHandler>> = {
  exarchos_workflow: () => import('../../workflow/composite.js').then((m) => m.handleWorkflow),
  exarchos_event: () => import('../../events/composite.js').then((m) => m.handleEvent),
  exarchos_orchestrate: () => import('../../verbs/composite.js').then((m) => m.handleOrchestrate),
  exarchos_view: () => import('../../projections/views/composite.js').then((m) => m.handleView),
  exarchos_sync: () => import('../../sync/composite.js').then((m) => m.handleSync),
};

/**
 * Resolves a composite handler by tool name, or `undefined` for a tool that is not built in.
 * It caches each loaded handler in `COMPOSITE_HANDLERS`.
 */
async function loadCompositeHandler(tool: string): Promise<CompositeHandler | undefined> {
  const cached = COMPOSITE_HANDLERS[tool];
  if (cached) return cached;

  const loader = COMPOSITE_HANDLER_LOADERS[tool];
  if (!loader) return undefined;

  const handler = await loader();
  COMPOSITE_HANDLERS[tool] = handler;
  return handler;
}

/** A type guard for ToolResult. It needs a boolean `success` and at least one other envelope field. */
function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.success === 'boolean' &&
    (
      'data' in candidate ||
      'error' in candidate ||
      'warnings' in candidate ||
      '_meta' in candidate ||
      '_perf' in candidate ||
      '_eventHints' in candidate ||
      '_corrections' in candidate
    );
}

/**
 * Creates a handler for a custom tool that routes to the per-action handlers in the registry.
 * A handler result that is not a ToolResult becomes `{ success: true, data }`.
 */
function createCustomToolHandler(
  toolName: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const actionName = args.action;
    if (typeof actionName !== 'string' || !actionName) {
      return {
        success: false,
        error: {
          code: 'MISSING_ACTION',
          message: `Custom tool "${toolName}" requires an "action" field (string)`,
        },
      };
    }

    const actionHandler = getCustomToolActionHandler(toolName, actionName);
    if (!actionHandler) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Custom tool "${toolName}" has no handler for action "${actionName}"`,
        },
      };
    }

    const result = await actionHandler(args);
    if (isToolResult(result)) {
      return result;
    }
    return { success: true, data: result };
  };
}

/**
 * Routes a tool call to its composite or custom handler. It strips the SDK `task` key before the
 * `.strict()` validation, and it mints the correlation context before any early event.
 * A built-in call then goes through inferred values, a one-field elicitation, validation and the
 * undeclared-parameter refusal. Next come the readonly gate, the store-divergence refusal,
 * admission, the session-machinery interceptor and the install-freshness gate.
 *
 * The divergence refusal comes before the interceptor, because the interceptor appends an event.
 * Each handler path applies `enforceResponseEconomy`, also with telemetry off. After the handler,
 * an emission violation, or an indeterminate verdict under `block`, returns a failure that keeps `data`.
 * The effects already happened, so the message tells the caller not to retry.
 * Declared ensures must then show in the store or the persisted-evidence reader.
 */
export async function dispatch(
  tool: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const taskAugmented = isTaskAugmented(args);
  const taskOptionsRaw = taskAugmented ? (args as { task?: unknown }).task : undefined;
  if (taskAugmented) {
    const { task: _stripped, ...rest } = args as { task?: unknown } & Record<string, unknown>;
    void _stripped;
    args = rest;
  }

  const dispatchStartTs = Date.now();

  let builtInHandler: CompositeHandler | undefined;
  try {
    builtInHandler = await loadCompositeHandler(tool);
  } catch (loadErr) {
    return {
      success: false,
      error: {
        code: 'COMPOSITE_LOAD_FAILED',
        message: `Failed to load composite handler for tool "${tool}": ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`,
      },
    };
  }

  const registeredTool = getFullRegistry().find((t) => t.name === tool);

  if (!builtInHandler && (!registeredTool || !hasCustomToolHandlers(tool))) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${tool}. Available tools: ${getFullRegistry().map((t) => t.name).join(', ')}`,
      },
    };
  }

  const authorization = ctx.callerIdentity === undefined
    ? undefined
    : snapshotCallerAuthorization(ctx.callerIdentity, ctx.capabilityResolver);
  const dispatchCtx = mintDispatchContextFromRequest(args, authorization);

  const storeCameFromAmbientCascade = toPosix(path.resolve(ctx.stateDir)) === resolveStateDir();
  const storeDivergence = storeCameFromAmbientCascade
    ? detectActiveStoreDivergence()
    : undefined;

  const attachMeta = (result: ToolResult): ToolResult => {
    const existingMeta =
      typeof (result as { _meta?: unknown })._meta === 'object' &&
      (result as { _meta?: unknown })._meta !== null
        ? ((result as { _meta: Record<string, unknown> })._meta)
        : undefined;
    const correlationMeta = {
      operationId: dispatchCtx.operationId,
      correlationId: dispatchCtx.correlationId,
      ...(dispatchCtx.causationId !== undefined
        ? { causationId: dispatchCtx.causationId }
        : {}),
    };
    const mergedMeta = existingMeta
      ? { ...correlationMeta, ...existingMeta }
      : correlationMeta;
    const alreadyStated = result.error?.code === 'STORE_PATH_DIVERGENCE';
    const warnings = storeDivergence?.shouldWarn === true && !alreadyStated
      ? [...(result.warnings ?? []), describeStoreDivergence(storeDivergence)]
      : result.warnings;
    return {
      ...result,
      ...(warnings !== undefined ? { warnings } : {}),
      _meta: mergedMeta,
    } as ToolResult;
  };

  return runWithDispatchContext(dispatchCtx, async () => {
  try {

  const isBuiltIn = Object.prototype.hasOwnProperty.call(COMPOSITE_HANDLERS, tool);
  if (isBuiltIn && registeredTool) {
    const actionName = args.action;
    if (typeof actionName !== 'string' || !actionName) {
      return {
        success: false,
        error: buildInvalidInput(
          `${tool}: required field "action" is missing or not a string`,
        ),
      };
    }

    const matchingAction = registeredTool.actions.find((a) => a.name === actionName);
    if (!matchingAction) {
      const valid = registeredTool.actions.map((a) => a.name).join(', ');
      return {
        success: false,
        error: buildInvalidInput(
          `${tool}: unknown action "${actionName}". Valid actions: ${valid}`,
        ),
      };
    }

    let { action: _action, ...rest } = args;

    const inference = await applyInferredValues(rest, matchingAction, tool, actionName, ctx);
    if (inference.kind === 'refused') {
      return attachMeta({
        success: false,
        error: {
          code: inference.code,
          message: inference.message,
          ...(inference.validTargets !== undefined ? { validTargets: inference.validTargets } : {}),
        },
      });
    }
    rest = inference.args;

    const { forwarded: cleanedRest, unshaped } = selectForwardedParameters(
      rest,
      matchingAction,
      registeredTool.actions,
    );
    let parsed = matchingAction.schema.safeParse(cleanedRest, { reportInput: true });

    if (
      !parsed.success &&
      ctx.capabilityResolver?.isElicitationDeclared() === true &&
      ctx.elicitationClient !== undefined
    ) {
      const missingField = extractSingleMissingRequiredField(parsed.error);
      if (missingField !== undefined) {
        const actionSchema = matchingAction.schema as unknown as import('zod').z.ZodObject;
        try {
          const { performElicitation } = await import(
            '../elicitation-dispatch.js'
          );
          const elicitation = await performElicitation({
            inputSchema: actionSchema,
            missingField,
            client: ctx.elicitationClient,
            eventStore: ctx.eventStore,
            operationId: dispatchCtx.operationId,
          });
          if (elicitation.fulfilled) {
            parsed = matchingAction.schema.safeParse({
              ...cleanedRest,
              [missingField]: elicitation.value,
            });
          }
        } catch {
        }
      }
    }

    if (!parsed.success) {
      const context = `${tool}/${actionName}`;
      return attachMeta({
        success: false,
        error: formatValidationError(parsed.error, context),
      });
    }

    const ignored = findIgnoredParameters(unshaped, parsed.data);
    if (ignored.length > 0) {
      return attachMeta({
        success: false,
        error: buildIgnoredParameterError(
          tool,
          matchingAction,
          registeredTool.actions,
          ignored,
        ),
      });
    }

    args = { action: actionName, ...parsed.data } as Record<string, unknown>;

    const denied = enforceReadonlyGate(tool, actionName, ctx.capabilityResolver);
    if (denied) return attachMeta(denied);

    if (!isReadOnlyAction(tool, actionName) && storeDivergence !== undefined) {
      const divergence = storeDivergence;
      if (divergence.active) {
        logger.child({ subsystem: 'store-divergence' }).warn(
          { tool, action: actionName, activePath: divergence.activePath, otherPath: divergence.otherPath },
          'refusing mutating action: the resolved event store diverges from the other surface',
        );
        return attachMeta({
          success: false,
          error: {
            code: 'STORE_PATH_DIVERGENCE',
            message: describeStoreDivergence(divergence),
            tool,
            action: actionName,
            expectedShape: {
              activePath: divergence.activePath,
              otherPath: divergence.otherPath,
              remedy: `WORKFLOW_STATE_DIR=${path.dirname(divergence.otherPath)}`,
              override: `${ALLOW_STORE_DIVERGENCE_ENV}=1`,
            },
          },
        });
      }
    }

    const admission = await evaluateDispatchAdmission({
      tool,
      actionName,
      action: matchingAction,
      args,
      ctx,
      authorization,
    });
    if (admission !== null) return attachMeta(admission);

    const streamId = (() => {
      const fid = (args as { featureId?: unknown }).featureId;
      return typeof fid === 'string' && fid.length > 0 ? fid : undefined;
    })();
    await runSessionMachineryConsumedInterceptor(ctx.eventStore, streamId, actionName);

    if (!isFreshnessGateExempt(tool, actionName)) {
      const freshness = evaluateInstallFreshness({});
      if (freshness.status === 'blocked') {
        logger.child({ subsystem: 'install-freshness' }).warn(
          {
            tool,
            action: actionName,
            dimensions: freshness.mismatches.map((m) => m.dimension),
          },
          'blocking mutating action: installation is stale or mixed',
        );
        return attachMeta({
          success: false,
          error: {
            code: 'INSTALL_FRESHNESS_MISMATCH',
            message: freshness.message,
            tool,
            action: actionName,
          },
        });
      }
    }
  }

  const coreHandler = builtInHandler
    ? async (a: Record<string, unknown>) => builtInHandler(a, ctx)
    : createCustomToolHandler(tool);

  let result: ToolResult;
  const economyActionName = typeof args.action === 'string' ? args.action : undefined;
  const taskCapabilityGate =
    ctx.capabilityResolver === undefined ||
    ctx.capabilityResolver.isTaskSupportDeclared();
  if (taskAugmented && ctx.taskStore && taskCapabilityGate) {
    const taskOptions = extractTaskOptions(taskOptionsRaw);
    const request: Parameters<typeof runTasksAugmented>[0]['request'] = {
      method: 'tools/call',
      params: { name: tool, arguments: args },
    };
    const requestId = `dispatch:${dispatchCtx.operationId}`;
    const augmentedHandler = ctx.enableTelemetry
      ? async () => {
          const { withTelemetry } = await import('../../projections/telemetry/middleware.js');
          const wrapped = withTelemetry(coreHandler, tool, ctx.eventStore);
          return wrapped(args);
        }
      : async () => enforceResponseEconomy(await coreHandler(args), tool, economyActionName);
    result = await runTasksAugmented({
      taskStore: ctx.taskStore,
      taskOptions,
      requestId,
      request,
      execute: augmentedHandler,
    });
  } else if (ctx.enableTelemetry) {
    const { withTelemetry } = await import('../../projections/telemetry/middleware.js');
    const wrappedHandler = withTelemetry(coreHandler, tool, ctx.eventStore);
    result = await wrappedHandler(args);
  } else {
    result = enforceResponseEconomy(await coreHandler(args), tool, economyActionName);
  }

  if (result.success && !taskAugmented) {
    const actionName = typeof args.action === 'string' ? args.action : undefined;
    if (actionName !== undefined) {
      const action = findActionInRegistry(tool, actionName);
      if (action?.dispatch?.taskSuitable === true) {
        const elapsedMs = Date.now() - dispatchStartTs;
        const RETRY_WITH_TASK_THRESHOLD_MS = 10_000;
        if (elapsedMs > RETRY_WITH_TASK_THRESHOLD_MS) {
          const hint: NextAction = {
            verb: 'retry_with_task',
            reason: `this action took ${elapsedMs}ms; consider Tasks-augmented dispatch for live progress`,
            ttl_suggestion_ms: action.dispatch.taskTtlSuggestionMs ?? 60_000,
          };
          const existing: readonly NextAction[] = result.next_actions ?? [];
          result = { ...result, next_actions: [hint, ...existing] };
        }
      }
    }
  }

  const dispatchedActionName = typeof args.action === 'string' ? args.action : '';
  const dispatchedAction =
    dispatchedActionName === '' ? undefined : findActionInRegistry(tool, dispatchedActionName);
  const dispatchedContract = dispatchedAction === undefined ? undefined : readActionContract(dispatchedAction);
  const observedStreamId = observationStreamId(args, dispatchedContract);
  const readOnlyAbstention = isReadOnlyReasonedAbstention(tool, dispatchedActionName, dispatchedAction);

  const emissionVerdict = await runEmissionVerifierInterceptor(ctx.eventStore, {
    tool,
    action: dispatchedActionName,
    operationId: dispatchCtx.operationId,
    streamId: observedStreamId,
    declared: verifierDeclaredEmissions(dispatchedContract),
    handlerStubbed: STUBBED_COMPOSITES.has(tool),
    handlerSucceeded: result.success,
    readOnlyAbstention,
    ...(ctx.projectConfig !== undefined ? { projectConfig: ctx.projectConfig } : {}),
  });

  if (emissionViolationBlocks(emissionVerdict, ctx.projectConfig)) {
    const undelivered = [
      ...emissionVerdict.missingEvents,
      ...emissionVerdict.lifecycleViolations.map((v) => v.event),
    ];
    return attachMeta({
      success: false,
      data: result.data,
      error: {
        code: 'EMISSION_CONTRACT_VIOLATED',
        message:
          `${tool}.${dispatchedActionName} declares an ` +
          `unconditional emission that did not land: ${undelivered.join(', ')}. ` +
          'THE OPERATION COMPLETED AND ITS EFFECTS ARE PERFORMED — do NOT retry this ' +
          'call; retrying repeats a mutation that already succeeded. Its result is ' +
          'preserved on `data`. What failed is the bookkeeping: the declaration and ' +
          'the handler have drifted, which is an Exarchos defect rather than a ' +
          "malformed call. Reconcile the action's `autoEmits` with what its handler " +
          'appends; to surface the finding without failing the run, set ' +
          '`events.emission-enforcement: advisory` in `.exarchos.yml`.',
      },
    });
  }

  if (emissionVerdict.status === 'violated') {
    return attachMeta(result);
  }

  if (emissionVerdict.status === 'indeterminate') {
    if (emissionIndeterminacyBlocks(emissionVerdict, ctx.projectConfig)) {
      return attachMeta({
        success: false,
        data: result.data,
        error: {
          code: EMISSION_INDETERMINATE_ERROR_CODE,
          message:
            `${tool}.${dispatchedActionName} declares unconditional emissions ` +
            `(${emissionVerdict.required.join(', ')}) that could not be verified: ` +
            `${describeEmissionIndeterminacy(emissionVerdict)}. THE OPERATION COMPLETED ` +
            'AND ITS EFFECTS ARE PERFORMED — do NOT retry this call; retrying repeats a ' +
            'mutation that already succeeded. Its result is preserved on `data`. What ' +
            'failed is the verification, not the work: no evidence was read either way, ' +
            'so the run refuses to assert the contract held. Restore the event store and ' +
            'inspect the operation; to surface this without failing the run, set ' +
            '`events.emission-enforcement: advisory` in `.exarchos.yml`.',
        },
      });
    }
    result = {
      ...result,
      warnings: [
        ...(result.warnings ?? []),
        emissionIndeterminacyWarning(tool, dispatchedActionName, emissionVerdict),
      ],
    };
  }

  if (
    dispatchedContract !== undefined &&
    dispatchedContract.ensures.kind === 'declared' &&
    !STUBBED_COMPOSITES.has(tool) &&
    !readOnlyAbstention
  ) {
    const applicable = applicableEnsures(
      dispatchedContract.ensures,
      result.success ? 'success' : 'failure',
    );
    if (applicable.length === 0) {
      return attachMeta(result);
    }
    if (observedStreamId === undefined || observedStreamId.length === 0) {
      return attachMeta(
        ensureContractViolatedResult(
          tool,
          dispatchedActionName,
          result,
          applicable,
        ),
      );
    }
    let observation: ActionPostconditionObservation;
    try {
      observation = await observeActionPostconditions({
        ensures: dispatchedContract.ensures,
        store: ctx.eventStore,
        evidence: ctx.eventStore,
        streamId: observedStreamId,
        operationId: dispatchCtx.operationId,
        outcome: result.success ? 'success' : 'failure',
        artifactResolver: evidenceArtifactResolver(ctx.stateDir),
      });
    } catch {
      observation = { status: 'violated' as const, missing: applicable };
    }
    if (observation.status === 'violated') {
      return attachMeta(
        ensureContractViolatedResult(tool, dispatchedActionName, result, observation.missing),
      );
    }
  }

  return attachMeta(result);
  } catch (error) {
    return attachMeta({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unhandled dispatch error',
      },
    });
  }
  });
}

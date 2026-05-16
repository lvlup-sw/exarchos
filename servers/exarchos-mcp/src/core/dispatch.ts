import type { ToolResult } from '../format.js';
import { logger } from '../logger.js';
import type { EventStore } from '../event-store/store.js';
import type { ExarchosConfig } from '../config/define.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import type { VcsProvider } from '../vcs/provider.js';
import type { ConfigHookRunner } from '../hooks/config-hooks.js';
import type { Outbox } from '../sync/outbox.js';
import type { ChannelEmitter } from '../channel/emitter.js';
import type { CapabilityResolver } from '../capabilities/resolver.js';
import type { StorageBackend } from '../storage/backend.js';
import type { RootsClient } from '../workspace/discovery.js';
import type { ElicitationClient } from '../dispatch/elicitation-dispatch.js';
import { hasCustomToolHandlers, getCustomToolActionHandler, getFullRegistry } from '../registry.js';
import {
  formatValidationError,
  buildInvalidInput,
} from '../adapters/schema-to-flags.js';
import { runSessionMachineryConsumedInterceptor } from './interceptors/session-machinery.js';

// NOTE: `../telemetry/middleware.js` is intentionally NOT imported at module
// top-level. The middleware instantiates a singleton TraceWriter at import,
// which adds ~15ms to CLI cold-start. It is dynamic-imported inside
// `dispatch()` only when `ctx.enableTelemetry === true`.

// Composite handlers are intentionally loaded lazily. Each of the five
// composite modules pulls a large transitive graph (~70ms aggregate on a
// warm FS cache). Since CLI cold-start dispatches exactly one tool per
// invocation, we load only the needed composite at dispatch time.
// This keeps `dist/index.js` import under the DR-5 / task 021 budget.

// ─── Types ──────────────────────────────────────────────────────────────────

export type CompositeHandler = (
  args: Record<string, unknown>,
  ctx: DispatchContext,
) => Promise<ToolResult>;

export interface DispatchContext {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly enableTelemetry: boolean;
  readonly config?: ExarchosConfig;
  readonly projectConfig?: ResolvedProjectConfig;
  readonly vcsProvider?: VcsProvider;
  readonly hookRunner?: ConfigHookRunner;
  readonly slimRegistration?: boolean;
  readonly outbox?: Outbox;
  readonly channelEmitter?: ChannelEmitter;
  /**
   * Runtime capability resolver (T051, DR-14). Composite tools that emit
   * cache-control hints consult this resolver to decide whether the host
   * runtime understands the hint shape. The default resolver constructed
   * by `initializeContext` reports `anthropic_native_caching` so MCP
   * clients receive `_cacheHints` on rehydrate envelopes; setting
   * `EXARCHOS_DISABLE_CACHE_HINTS=1` returns an empty resolver so the
   * field is omitted from the wire output.
   */
  readonly capabilityResolver?: CapabilityResolver;
  /**
   * Storage handle constructed once at startup (DR-2 of the
   * durable-event-store-substrate design). Lifecycle wiring in
   * `index.ts` / `core/context.ts` opens the SQLite (or in-memory)
   * backend and threads it through the context so consumers do not
   * reach for an ambient `bun:sqlite` import.
   *
   * Optional because (a) several CLI cold-start paths and a long tail
   * of in-process tests construct `DispatchContext` literals without a
   * storage handle, and (b) the substrate work that relies on
   * `ctx.storage` lives behind composite handlers that opt in by
   * checking the field. When present, the same handle backs
   * `eventStore` reads/writes (passed through as the `backend` option
   * to `EventStore`).
   *
   * Post-v2.11 substrate-cut (DR-3) the production path always supplies
   * a SqliteBackend; absence here is a test-context shape only — there
   * is no JSONL fallback any more.
   */
  readonly storage?: StorageBackend;
  /**
   * MCP roots-list adapter (#1290). When the client declares the
   * `roots` capability via the initialize handshake (recorded on the
   * {@link CapabilityResolver}), dispatch calls this adapter to fetch
   * the workspace roots for boundary-level `featureId` inference. The
   * resolver caches the result; `notifications/roots/list_changed`
   * invalidates the cache via `mcp/notifications.ts`.
   *
   * Optional — CLI / direct-call contexts omit it and dispatch falls
   * back to the cwd-walk branch inside `resolveWorkspace`.
   */
  readonly rootsClient?: RootsClient;
  /**
   * Working directory threaded through dispatch so the cwd-walk fallback
   * in {@link resolveWorkspace} (#1290) has a deterministic starting
   * point that the caller controls. Defaults to `process.cwd()` when
   * absent — exercised in tests that inject a workspace fixture path.
   */
  readonly cwd?: string;
  /**
   * MCP `elicitation/create` adapter (#1274). When the client declares
   * the `elicitation` capability via the initialize handshake (recorded
   * on the {@link CapabilityResolver}), dispatch routes missing-required-
   * param branches through this adapter to ask the client for the
   * missing field instead of returning INVALID_INPUT outright. Resolution
   * priority: explicit > roots > cwd > elicitation > INVALID_INPUT
   * (elicitation is the last resort before INVALID_INPUT because it
   * requires a transport round-trip).
   *
   * Optional — CLI / direct-call contexts omit it and dispatch falls
   * back to the legacy INVALID_INPUT contract.
   */
  readonly elicitationClient?: ElicitationClient;
}

// ─── #1274 — Missing-required-field extractor ──────────────────────────────
//
// Used by the elicitation hand-off in `dispatch()` to decide whether a Zod
// validation failure represents a single missing required parameter (the
// case elicitation is designed to handle) or some other structural error
// (multiple missing fields, wrong type, .strict() typo rejection, etc.).
//
// We elicit ONLY when exactly one top-level required field is missing —
// multi-field elicitation would compose poorly with the per-action
// validation contract (the client would have to round-trip once per
// field, and partial fulfillment leaves the audit trail ambiguous).
// Future iterations can extend this surface; the conservative single-field
// gate is the v2.10 contract.

function extractSingleMissingRequiredField(
  error: import('zod').z.ZodError,
): string | undefined {
  // Zod v4's missing-required-key error surfaces with `code: 'invalid_type'`
  // and `expected: 'string' | 'number' | …` on the leaf-most issue (the
  // input was `undefined` for the field). CodeRabbit CRITICAL #1424:
  // `invalid_type` is also Zod's WRONG-TYPE code (e.g. caller passed a
  // number where a string was expected). Without inspecting `issue.input`
  // we'd treat a wrong-type field as missing and route the caller through
  // an elicitation hand-off they never asked for. `issue.input` is only
  // populated when safeParse is called with `{ reportInput: true }` (the
  // call site sets this); `input === undefined` is the disambiguator for
  // "field was missing" vs "field was the wrong type."
  //
  // We accept the issue when:
  //   - exactly one issue is reported, AND
  //   - the issue path is a single top-level key (string), AND
  //   - the issue code is 'invalid_type', AND
  //   - the issue's `input` is `undefined` (truly missing — not a wrong
  //     type) so we don't divert wrong-type errors into elicitation.
  const issues = error.issues;
  if (issues.length !== 1) return undefined;
  const only = issues[0];
  if (only.code !== 'invalid_type') return undefined;
  if (only.input !== undefined) return undefined;
  if (only.path.length !== 1) return undefined;
  const key = only.path[0];
  if (typeof key !== 'string') return undefined;
  return key;
}

// ─── T04: Server-side Read-only Action Allowlist (Issue #1192) ─────────────
//
// Composite-tool actions that are safe to invoke under the
// `mcp:exarchos:readonly` capability tier. Anything NOT listed here (for a
// given tool) is treated as mutating and rejected with CAPABILITY_DENIED
// when the effective capability set contains `mcp:exarchos:readonly` but
// NOT `mcp:exarchos`.
//
// The tier merge rule: a spec that holds BOTH `mcp:exarchos` and
// `mcp:exarchos:readonly` keeps full access (less-restrictive wins). The
// gate fires only when the readonly tier is the only `mcp:exarchos*` cap
// the resolver reports — see `enforceReadonlyGate` below.
//
// Exported so T05 (resolver tier merge) and T06-T10 (per-runtime adapters)
// can reference the same allowlist instead of duplicating action lists.
//
// `'*'` for `exarchos_view` means the entire tool is read-only — every
// action surface returns deterministic data without auto-emitting events
// or mutating workflow / event store state.
export const READ_ONLY_ACTIONS = {
  // Excluded as mutating: `reconcile` reapplies events to overwrite the
  // on-disk state file; `rehydrate` emits a `workflow.rehydrated` event
  // (per its tool contract) and may persist a fresh snapshot. Both touch
  // the event/state stores and are not safe under the readonly tier — a
  // read-only viewer should consume the latest known state via `get` (or
  // `exarchos_view`) instead.
  exarchos_workflow: ['get', 'describe'],
  exarchos_event: ['query', 'describe'],
  // Orchestrate read-only set: descriptive actions (`describe`, `runbook`,
  // `agent_spec`), pure-analysis gate checks (`check_*`),
  // information extractors (`extract_task`, `review_diff`,
  // `verify_worktree`, `select_debug_track`, `investigation_timer`,
  // `assess_refactor_scope`), validators (`validate_pr_body`,
  // `validate_pr_stack`, `verify_doc_links`, `verify_review_triage`,
  // `verify_worktree_baseline`, `verify_delegation_saga`,
  // `spec_coverage_check`, `needs_schema_sync`, `generate_traceability`,
  // `classify_review_items`), readiness queries (`prepare_review`), and
  // the read-only VCS surfaces (`check_ci`, `list_prs`,
  // `get_pr_comments`).
  //
  // Excluded as mutating: `task_claim`, `task_complete`, `task_fail`
  // (event-emitting), `prepare_delegation`, `prepare_synthesis`,
  // `assess_stack` (event-emitting / `shepherd.*`), `setup_worktree`,
  // `merge_orchestrate`, `merge_pr`, `create_pr`, `create_issue`,
  // `add_pr_comment`, `init`, `new_project`, `prune_stale_workflows`,
  // `request_synthesize`, `finalize_oneshot`, `reconcile_state`,
  // `extract_fix_tasks`, `pre_synthesis_check`, `post_delegation_check`,
  // `debug_review_gate`, `check_pr_comments` (queries gh state but is
  // grouped with synthesis review actions and may emit), and the
  // `review_triage` orchestrator. Also excluded from the readonly
  // tier: `doctor` (`diagnostic.executed`) and `check_convergence`
  // (`gate.executed`) — sentry HIGH on PR #1369 caught these two as
  // mis-annotated `readOnly: true` while their handlers do
  // `eventStore.append()` on every call. The remaining `check_*`
  // actions stay in this set: they are intentionally annotated
  // `LOCAL_MUTATION` (advisory) but the readonly tier still admits
  // them because their lone audit-trail emission is a logged-read by
  // convention (pure-analysis gate). If we ever tighten "readonly"
  // to mean "zero appends," that broader change is a separate design
  // step — not in scope of the Sentry HIGH fix.
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
    'check_tdd_compliance',
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
 * Actions that never consume a `featureId` (Sentry MEDIUM #1423).
 *
 * The roots-based workspace-discovery branch in `dispatch()` skips its
 * synchronous filesystem walk for actions in this set so high-frequency
 * introspection calls (catalog reads, runbook fetches, agent-spec
 * lookups) don't pay the discovery cost. Adding an action here is a
 * "this surface MUST NOT ever take a featureId" assertion — pair the
 * addition with a registry-side check that the action's schema does not
 * declare a `featureId` field.
 */
const NO_WORKSPACE_RESOLUTION_ACTIONS: ReadonlySet<string> = new Set([
  'describe',
  'runbook',
  'agent_spec',
]);

/**
 * Apply the readonly capability gate. Returns a structured CAPABILITY_DENIED
 * ToolResult when the effective capability set forbids `action` on `tool`,
 * or `null` when the call is allowed to proceed.
 *
 * Gate rule: fires only when `mcp:exarchos:readonly` is present AND
 * `mcp:exarchos` is NOT present (less-restrictive tier wins on merge).
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

// ─── Composite Handler Map ──────────────────────────────────────────────────

/**
 * Public, mutable map of composite handlers keyed by tool name.
 *
 * ## Primary vs override source (F-021-4)
 *
 * - **Primary source: `COMPOSITE_HANDLER_LOADERS`** — the lazy dynamic-import
 *   factories below are the canonical production source. Dispatch calls
 *   `loadCompositeHandler()` which imports the matching module on first use
 *   and caches the resolved handler in `COMPOSITE_HANDLERS`.
 *
 * - **Override source: `COMPOSITE_HANDLERS`** — this map is consulted **first**
 *   by `loadCompositeHandler()`. Writing a value here takes precedence over
 *   the loader and bypasses the dynamic import entirely. That makes it the
 *   designated test-stubbing surface: tests inject a spy/fake under a tool
 *   key, run `dispatch()`, and restore the prior value in a `finally` block.
 *
 * **Save/restore is the caller's responsibility.** Production code must NOT
 * mutate this map directly; use the `stubCompositeHandler()` helper instead,
 * which returns a scoped restore function.
 *
 * ### Historical context
 * Originally this map was populated at module-init via static imports of
 * every composite (workflow, event, orchestrate, view, sync). That static
 * graph cost ~70ms to load and was almost entirely wasted on CLI cold-starts
 * that only dispatch one composite per invocation (DR-5 / task 021).
 *
 * ### Example stub pattern
 * See `dispatch.test.ts:221` — `dispatch_compositeHandler_receivesDispatchContext`
 * demonstrates the save → override → restore-in-finally idiom manually. New
 * tests should prefer `stubCompositeHandler()` below.
 */
export const COMPOSITE_HANDLERS: Record<string, CompositeHandler> = {};

/**
 * Install a composite handler override for the duration of a test, returning
 * a disposer that restores the previous state. Consolidates the
 * save → override → restore-in-finally idiom so tests cannot leak stubs into
 * neighbouring cases when they forget to clean up.
 *
 * ```ts
 * const restore = stubCompositeHandler('exarchos_workflow', spy);
 * try {
 *   await dispatch('exarchos_workflow', { action: 'test' }, ctx);
 * } finally {
 *   restore();
 * }
 * ```
 *
 * Restores whatever was previously there (including `undefined`, i.e. the
 * absent-key case where the real lazy loader would take over).
 */
export function stubCompositeHandler(
  tool: string,
  handler: CompositeHandler,
): () => void {
  const hadPrev = tool in COMPOSITE_HANDLERS;
  const prev = COMPOSITE_HANDLERS[tool];
  COMPOSITE_HANDLERS[tool] = handler;
  return () => {
    if (hadPrev) {
      COMPOSITE_HANDLERS[tool] = prev as CompositeHandler;
    } else {
      delete COMPOSITE_HANDLERS[tool];
    }
  };
}

/**
 * Dynamic-import factories for each built-in composite.
 *
 * Exported as **mutable** so the F-021-3 test can inject a throwing loader to
 * exercise the `COMPOSITE_LOAD_FAILED` error path. Production code should
 * never mutate this map; the CI composite-coverage check treats non-built-in
 * additions as a regression.
 */
export const COMPOSITE_HANDLER_LOADERS: Record<string, () => Promise<CompositeHandler>> = {
  exarchos_workflow: () => import('../workflow/composite.js').then((m) => m.handleWorkflow),
  exarchos_event: () => import('../event-store/composite.js').then((m) => m.handleEvent),
  exarchos_orchestrate: () => import('../orchestrate/composite.js').then((m) => m.handleOrchestrate),
  exarchos_view: () => import('../views/composite.js').then((m) => m.handleView),
  exarchos_sync: () => import('../sync/composite.js').then((m) => m.handleSync),
};

/**
 * Resolve a composite handler by tool name. Returns `undefined` for
 * unknown tools (the caller is expected to fall through to custom-tool
 * dispatch). Caches loaded handlers in `COMPOSITE_HANDLERS` so repeat
 * lookups are synchronous-ish (still returns a Promise for uniformity).
 */
async function loadCompositeHandler(tool: string): Promise<CompositeHandler | undefined> {
  const cached = COMPOSITE_HANDLERS[tool];
  if (cached) return cached;

  const loader = COMPOSITE_HANDLER_LOADERS[tool];
  if (!loader) return undefined;

  const handler = await loader();
  // Cache so subsequent dispatches are a direct map lookup.
  COMPOSITE_HANDLERS[tool] = handler;
  return handler;
}

// ─── Dispatch Function ──────────────────────────────────────────────────────

/**
 * Type guard for ToolResult — validates structural shape rather than
 * relying on a simple `'success' in obj` check that could match any
 * object with a `success` property.
 */
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
 * Creates a handler for custom tools that routes to per-action handlers
 * stored in the registry. Mirrors the action-routing pattern used by
 * built-in composite handlers.
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
    // If the handler already returns a ToolResult, pass it through
    if (isToolResult(result)) {
      return result;
    }
    // Otherwise wrap the result
    return { success: true, data: result };
  };
}

/**
 * Transport-agnostic dispatch: routes tool calls to composite handlers.
 *
 * 1. Looks up the tool in COMPOSITE_HANDLERS
 * 2. If not found, returns an UNKNOWN_TOOL error
 * 3. Creates a CoreHandler that binds ctx
 * 4. Optionally wraps with telemetry
 * 5. Returns the ToolResult
 */
export async function dispatch(
  tool: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  // Lazy-loaded composite handler. Falls back to `undefined` when the tool
  // is not a built-in (e.g. custom tools registered via config).
  //
  // F-021-3: wrap in try/catch so a broken composite module graph (e.g.
  // `ERR_MODULE_NOT_FOUND` after a partial install, or a top-level-await
  // failure during dynamic import) surfaces as a structured ToolResult
  // instead of leaking through both the MCP transport and the CLI adapter.
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

  // Fall back to custom tool dispatch if not a built-in handler
  // Require both registry presence AND handlers to prevent leaked handlers from bypassing registration
  if (!builtInHandler && (!registeredTool || !hasCustomToolHandlers(tool))) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${tool}. Available tools: ${getFullRegistry().map((t) => t.name).join(', ')}`,
      },
    };
  }

  // ─── DR-5: Per-Action Schema Validation ─────────────────────────────────
  // Validate `args` against the matching action's Zod schema BEFORE routing
  // to the composite handler. This gives the MCP adapter the same
  // INVALID_INPUT rejection contract as the CLI adapter — any malformed
  // input (missing required field, wrong type, unknown action name) is
  // surfaced through a single `formatValidationError` code-path so both
  // facades emit byte-identical `error.code` values.
  //
  // Custom-tool dispatch is excluded from this validation pass because
  // custom-tool handlers may apply their own arg shaping before the
  // per-action schema is relevant.
  // Note: `builtInHandler` is typed non-nullable by the Record lookup, but
  // the earlier `!builtInHandler && ...` branch returns UNKNOWN_TOOL if the
  // tool is not built-in — so here we gate on whether the tool has a
  // built-in composite handler (not a custom one) by checking the map
  // directly against the composite-tool key set.
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

    // ─── #1290 — Roots-based featureId inference ─────────────────────────
    // Resolution priority (load-bearing for missing-required-param paths):
    //   explicit > roots > cwd > elicitation > INVALID_INPUT.
    // Elicitation is the LAST resort before INVALID_INPUT because it
    // requires a transport round-trip; roots + cwd inference are
    // round-trip-free and so take precedence (#1274). If the caller
    // already supplied a `featureId`, we leave it alone. Otherwise, if
    // the client declared the MCP roots capability (snapshotted on the
    // resolver via the initialize handshake), call `resolveWorkspace`
    // to attempt inference from the cached roots list or a cwd-walk
    // fallback.
    //
    // Multi-match returns a structured INVALID_INPUT here so the caller
    // can disambiguate; zero-match falls through to the existing per-
    // action Zod validation, which surfaces the legacy "featureId is
    // required" envelope unchanged.
    //
    // Sentry MEDIUM #1423: actions that never consume workspace context
    // (`describe`/`runbook`/`agent_spec` — pure introspection on the
    // registry / catalogs) skip the discovery call entirely. Pre-fix
    // these high-frequency informational calls each triggered a
    // synchronous cwd-walk on miss, adding measurable latency to the
    // dispatch hot path. The skip list is conservative: anything that
    // *might* take a featureId stays in the discovery branch.
    if (
      rest.featureId === undefined
      && ctx.capabilityResolver !== undefined
      && !NO_WORKSPACE_RESOLUTION_ACTIONS.has(actionName)
    ) {
      try {
        const { resolveWorkspace } = await import('../workspace/discovery.js');
        const resolution = await resolveWorkspace({
          resolver: ctx.capabilityResolver,
          rootsClient: ctx.rootsClient,
          cwd: ctx.cwd ?? process.cwd(),
          eventStore: ctx.eventStore,
        });
        if (resolution !== undefined) {
          if (resolution.success) {
            rest = { ...rest, featureId: resolution.featureId };
          } else {
            // Multi-match. Surface the structured INVALID_INPUT so the
            // caller can pick the intended target.
            return {
              success: false,
              error: {
                code: resolution.code,
                message:
                  `${tool}/${actionName}: multiple workspaces matched MCP roots; ` +
                  'supply an explicit featureId to disambiguate.',
                // CodeRabbit CRITICAL #1423: `ToolResult.error.validTargets`
                // expects `readonly (string | ValidTransitionTarget)[]`, but
                // workspace resolution returns
                // `readonly { featureId, path }[]`. Surface the featureIds
                // (the disambiguator the caller actually supplies) so the
                // envelope satisfies the contract.
                validTargets: resolution.validTargets?.map((t) => t.featureId),
              },
            };
          }
        }
      } catch (err) {
        // Discovery is a best-effort inference hook — a failure must not
        // mask the legacy validation contract. Fall through to the
        // existing schema check; callers see the standard "featureId
        // is required" envelope. CodeRabbit MINOR #1423: silent catches
        // violate the project's observability standard. Surface via the
        // workspace-discovery logger child so the failure is auditable
        // without changing the user-facing fallback.
        logger.child({ subsystem: 'workspace-discovery' }).warn(
          {
            tool,
            action: actionName,
            error: err instanceof Error ? err.message : String(err),
          },
          'workspace inference failed; falling back to legacy featureId validation',
        );
      }
    }

    // Tolerant Dispatch (#1188): the MCP SDK validates against the flattened
    // parent schema (buildRegistrationSchema) and applies sibling-action
    // defaults (e.g. `nativeIsolation` from prepare_delegation, `outputFormat`
    // from agent_spec) to every payload. Per-action schemas use .strict()
    // to catch caller typos, so those leaked defaults would be rejected as
    // unrecognized keys.
    //
    // Strip only sibling-action keys: a key declared on some other action's
    // schema but not on the matching action's. Keys that aren't declared
    // anywhere (caller typos) pass through so .strict() still rejects
    // them — preserving the typo-detection guard.
    const actionShape = (matchingAction.schema as { shape?: Record<string, unknown> }).shape;
    const cleanedRest =
      actionShape && typeof actionShape === 'object'
        ? (() => {
            const siblingKeys = new Set<string>();
            for (const a of registeredTool.actions) {
              if (a === matchingAction) continue;
              const shape = (a.schema as { shape?: Record<string, unknown> }).shape;
              if (shape && typeof shape === 'object') {
                for (const k of Object.keys(shape)) siblingKeys.add(k);
              }
            }
            return Object.fromEntries(
              Object.entries(rest).filter(([k]) => {
                const inAction = Object.prototype.hasOwnProperty.call(actionShape, k);
                if (inAction) return true;
                // Drop sibling-action keys (leaked parent defaults). Keep
                // unknown keys so the per-action .strict() guard rejects
                // caller typos with a clear error.
                return !siblingKeys.has(k);
              }),
            );
          })()
        : rest;
    // CodeRabbit CRITICAL #1424: pass `reportInput: true` so Zod retains
    // the original input on each issue. `extractSingleMissingRequiredField`
    // (above) needs `issue.input === undefined` to distinguish "field
    // missing" from "field present but wrong type." Without this flag,
    // wrong-type errors would be misclassified as missing-field and route
    // through the elicitation hand-off — a confusing UX divergence from
    // the caller's actual problem.
    let parsed = matchingAction.schema.safeParse(cleanedRest, { reportInput: true });

    // ─── #1274 — Elicitation hand-off on missing required param ──────────
    // If validation failed because exactly one required field is missing
    // AND the client declared the MCP `elicitation` capability AND an
    // elicitation client adapter is wired into the context, route through
    // the elicitation hand-off and retry the validation with the elicited
    // value spliced into the payload. This is the LAST resort before
    // INVALID_INPUT — round-trip-free inference paths (explicit/roots/cwd)
    // have already executed by the time we get here.
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
            '../dispatch/elicitation-dispatch.js'
          );
          const operationId = `${tool}-${actionName}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 10)}`;
          const elicitation = await performElicitation({
            inputSchema: actionSchema,
            missingField,
            client: ctx.elicitationClient,
            eventStore: ctx.eventStore,
            operationId,
          });
          if (elicitation.fulfilled) {
            // CodeRabbit MINOR #1424: always overwrite `parsed` with the
            // retry result, even when the elicited value is invalid.
            // Keeping the original pre-elicitation parse error would
            // surface a "missing field" envelope when the real failure is
            // the wrong-type elicited value — confusing the caller about
            // which input to correct.
            parsed = matchingAction.schema.safeParse({
              ...cleanedRest,
              [missingField]: elicitation.value,
            });
          }
        } catch {
          // Elicitation is a best-effort hand-off; transport failures
          // must not mask the legacy INVALID_INPUT envelope. Fall through
          // to the validation-failure return below.
        }
      }
    }

    if (!parsed.success) {
      const context = `${tool}/${actionName}`;
      return {
        success: false,
        error: formatValidationError(parsed.error, context),
      };
    }

    // Thread the validated args forward so downstream handlers get the
    // coerced shape (z.preprocess effects, defaults, etc.).
    args = { action: actionName, ...parsed.data } as Record<string, unknown>;

    // T04 (Issue #1192): apply the readonly capability gate AFTER schema
    // validation so callers still get INVALID_INPUT for malformed payloads
    // that happen to target a denied action — the readonly gate is for
    // capability shaping, not input validation. Gate is built-in only;
    // custom tools manage their own capability surface.
    const denied = enforceReadonlyGate(tool, actionName, ctx.capabilityResolver);
    if (denied) return denied;

    // T-12 (P4 of rehydration-machinery-refactor): emit
    // `session.machinery_consumed` on the first non-rehydrate L5 handler
    // invocation that follows a `workflow.rehydrated` event landing on the
    // stream. The interceptor is keyed by the dispatched action's
    // `featureId` (its streamId); calls without a featureId — descriptive
    // actions like `describe`, `runbook` — short-circuit inside the
    // interceptor itself. Failures inside the interceptor are
    // logged-and-swallowed (observability emission must not fail the
    // dispatch); see `interceptors/session-machinery.ts` for the cache &
    // idempotency contract.
    const streamId = (() => {
      const fid = (args as { featureId?: unknown }).featureId;
      return typeof fid === 'string' && fid.length > 0 ? fid : undefined;
    })();
    await runSessionMachineryConsumedInterceptor(ctx.eventStore, streamId, actionName);
  }

  const coreHandler = builtInHandler
    ? async (a: Record<string, unknown>) => builtInHandler(a, ctx)
    : createCustomToolHandler(tool);

  try {
    if (ctx.enableTelemetry) {
      // Lazy-load to keep CLI cold-start under the DR-5 budget.
      const { withTelemetry } = await import('../telemetry/middleware.js');
      const wrappedHandler = withTelemetry(coreHandler, tool, ctx.eventStore);
      return await wrappedHandler(args);
    }

    return await coreHandler(args);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unhandled dispatch error',
      },
    };
  }
}


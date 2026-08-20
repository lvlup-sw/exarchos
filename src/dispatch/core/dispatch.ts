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
import { hasCustomToolHandlers, getCustomToolActionHandler, getFullRegistry, findActionInRegistry } from '../../registry.js';
// The response-economy seam lives in its own leaf (`./response-economy.js`) so
// the telemetry middleware can import `enforceResponseEconomy` without the
// dispatch ↔ middleware runtime import cycle (DR-4, task 009). Re-exported below
// so the seam tests and any historical `dispatch/core/dispatch.js` importers are
// unaffected; dispatch() still calls the seam directly (see the coreHandler
// wrap sites), which the economy no-bypass gate (`dispatch.economy-seam.ts`)
// pins by source structure.
import { enforceResponseEconomy, ECONOMY_CARRIER_KEYS } from './response-economy.js';
export { enforceResponseEconomy, ECONOMY_CARRIER_KEYS };
import type { NextAction } from '../../next-action.js';
import {
  formatValidationError,
  buildInvalidInput,
} from '../../adapters/cli/schema-to-flags.js';
import { runSessionMachineryConsumedInterceptor } from './interceptors/session-machinery.js';
import {
  dispatchStreamId,
  emissionViolationBlocks,
  runEmissionVerifierInterceptor,
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
import type { ToolAction } from '../../registry.js';
import path from 'node:path';
import {
  detectActiveStoreDivergence,
  describeStoreDivergence,
  resolveStateDir,
  toPosix,
  ALLOW_STORE_DIVERGENCE_ENV,
} from '../../utils/paths.js';
import type { EventSourcedTaskStore } from '../../projections/task-store/event-sourced-task-store.js';

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
  /**
   * Runtime-owned, non-PII caller identity. Production adapters derive this
   * from MCP session state or the local installation; action args never feed it.
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
   * `index.ts` / `dispatch/core/context.ts` opens the SQLite (or in-memory)
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
  readonly storage?: StorageBackend | undefined;
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
  /**
   * Event-sourced SDK TaskStore (#1272 / B3). When wired, dispatch
   * inspects the dispatched args for the SDK `task: { ttl? }`
   * augmentation key (#1273 / C1) and, when present, routes through
   * `runTasksAugmented` to synthesize an SDK `CreateTaskResult`-shaped
   * envelope instead of the legacy one-shot `ToolResult`. When absent,
   * dispatch falls back to the one-shot path even if `args.task` is
   * present (defensive: lets CLI cold-start and in-process tests skip
   * the augmentation surface without crashing).
   */
  readonly taskStore?: EventSourcedTaskStore;
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

export function extractSingleMissingRequiredField(
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
  //   - the issue code is 'invalid_type' (Zod's universal "missing" code), AND
  //   - the issue's `input` is `undefined` (the primary "field missing"
  //     disambiguator across Zod v3 and v4 — populated by reportInput at
  //     the call site; see comment at the safeParse site below). The
  //     non-standard `received` property is *also* inspected as a
  //     belt-and-suspenders signal, but its presence varies:
  //       - Zod v3 populates `received: 'undefined'` (the string) for
  //         missing fields.
  //       - Zod v4 omits the `received` property entirely (Issue #1451 /
  //         discovered via #1436 E2E smoketest). The runtime value of
  //         `(issue as any).received` is therefore JS `undefined`.
  //     Both signals are valid "missing field" indicators; we reject only
  //     when `received` carries some OTHER value (a wrong-type indicator
  //     like 'string' or 'number'). The `input !== undefined` guard above
  //     is what actually keeps wrong-type errors from leaking into the
  //     elicitation hand-off — CodeRabbit CRITICAL #1424 remains satisfied.
  const issues = error.issues;
  if (issues.length !== 1) return undefined;
  const only = issues[0];
  if (only === undefined) return undefined;
  if (only.code !== 'invalid_type') return undefined;
  if (only.input !== undefined) return undefined;
  if (only.path.length !== 1) return undefined;
  const key = only.path[0];
  if (typeof key !== 'string') return undefined;
  // Dual-signal received-property gate (#1451). Accept absence (Zod v4)
  // or the literal string 'undefined' (Zod v3); reject any other value
  // (a wrong-type indicator).
  const received = (only as { received?: unknown }).received;
  if (received !== 'undefined' && received !== undefined) return undefined;
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
  // `add_pr_comment`, `init`, `prune_stale_workflows`,
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
 * Actions that remain available even on a stale/mixed install — the diagnostic
 * surface an operator needs to SEE and REPAIR a blocked install (P05-04). The
 * install-freshness gate below fires for every mutating built-in action EXCEPT
 * these. `doctor` is the load-bearing entry: it is deliberately excluded from
 * {@link READ_ONLY_ACTIONS} (it emits `diagnostic.executed`), so without this
 * carve-out `exarchos doctor` would itself be blocked by the very freshness
 * failure it exists to diagnose.
 */
const FRESHNESS_GATE_DIAGNOSTIC_EXEMPT: ReadonlySet<string> = new Set([
  'doctor',
]);

/**
 * True when `action` on `tool` must NOT trip the install-freshness gate —
 * either it is a read-only action (no workflow mutation to gate) or it is on
 * the diagnostic carve-out above. Reuses {@link READ_ONLY_ACTIONS} so the
 * read-only classification has a single source of truth.
 */
function isFreshnessGateExempt(tool: string, action: string): boolean {
  // Exactly what the doc above says in prose: read-only, PLUS the diagnostic
  // carve-out. Expressed as a composition so the read-only classification is
  // read from one place instead of being spelled out twice.
  return isReadOnlyAction(tool, action) || FRESHNESS_GATE_DIAGNOSTIC_EXEMPT.has(action);
}

/**
 * True when `action` on `tool` only reads.
 *
 * The primitive both gates share. The store-divergence check uses it directly
 * rather than through {@link isFreshnessGateExempt}, because the diagnostic
 * carve-out points the other way here: a divergence warning is precisely what
 * `doctor` should carry, so `doctor` must not be exempt from it.
 */
function isReadOnlyAction(tool: string, action: string): boolean {
  const allowed = (READ_ONLY_ACTIONS as Record<string, readonly string[] | '*'>)[tool];
  if (allowed === '*') return true;
  return allowed !== undefined && allowed.includes(action);
}

/**
 * Actions that never consume a `featureId` (Sentry MEDIUM #1423).
 *
 * The roots-based workspace-discovery branch in `dispatch()` skips its
 * synchronous filesystem walk for actions in this set so high-frequency
 * introspection calls (catalog reads, runbook fetches, agent-spec
 * lookups) don't pay the discovery cost.
 *
 * This list is a LATENCY shortcut and nothing more. It is deliberately NOT
 * load-bearing for correctness: {@link actionAcceptsInferredFeatureId} decides
 * whether inference may run at all, reading the receiving action's own schema.
 * A name missing from this set costs a filesystem walk; it can no longer cost
 * a rejected call.
 */
const NO_WORKSPACE_RESOLUTION_ACTIONS: ReadonlySet<string> = new Set([
  'describe',
  'runbook',
  'agent_spec',
]);

/**
 * May the roots/cwd resolver hand this action an inferred `featureId`?
 *
 * Only when the action's OWN schema declares the field. Every composite tool
 * flattens its actions into one registration schema, so the wire accepts the
 * union of every action's fields — but routing hands the payload to a single
 * strict schema that knows only its own. Injecting into an action that does
 * not declare `featureId` therefore manufactures the exact refusal
 * `undeclared-parameters.ts` exists to raise, naming a parameter the caller
 * never sent and the server itself added.
 *
 * The predicate reads the same `schema.shape` that builds that refusal, so the
 * two can no longer disagree: a newly-added action is classified correctly the
 * moment it is declared, with no list to keep in step.
 *
 * Exported for the regression guard, which asserts this over the whole
 * registry rather than executing 59 handlers to discover it.
 */
export function actionAcceptsInferredFeatureId(action: ToolAction): boolean {
  return action.schema.shape['featureId'] !== undefined;
}

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
/**
 * Tools whose composite handler is currently a test stub.
 *
 * `COMPOSITE_HANDLERS` cannot answer this: the lazy loader writes real handlers
 * into the same map, so membership means "loaded", not "stubbed". The emission
 * verifier needs the distinction because the emission contract is a promise made
 * by the REGISTERED handler — a stub that returns a canned envelope never made
 * it, and asserting it against one reports drift that exists only in the fixture.
 */
const STUBBED_COMPOSITES = new Set<string>();

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
 * Dynamic-import factories for each built-in composite.
 *
 * Exported as **mutable** so the F-021-3 test can inject a throwing loader to
 * exercise the `COMPOSITE_LOAD_FAILED` error path. Production code should
 * never mutate this map; the CI composite-coverage check treats non-built-in
 * additions as a regression.
 */
export const COMPOSITE_HANDLER_LOADERS: Record<string, () => Promise<CompositeHandler>> = {
  exarchos_workflow: () => import('../../workflow/composite.js').then((m) => m.handleWorkflow),
  exarchos_event: () => import('../../events/composite.js').then((m) => m.handleEvent),
  exarchos_orchestrate: () => import('../../verbs/composite.js').then((m) => m.handleOrchestrate),
  exarchos_view: () => import('../../projections/views/composite.js').then((m) => m.handleView),
  exarchos_sync: () => import('../../sync/composite.js').then((m) => m.handleSync),
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

// ─── Response-Economy Enforcement (DR-1, Task 003) ──────────────────────────
//
// The registry-declared response-economy contract (DR-1) is DECLARED on each
// action descriptor (`economy` block, `registry.ts`) and ENFORCED at the shared
// dispatch core, so both facades (CLI + MCP) inherit the cap by construction
// (INV-2). The seam (`enforceResponseEconomy`) runs post-handler, immediately
// BEFORE the telemetry middleware's `injectPerf` (`projections/telemetry/middleware.ts`) —
// the same seam that already measures response bytes/tokens — so the cap and the
// reported `_perf` size agree by construction: the middleware measures the value
// the seam returns.
//
// The seam itself (and `ECONOMY_CARRIER_KEYS`) now lives in the `./response-economy.js`
// LEAF (DR-4, task 009) so the middleware can import it without the dispatch ↔
// middleware runtime cycle. Both are imported + re-exported at the top of this
// file. dispatch() still applies the seam directly at the coreHandler wrap sites
// (Axis A of the economy no-bypass gate, `dispatch.economy-seam.ts`).

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
  // ─── #1273 / C1 — Tasks-augmented branch detection ──────────────────────
  // Detect the SDK `task: { ttl? }` augmentation key BEFORE any per-action
  // schema validation runs. Per-action schemas are `.strict()` so an
  // unrecognised `task` key would be rejected as a typo; we strip it from
  // args early and rebind to a clean payload for the rest of dispatch.
  //
  // Recorded here (not after validation) so the augmentation request
  // survives sibling-action-key cleanup downstream. We only ACT on the
  // augmentation later, after schema validation passes and once we have
  // `coreHandler` resolved — see the `taskAugmented` block near the end
  // of this function.
  const taskAugmented = isTaskAugmented(args);
  const taskOptionsRaw = taskAugmented ? (args as { task?: unknown }).task : undefined;
  if (taskAugmented) {
    // Strip `task` from the args we hand to validation. Use a fresh object
    // so we don't mutate the caller's payload.
    const { task: _stripped, ...rest } = args as { task?: unknown } & Record<string, unknown>;
    void _stripped;
    args = rest;
  }

  // ─── T11 (#1440 Op 4, Preview-4 §4.4) — retry_with_task hint clock ──────
  // Capture the dispatch-entry timestamp here so the emission rule at the
  // post-handler boundary can compute elapsed wall-clock time. Anchored as
  // early as possible (after `task: { ttl }` strip; before workspace
  // resolution / schema validation / handler invocation) so the elapsed
  // measurement covers the full dispatch round-trip the caller observes.
  const dispatchStartTs = Date.now();

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
  // ─── #1291 Sentry MEDIUM — Mint dispatch context BEFORE workspace +
  // ─── elicitation so transitively-emitted events (workspace.resolved,
  // ─── elicitation.requested/fulfilled/declined) carry the same
  // ─── operationId as the handler events. Pre-fix the context was minted
  // ─── after these branches, so the early events lacked operationId and
  // ─── multi-match / validation-failure / gate-deny early returns lacked
  // ─── the _meta correlation block entirely. The dispatch context is
  // ─── derived once here and reused everywhere via AsyncLocalStorage.
  const authorization = ctx.callerIdentity === undefined
    ? undefined
    : snapshotCallerAuthorization(ctx.callerIdentity, ctx.capabilityResolver);
  const dispatchCtx = mintDispatchContextFromRequest(args, authorization);

  // Computed once per dispatch and reused by both the read-side warning and
  // the write-side refusal below, so the existence probe runs at most once on
  // the hot path.
  //
  // Scoped to a context whose store came from the AMBIENT cascade. When a
  // caller supplied an explicit state dir — `--state-dir`, an embedding host,
  // every in-process test — there is no ambiguity about which store was meant,
  // so there is nothing to warn about and nothing to refuse. Without this the
  // verdict would depend on which stores happen to exist under the invoking
  // user's home, making dispatch behave differently on a developer machine
  // than in CI.
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
    // Non-destructive merge: caller-supplied `_meta` wins on conflict.
    const mergedMeta = existingMeta
      ? { ...correlationMeta, ...existingMeta }
      : correlationMeta;
    // A read answered from a store the other surface never sees carries the
    // caveat INLINE. The `prepare_delegation` envelope that made this issue
    // expensive was internally consistent and wrong, with nothing in it
    // hinting that two stores existed; a separate `doctor` run was the only
    // way to learn that, and by then the reader trusted the verdict.
    const warnings = storeDivergence?.shouldWarn === true
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
    // Sentry MEDIUM #1424: skip workspace resolution entirely when
    // `rootsClient` is undefined — that's the CLI dispatch path which has
    // no MCP roots channel and therefore no useful inference target. The
    // sync `cwdWalk` fallback would still fire and add filesystem latency
    // to every CLI hot-path dispatch (telemetry view, doctor checks, etc.)
    // that happens to omit a featureId. Roots+cwd inference is purely an
    // MCP-client convenience for callers that DID declare roots.
    //
    // The receiving action's schema is consulted FIRST. Inference is a
    // convenience for actions that take a featureId; for an action that does
    // not declare one there is nothing to infer, and injecting anyway turns a
    // successful resolution into an INVALID_INPUT naming a field the caller
    // never sent. That inverted failure hit 59 of the 124 registered actions
    // — including `doctor`, so the diagnostic of record broke exactly when an
    // operator reached for it — and it reproduced only where roots resolution
    // SUCCEEDS, which is why the repo's own suite never saw it.
    if (
      rest.featureId === undefined
      && ctx.capabilityResolver !== undefined
      && ctx.rootsClient !== undefined
      && actionAcceptsInferredFeatureId(matchingAction)
      && !NO_WORKSPACE_RESOLUTION_ACTIONS.has(actionName)
    ) {
      try {
        const { resolveWorkspace } = await import('../../runtime/workspace/discovery.js');
        const resolution = await resolveWorkspace({
          resolver: ctx.capabilityResolver,
          rootsClient: ctx.rootsClient,
          cwd: ctx.cwd ?? process.cwd(),
          eventStore: ctx.eventStore,
          // #1504 — authoritative workflow enumeration via the projected
          // `workflow_state` table when probing this server's own workspace.
          storage: ctx.storage,
        });
        if (resolution !== undefined) {
          if (resolution.success) {
            rest = { ...rest, featureId: resolution.featureId };
          } else {
            // Multi-match. Surface the structured INVALID_INPUT so the
            // caller can pick the intended target. CodeRabbit CRITICAL
            // #1428: map `validTargets` from `{featureId,path}` records
            // to plain `featureId` strings — that's the disambiguator the
            // caller actually supplies in the retry. The published error
            // contract expects `readonly (string | ValidTransitionTarget)[]`.
            // CodeRabbit CRITICAL + Sentry #1428: also attach _meta so
            // the multi-match envelope carries correlation IDs (parity
            // with success + thrown-error paths). Pre-fix this was the
            // ONE early-return path that diverged from the published
            // error contract.
            return attachMeta({
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
            });
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

    // ─── DR-7 — honoured, or refused (never accepted-and-dropped) ────────
    //
    // The MCP SDK validates against the flattened parent schema
    // (buildRegistrationSchema), which is the UNION of every action's
    // fields — so the wire admits a field the routed action has never heard
    // of. This site used to reconcile that by deleting any such field before
    // per-action validation, which turned "the action ignores your
    // parameter" into a success response. `dryRun` aimed at `transition` was
    // the live instance: `cancel` and `cleanup` declare it, `transition`
    // does not, so a dry-run probe performed the real transition and
    // reported success.
    //
    // What survives from the old strip is only the case that motivated it —
    // a default the SDK injected from a sibling action, recognised by value.
    // Everything else is forwarded to the action's own schema, and the
    // refusal below reads that schema's verdict rather than second-guessing
    // it. The rule and its exemptions live in `undeclared-parameters.ts`,
    // derived from the registry, so a new action or a newly-defaulted field
    // is covered without an edit here.
    const { forwarded: cleanedRest, unshaped } = selectForwardedParameters(
      rest,
      matchingAction,
      registeredTool.actions,
    );
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
            '../elicitation-dispatch.js'
          );
          // Sentry MEDIUM #1428: reuse the dispatch-context operationId
          // here. Pre-fix elicitation minted its own operationId, so the
          // elicitation events (`elicitation.requested`, `.fulfilled`,
          // `.declined`) were uncorrelated with the dispatch events on
          // the same operation. Threading the dispatchCtx operationId
          // keeps the entire dispatch (including the elicitation
          // round-trip) on a single correlation tuple.
          const elicitation = await performElicitation({
            inputSchema: actionSchema,
            missingField,
            client: ctx.elicitationClient,
            eventStore: ctx.eventStore,
            operationId: dispatchCtx.operationId,
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
      return attachMeta({
        success: false,
        error: formatValidationError(parsed.error, context),
      });
    }

    // DR-7, second half: the parse succeeded, so ask what it did with the
    // parameters the action never declared. A `.passthrough()` action keeps
    // them (it answers for them itself); a plain `z.object` drops them, and
    // dropping them is the silent-ignore this refusal exists to end. Read
    // AFTER the parse because the schema's own verdict is the thing being
    // read — not a guess made from its shape.
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

    // Thread the validated args forward so downstream handlers get the
    // coerced shape (z.preprocess effects, defaults, etc.).
    args = { action: actionName, ...parsed.data } as Record<string, unknown>;

    // T04 (Issue #1192): apply the readonly capability gate AFTER schema
    // validation so callers still get INVALID_INPUT for malformed payloads
    // that happen to target a denied action — the readonly gate is for
    // capability shaping, not input validation. Gate is built-in only;
    // custom tools manage their own capability surface.
    const denied = enforceReadonlyGate(tool, actionName, ctx.capabilityResolver);
    if (denied) return attachMeta(denied);

    // A `shared-mutating` posture gate used to sit here and reject callers of
    // merge_orchestrate / serialize_merge / prune_worktrees. Deleted under
    // INV-11; rationale in `capabilities/shared-mutating-gate.test.ts`. Short
    // version: agent postures never reached this resolver, so it denied
    // everything, and the confinement it claimed to enforce is not ours to
    // enforce. The readonly gate above still covers state authority.

    // ─── Store-path divergence — refuse a write into a ghost store ───────
    // The detector already existed (`computeStorePathDivergence`, DR-11 B-5)
    // but its only consumer was the doctor check, so mutations landed in the
    // non-plugin store and reported SUCCESS while the orchestrator read a
    // different one. The tell surfaced steps later as STATE_NOT_FOUND, and
    // gates like `prepare_delegation` answered from the ghost store with a
    // self-consistent, entirely wrong verdict. Every symptom pointed away
    // from the cause.
    //
    // It runs FIRST among the pre-execution gates. The session-machinery
    // interceptor below APPENDS an event, so refusing after it would write
    // into the very ghost store this refusal exists to keep out — a refusal
    // that already mutated is not a refusal.
    //
    // Refusal is scoped to an ACTIVE divergence — the other store must exist —
    // because bare divergence is true for every standalone CLI invocation and
    // refusing on it would break users who never installed the plugin.
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

    // ─── P05-04 — Install & cache freshness gate ─────────────────────────
    // Block a stale/mixed installation BEFORE it executes a mutating action.
    // This is the pre-workflow-execution chokepoint that wires the binary /
    // plugin / skill / cache dimensions (the schema dimension is additionally
    // enforced at store-open). Scoped to mutating built-in actions only —
    // read-only + diagnostic actions (see `isFreshnessGateExempt`) stay
    // available so an operator can DIAGNOSE and REPAIR the block. The gate is
    // memoized once per process and SKIPS entirely on a dev checkout, so this
    // is a no-op for source-run / in-process tests and adds a single one-time
    // filesystem read on the first mutating action of a real install.
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

  // Handler invocation inside the dispatch-context wrapper opened at the
  // top of dispatch(). `attachMeta` adds the three correlation IDs to the
  // success result; the catch handler below attaches them to errors.
  //
  // ─── #1273 / C1 — Tasks-augmented synthesis ────────────────────────
  // When the caller threaded `task: { ttl? }` AND a TaskStore is wired
  // on the context, route the underlying handler through
  // `runTasksAugmented` so the response is a SDK CreateTaskResult
  // envelope rather than the one-shot ToolResult. Without `taskStore`
  // (CLI cold-start, in-process tests that omit the wiring), we fall
  // back to the one-shot path so callers that legitimately have no
  // task substrate don't crash.
  // ─── #1273 / T32 — capability-negotiation gate ─────────────────────
  // The augmentation only fires when the client declared the `tasks`
  // capability in the MCP initialize handshake. The CLI / in-process
  // callers do NOT have a resolver wired (no handshake to snapshot),
  // so we treat an absent resolver as "not gated" — direct callers
  // that thread `task: {ttl}` opt themselves in. Defence-in-depth:
  // an MCP client that never advertised tasks support cannot opt in
  // by smuggling a `task` key into args; capability negotiation wins.
  let result: ToolResult;
  // DR-1 / INV-17: the response-economy budget is a property of the dispatch
  // CONTRACT, not of telemetry. `withTelemetry` caps on the telemetry-ON paths
  // (so `_perf` / the D3 gate measure the post-cap size). The telemetry-OFF
  // leaves below must cap too — otherwise `EXARCHOS_TELEMETRY=false` (a
  // documented event-silencing switch) would silently disable ALL enforcement,
  // contradicting INV-17's "every action". `enforceResponseEconomy` is
  // idempotent (a capped/under-budget result re-passes as a no-op), so applying
  // it here never double-caps a telemetry-ON result.
  const economyActionName = typeof args.action === 'string' ? args.action : undefined;
  // ─── #1273 / C1+C2 — Tasks-augmented synthesis ─────────────────────────
  // When the caller threaded `task: { ttl? }` AND a TaskStore is wired AND
  // the MCP client declared the `tasks` capability (or no resolver is
  // present — CLI/in-process direct callers), route the underlying handler
  // through `runTasksAugmented`. Without the capability declaration, fall
  // back to one-shot so an MCP client that never advertised tasks support
  // can't opt in by smuggling a `task` key into args. Without `taskStore`,
  // also fall back (CLI cold-start, in-process tests that omit wiring).
  const taskCapabilityGate =
    ctx.capabilityResolver === undefined ||
    ctx.capabilityResolver.isTaskSupportDeclared();
  if (taskAugmented && ctx.taskStore && taskCapabilityGate) {
    const taskOptions = extractTaskOptions(taskOptionsRaw);
    // Build the SDK Request envelope from the dispatch args. The MCP
    // adapter (C2) supplies the real `tools/call` request id; direct
    // dispatch callers (CLI, tests) synthesize a deterministic one
    // anchored on operationId so audit can still correlate.
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
    // Lazy-load to keep CLI cold-start under the DR-5 budget.
    const { withTelemetry } = await import('../../projections/telemetry/middleware.js');
    const wrappedHandler = withTelemetry(coreHandler, tool, ctx.eventStore);
    result = await wrappedHandler(args);
  } else {
    // Telemetry-OFF leaf: cap here so enforcement is not gated on telemetry.
    result = enforceResponseEconomy(await coreHandler(args), tool, economyActionName);
  }

  // ─── T11 (#1440 Op 4, Preview-4 §4.4) — retry_with_task hint emission ───
  // After the handler returns its ToolResult, decide whether the caller
  // should be advised to re-invoke this action under the Tasks-augmented
  // dispatch path. Conditions (all must hold):
  //
  //   1. The action's registry annotation declares `dispatch.taskSuitable === true`.
  //   2. The caller did NOT thread `task: { ttl }` (i.e., `taskAugmented === false`).
  //   3. Elapsed wall-clock dispatch time exceeded the threshold (default 10_000 ms).
  //
  // When all three hold, prepend a `{ verb: 'retry_with_task', reason,
  // ttl_suggestion_ms }` next-action to `result.next_actions`. The hint
  // schema lives at `next-action.ts:92` (RetryWithTaskNextActionSchema).
  //
  // Prepended (not appended) because it is a meta-hint about dispatch
  // *shape*, not about the result's domain content — callers reading the
  // first hint to decide their next step see the augmentation suggestion
  // before any result-derived workflow verbs.
  //
  // TODO(#1440 Op 4 follow-up): wire `config.dispatch.retryWithTaskHintThresholdMs`
  // through `ExarchosConfig` so projects can tune the threshold without
  // touching dispatch core. Hardcoded for now per design §4.4.
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

  // ─── Post-dispatch emission verification ────────────────────────────────
  // The handler has completed, which is the only point at which "did the
  // events this action unconditionally declares actually land?" is a question
  // with an answer. Every branch above this line returned before a handler
  // ran, and is declared `not-applicable` rather than exempted quietly —
  // `interceptors/emission-verifier.ts` holds that declaration and the
  // structural assertion in the dispatch tests reads it.
  //
  // How hard this bites is `events.emission-enforcement`, and a mode is only a
  // mode if something reads it. The verdict was previously awaited and dropped:
  // `block` — the default, and the value every no-config run gets — chose a log
  // LEVEL and nothing else, so the config declared an enforcement no code path
  // could perform and `emissionViolationBlocks` had no caller outside its tests.
  // The fault is still ours rather than the caller's, which is what the mode is
  // for: an operator who wants the old behavior sets `advisory` and gets the
  // finding without the failure.
  const emissionVerdict = await runEmissionVerifierInterceptor(ctx.eventStore, {
    tool,
    action: typeof args.action === 'string' ? args.action : '',
    operationId: dispatchCtx.operationId,
    // Both spellings of the same thing. A stream is named `featureId` on most
    // actions and `streamId` on those re-parented onto a stream they did not
    // open — `stack_place` is one, and it declares `stack.position-filled`
    // unconditionally. Reading only `featureId` resolved every such action to
    // `not-applicable`, so an action with an unconditional contract was exempt
    // from the check by the NAME of its parameter. The residue is declared, not
    // silent: an action carrying neither still resolves `no-stream`.
    streamId: dispatchStreamId(args),
    declared:
      typeof args.action === 'string'
        ? findActionInRegistry(tool, args.action)?.autoEmits
        : undefined,
    handlerStubbed: STUBBED_COMPOSITES.has(tool),
    handlerSucceeded: result.success,
    // The interceptor resolves the mode again for its own log level. Without
    // this the record read `enforcement: block` on a run that was configured
    // advisory and did not fail — the log and the outcome disagreeing about
    // which mode was in force.
    ...(ctx.projectConfig !== undefined ? { projectConfig: ctx.projectConfig } : {}),
  });

  if (emissionViolationBlocks(emissionVerdict, ctx.projectConfig)) {
    const undelivered = [
      ...emissionVerdict.missingEvents,
      ...emissionVerdict.lifecycleViolations.map((v) => v.event),
    ];
    // The disposition is the load-bearing half of this envelope. Every
    // `not-applicable` arm above returns first, so `violated` is reached ONLY
    // when the handler ran to completion AND reported success — the effects are
    // already performed. `exarchos_orchestrate` carries `create_pr`, `merge_pr`,
    // `merge_orchestrate` and `acquire_worktree`, none idempotent under a naive
    // retry, so a bare failure would invite a caller to repeat a mutation that
    // already succeeded. The handler's payload rides along for the same reason:
    // a broken bookkeeping check is not a reason to withhold what the operation
    // produced.
    return attachMeta({
      success: false,
      data: result.data,
      error: {
        code: 'EMISSION_CONTRACT_VIOLATED',
        message:
          `${tool}.${typeof args.action === 'string' ? args.action : ''} declares an ` +
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

import type { ToolResult } from '../../format.js';
import { logger } from '../../logger.js';
import type { EventStore } from '../../events/store.js';
import type { ExarchosConfig } from '../../config/define.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { VcsProvider } from '../../vcs/provider.js';
import type { ConfigHookRunner } from '../../hooks/config-hooks.js';
import type { Outbox } from '../../sync/outbox.js';
import type { ChannelEmitter } from '../../adapters/channel/emitter.js';
import {
  capabilityNeedSatisfied,
  type CapabilityResolver,
} from '../../workflow/capabilities/resolver.js';
import type { StorageBackend } from '../../storage/backend.js';
import type { RootsClient } from '../../runtime/workspace/discovery.js';
import type { ElicitationClient } from '../elicitation-dispatch.js';
import { hasCustomToolHandlers, getCustomToolActionHandler, getFullRegistry, findActionInRegistry, normalizeActionContract, type ToolAction } from '../../registry.js';
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
import { workflowStateProjection } from '../../projections/views/workflow-state-projection.js';
import type { EventSourcedTaskStore } from '../../projections/task-store/event-sourced-task-store.js';
import { evaluateActionAdmission } from '../../workflow/admission/action-admission.js';
import { POLICY_CAPABILITY } from '../../workflow/admission/policy-authority.js';
import { ADMISSION_EVENT_TYPES } from '../../workflow/admission/types.js';
import { AdmissionEvidenceRecordedData } from '../../events/schemas.js';
import type { CallerAuthorizationSnapshot } from '../caller-identity.js';
import { isBlockingHostObligation } from '../../registry/action-contract.js';
import type { ActionContract, ActionRequirement } from '../../registry/action-contract.js';
import {
  applicableEnsures,
  observeActionPostconditions,
  type ActionPostconditionObservation,
} from './action-postconditions.js';
import { INFRA_STREAM_IDS } from './infra-streams.js';

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

function registryActionId(tool: string, actionName: string): string {
  return `${tool}.${actionName}`;
}

function workflowSubjectFromArgs(
  args: Record<string, unknown>,
): { readonly featureId: string; readonly stream: string } | undefined {
  const featureId =
    typeof args.featureId === 'string' && args.featureId.length > 0
      ? args.featureId
      : undefined;
  const namedStream =
    typeof args.stream === 'string' && args.stream.length > 0
      ? args.stream
      : typeof args.streamId === 'string' && args.streamId.length > 0
        ? args.streamId
        : undefined;
  const stream = namedStream ?? featureId;
  if (featureId === undefined || stream === undefined) return undefined;
  return { featureId, stream };
}

const POLICY_CAPABILITY_IDS = new Set<string>(Object.values(POLICY_CAPABILITY));

/**
 * Admission capabilities come from the trusted caller snapshot — the same
 * grant `snapshotCallerAuthorization` already computed, including the
 * local-operator baseline. Resolver `list()` is handshake / cache-hint
 * surface, not the ActionId need set; mixing the two denied every CLI
 * doctor/merge call whose resolver only advertised `anthropic_native_caching`.
 * Policy issuer tokens are not Capability-enum members, so a local operator
 * receives them here, and an MCP resolver may add them explicitly.
 */
function admissionCapabilityIds(
  snapshot: CallerAuthorizationSnapshot | undefined,
  resolver: DispatchContext['capabilityResolver'],
): readonly string[] {
  const held = new Set<string>();
  if (snapshot !== undefined) {
    for (const capability of snapshot.capabilities) held.add(capability);
    if (
      snapshot.identity.kind === 'local-operator' ||
      snapshot.posture === 'shared-mutating'
    ) {
      held.add(POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE);
      held.add(POLICY_CAPABILITY.ISSUE_APPROVAL);
      held.add(POLICY_CAPABILITY.GRANT_WAIVER);
    }
  }
  if (resolver !== undefined) {
    for (const capability of resolver.list()) {
      if (POLICY_CAPABILITY_IDS.has(capability)) held.add(capability);
    }
  }
  return [...held];
}

function admissionAuthorizationFromCaller(
  snapshot: CallerAuthorizationSnapshot | undefined,
  resolver: DispatchContext['capabilityResolver'],
): {
  readonly authorizationId: string;
  readonly posture: 'read-only' | 'task-isolated' | 'shared-mutating';
  readonly capabilityIds: readonly string[];
  readonly resolverVersion: string;
  readonly resolvedAt: string;
} {
  return {
    authorizationId: snapshot?.identity.subjectId ?? 'anonymous',
    posture: snapshot?.posture ?? 'read-only',
    capabilityIds: admissionCapabilityIds(snapshot, resolver),
    resolverVersion: snapshot?.resolver.version ?? 'none',
    resolvedAt: snapshot?.resolvedAt ?? '1970-01-01T00:00:00.000Z',
  };
}

function contractNeedsSatisfied(
  contract: ActionContract,
  capabilityIds: readonly string[],
): boolean {
  if (contract.needs.kind === 'none') return true;
  const held = new Set(capabilityIds);
  return contract.needs.values.every((capability) =>
    capabilityNeedSatisfied(held, capability),
  );
}

/**
 * Every declared requirement is an approval.
 *
 * A reasoned `none` is NOT "only approvals" — it is no requirement at all, and
 * answering true for it made an empty set satisfy a predicate about the set's
 * members. That vacuity is what routed `agent_spec` and `prepare_review` into
 * the obligation short-circuit and stopped their handlers from ever running.
 */
function requiresOnlyApprovals(requires: ActionContract['requires']): boolean {
  if (requires.kind === 'none') return false;
  return requires.values.every(
    (requirement: ActionRequirement) =>
      'kind' in requirement && requirement.kind === 'approvals',
  );
}

function observationStreamId(
  args: Record<string, unknown>,
  contract: ActionContract | undefined,
): string | undefined {
  const fromArgs = dispatchStreamId(args);
  if (fromArgs !== undefined) return fromArgs;
  const resources = contract?.touches.resources;
  if (resources === undefined || resources.kind !== 'declared') return undefined;
  for (const resource of resources.values) {
    if (resource.kind === 'stream' && INFRA_STREAM_IDS.has(resource.selector)) {
      return resource.selector;
    }
  }
  return undefined;
}

async function readTrustedHsmFacts(
  eventStore: EventStore,
  featureId: string,
): Promise<{ readonly phase: string; readonly phaseAttemptId?: string } | undefined> {
  try {
    const events = await eventStore.query(featureId);
    let view = workflowStateProjection.init();
    for (const event of events) {
      view = workflowStateProjection.apply(view, event);
    }
    if (typeof view.featureId !== 'string' || view.featureId.length === 0) {
      return undefined;
    }
    if (typeof view.phase !== 'string' || view.phase.length === 0) return undefined;
    const phaseAttemptId =
      typeof view.phaseAttemptId === 'string' && view.phaseAttemptId.length > 0
        ? view.phaseAttemptId
        : undefined;
    return phaseAttemptId === undefined
      ? { phase: view.phase }
      : { phase: view.phase, phaseAttemptId };
  } catch {
    return undefined;
  }
}

async function readTrustedAdmissionEvidence(
  eventStore: EventStore,
  streamId: string,
): Promise<readonly unknown[] | undefined> {
  try {
    const rows = await eventStore.query(streamId, {
      type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED,
    });
    const evidence: unknown[] = [];
    for (const row of rows) {
      const parsed = AdmissionEvidenceRecordedData.safeParse(row.data);
      if (!parsed.success) continue;
      evidence.push(parsed.data.evidence);
    }
    return evidence;
  } catch {
    return undefined;
  }
}

function readActionContract(action: object): ActionContract | undefined {
  if (!('actionContract' in action)) return undefined;
  try {
    return normalizeActionContract(Reflect.get(action, 'actionContract'));
  } catch {
    return undefined;
  }
}

function hostObligationOf(contract: ActionContract | undefined): string | undefined {
  const authority = contract?.executionAuthority;
  if (authority === undefined || authority.kind !== 'host') return undefined;
  return authority.obligation;
}

function admissionDeniedResult(
  tool: string,
  actionName: string,
  digestValue: string,
): ToolResult {
  return {
    success: false,
    error: {
      code: 'ADMISSION_DENIED',
      message: `Action "${actionName}" on tool "${tool}" is not admitted against the current trusted workflow subject.`,
      tool,
      action: actionName,
      expectedShape: { digest: { algorithm: 'sha256', value: digestValue } },
    },
  };
}

function trustedCallerRequiredResult(tool: string, actionName: string): ToolResult {
  return {
    success: false,
    error: {
      code: 'TRUSTED_CALLER_REQUIRED',
      message: `Action "${actionName}" requires trusted dispatch caller identity.`,
      tool,
      action: actionName,
    },
  };
}

function hostOwnedObligationResult(obligation: string): ToolResult {
  return {
    success: true,
    data: { obligation },
  };
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
 * Re-evaluate registry ActionId admission against store-trusted state before
 * the handler or any dispatch effect runs. The snapshot is the same
 * workflow-scoped subject used to advertise: ActionId, feature/stream,
 * persisted evidence, authorization, and HSM facts. Request payload (including
 * a transition target) and a fresh wall-clock are not snapshot members.
 *
 * Missing or invalid contracts deny. Capability failure denies. Declared
 * requires without a store-backed subject or HSM fold deny — they never
 * skip and they never invent a fake unscoped snapshot. Actions that
 * abstain from requires are admitted from needs alone. Host-owned
 * actions whose only requires are approvals return the obligation after
 * needs pass: the approval is the host's job, not a prior local fact.
 * Transition remains one ActionId; its request target is still decided
 * by the HSM transition guard after this gate.
 */
async function evaluateDispatchAdmission(input: {
  readonly tool: string;
  readonly actionName: string;
  readonly action: object;
  readonly args: Record<string, unknown>;
  readonly ctx: DispatchContext;
  readonly authorization: CallerAuthorizationSnapshot | undefined;
}): Promise<ToolResult | null> {
  const contract = readActionContract(input.action);
  const actionId = registryActionId(input.tool, input.actionName);
  if (contract === undefined) {
    return admissionDeniedResult(input.tool, input.actionName, 'missing-or-invalid-contract');
  }

  const authorization = admissionAuthorizationFromCaller(
    input.authorization,
    input.ctx.capabilityResolver,
  );
  if (!contractNeedsSatisfied(contract, authorization.capabilityIds)) {
    if (input.authorization === undefined) {
      return trustedCallerRequiredResult(input.tool, input.actionName);
    }
    return admissionDeniedResult(input.tool, input.actionName, 'missing-capabilities');
  }

  // A host obligation short-circuits only when the host must discharge it
  // BEFORE the handler could do anything — an approval, an interactive login,
  // a host-UI prompt. `agent-spawn` is discharged USING the handler's output,
  // so those actions run and return it.
  const obligation = hostObligationOf(contract);
  if (
    obligation !== undefined &&
    (isBlockingHostObligation(obligation) || requiresOnlyApprovals(contract.requires))
  ) {
    return hostOwnedObligationResult(obligation);
  }
  if (contract.requires.kind === 'none') return null;

  const subject = workflowSubjectFromArgs(input.args);
  const hsmFacts =
    subject === undefined
      ? undefined
      : await readTrustedHsmFacts(input.ctx.eventStore, subject.featureId);
  if (subject === undefined || hsmFacts === undefined) {
    return admissionDeniedResult(input.tool, input.actionName, 'missing-trusted-inputs');
  }

  const evidence = await readTrustedAdmissionEvidence(input.ctx.eventStore, subject.stream);
  if (evidence === undefined) {
    return admissionDeniedResult(input.tool, input.actionName, 'missing-trusted-inputs');
  }
  const decision = evaluateActionAdmission(
    actionId,
    {
      actionId,
      subject,
      evidence,
      authorization,
      hsmFacts,
    },
    contract,
  );
  if (decision.verdict !== 'allow') {
    return admissionDeniedResult(input.tool, input.actionName, decision.digest.value);
  }
  return obligation === undefined ? null : hostOwnedObligationResult(obligation);
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
    // The refusal already states the divergence in `error.message`; repeating
    // it as a warning on the same envelope tells the caller nothing twice.
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

    // ─── Inferred values ─────────────────────────────────────────────────
    //
    // Resolution priority for a parameter the caller omitted:
    //
    //     explicit > inferred (roots, then a cwd walk) > elicitation > INVALID_INPUT
    //
    // Elicitation is LAST because it costs a transport round-trip; inference is
    // round-trip-free and so takes precedence. It is also the only one of the
    // three that needs no gate here: it splices a field named by this action's
    // OWN parse error, so it can only ever supply something the action
    // declares.
    //
    // The table in `inferred-values.ts` owns which values may be inferred and
    // the single gate they share — most importantly that a value is merged only
    // into an action whose schema declares it. Dispatch keeps no per-field
    // logic, so a future inference cannot reopen #1838 by forgetting a check.
    const inference = await applyInferredValues(rest, matchingAction, tool, actionName, ctx);
    if (inference.kind === 'refused') {
      // Multi-match. A structured INVALID_INPUT so the caller can pick the
      // intended target. `attachMeta` is applied like every other early return
      // — this path used to be the one that diverged from the error contract.
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
    // The detector already existed (`computeStorePathDivergence`) but its only
    // consumer was the doctor check, so mutations landed in the
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

    const admission = await evaluateDispatchAdmission({
      tool,
      actionName,
      action: matchingAction,
      args,
      ctx,
      authorization,
    });
    if (admission !== null) return attachMeta(admission);

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
    // Both spellings of the same thing. A stream is named `featureId` on most
    // actions and `streamId` on those re-parented onto a stream they did not
    // open — `stack_place` is one, and it declares `stack.position-filled`
    // unconditionally. Reading only `featureId` resolved every such action to
    // `not-applicable`, so an action with an unconditional contract was exempt
    // from the check by the NAME of its parameter. The residue is declared, not
    // silent: an action carrying neither still resolves `no-stream`.
    streamId: observedStreamId,
    // Nested contract emissions are the only subject. Sibling autoEmits is leftover.
    declared: verifierDeclaredEmissions(dispatchedContract),
    handlerStubbed: STUBBED_COMPOSITES.has(tool),
    handlerSucceeded: result.success,
    readOnlyAbstention,
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

  // Advisory (or any non-blocking) miss: the store does not hold the
  // declared events. Ensure observation would fail for the same missing
  // facts. The mode already chose not to fail the dispatch; do not
  // re-fail it under a different code.
  if (emissionVerdict.status === 'violated') {
    return attachMeta(result);
  }

  // Host-owned actions never reach here: they returned the obligation before
  // the handler ran, and they do not owe execute-path ensures. Stubbed
  // composites are the same kind of non-execution as the emission verifier
  // already exempts. Read-only reasoned abstention has no append to observe.
  // A successful return after this point implies every applicable ensure was
  // observed from the store or the persisted-evidence reader.
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
      });
    } catch {
      // Report the ensures that APPLY to this outcome, not every declared one:
      // the failure path's message otherwise names postconditions the run was
      // never going to observe.
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

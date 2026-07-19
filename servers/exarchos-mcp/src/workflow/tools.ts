import type {
  InitInput,
  ListInput,
  GetInput,
  SetInput,
  CheckpointInput,
  WorkflowState,
} from './types.js';
import {
  CheckpointInputSchema,
  ErrorCode,
  InitInputSchema,
  isReservedField,
} from './schemas.js';
import {
  initStateFile,
  readStateFile,
  writeStateFile,
  applyDotPath,
  listStateFiles,
  reconcileFromEvents,
  hydrateEventsFromStore,
  StateStoreError,
  VersionConflictError,
} from './state-store.js';
import {
  buildCheckpointMeta,
  incrementOperations,
  resetCounter,
  isStale,
  shouldEnforceCheckpoint,
  type CheckpointEnforcementConfig,
} from './checkpoint.js';
import { workflowLogger } from '../logger.js';
import { getHSMDefinition, isBuiltInWorkflowType, getValidTransitions } from './state-machine.js';
import { hsmTransitionGuard } from './hsm-transition-guard.js';
import { getPlaybook, composePhasePlaybook } from './playbooks.js';
import { lintHandoff, type HandoffLintFinding } from './handoff-lint.js';
import { resolveGateSet } from './phase-kind.js';
import { type ToolResult } from '../format.js';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { EventStore } from '../event-store/store.js';
import type { ViewMaterializer } from '../views/materializer.js';
import { WORKFLOW_STATE_VIEW, type WorkflowStateView } from '../views/workflow-state-projection.js';
import * as path from 'node:path';
// T034 (DR-6) — checkpoint materializes the rehydration projection:
// fold events → snapshot → emit `workflow.checkpoint_written`. Reuses the
// helper extracted in T031 so the hydrate path is identical to the one the
// rehydrate handler exercises.
import { hydrateFromSnapshotThenTail } from './rehydrate.js';
import { rehydrationReducer } from '../projections/rehydration/reducer.js';
import {
  REHYDRATION_PROJECTION_ID,
  REHYDRATION_PROJECTION_VERSION,
} from '../projections/rehydration/identity.js';
import type { RehydrationDocument } from '../projections/rehydration/schema.js';
import { appendSnapshot } from '../projections/store.js';
import type { SnapshotRecord } from '../projections/snapshot-schema.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { buildValidatedEvent } from '../event-store/event-factory.js';
// #1555 — shared `asOf` bounded-fold seam (dispatch-core, INV-2). Bounds the
// event list to `events[0..N]` before the cache-bypassing fresh fold.
import { resolveAsOfEvents } from '../projections/cursor.js';

// ─── Module-Level EventStore (removed — now threaded via DispatchContext) ─────

// ─── Module-Level ViewMaterializer Configuration ─────────────────────────────

let moduleViewMaterializer: ViewMaterializer | null = null;

/** Configure the ViewMaterializer instance used by handleGet for ES v2 workflows. */
export function configureWorkflowMaterializer(materializer: ViewMaterializer | null): void {
  moduleViewMaterializer = materializer;
}

// Re-export from dedicated modules for backward compatibility
export { handleCancel } from './cancel.js';
export { handleSummary, handleReconcile, handleTransitions } from './query.js';

// ─── Internal Field Stripping ────────────────────────────────────────────────

const INTERNAL_FIELDS = ['_events', '_eventSequence', '_history'] as const;

function stripInternalFields(state: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...state };
  for (const field of INTERNAL_FIELDS) {
    delete stripped[field];
  }
  return stripped;
}

// ─── Event-Sourcing Version Discriminator ───────────────────────────────────

export const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
export function isEventSourced(state: Record<string, unknown>): boolean {
  return state._esVersion === CURRENT_ES_VERSION;
}

// ─── Workflow Risk Tier (review-gate path, R5) ──────────────────────────────

/**
 * Read a workflow-level risk tier off the (`.passthrough()`) workflow state,
 * for the tier-aware `/review` required-reviews contract (review-contract.ts).
 *
 * The risk tier is task-classification data produced by `prepare_delegation`.
 * It reaches the review-gate path only when a workflow-level tier is stamped on
 * state under `riskTier`; absent that stamp this returns `undefined` and the
 * contract falls back to the backward-compatible no-tier roster. Returns the
 * raw string and lets `getRequiredReviews` validate it (an unrecognised value
 * yields no tier-coupled dimensions), so a malformed stamp is inert rather than
 * throwing or injecting a spurious dimension.
 */
function resolveWorkflowRiskTier(state: Record<string, unknown>): string | undefined {
  const tier = state.riskTier;
  return typeof tier === 'string' ? tier : undefined;
}

// ─── handleInit ─────────────────────────────────────────────────────────────

/**
 * Initialize a new workflow state file.
 *
 * **Event-first contract:** When an event store is configured, the
 * `workflow.started` event is appended BEFORE the state file is created.
 * If the event append fails, no state file is written and an error is
 * returned. When no event store is configured, the state file is created
 * with `_eventSequence = 0` for graceful degradation.
 *
 * **Repo identity (DR-5):** an optional `repoKey` — supplied by the composite
 * layer (`deriveRepoKey(ctx.cwd ?? process.cwd())`) — is stamped onto the
 * `workflow.started` event data as `repoRoot`. Absent ⇒ the event carries no
 * `repoRoot`, exactly today's shape (direct handler calls stay unscoped by
 * construction). The parameter is threaded, never read from `process.cwd()`
 * here, so identity is adapter-independent.
 */
export async function handleInit(
  input: InitInput,
  stateDir: string,
  eventStore: EventStore | null,
  repoKey?: string,
): Promise<ToolResult> {
  try {
    // Marten R-1 (#1313): handler-boundary input validation. The MCP
    // registration declares `workflowType` as required, so requests
    // routed through the server are pre-validated. Direct callers
    // (internal helpers, future CLI invocations, test fixtures
    // bypassing the MCP surface) can still land here with a malformed
    // input — re-validate so they receive an explicit INVALID_INPUT
    // rather than a downstream STATE_CORRUPT / EVENT_APPEND_FAILED
    // whose error code suggests a different remediation path.
    const parsed = InitInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: ErrorCode.INVALID_INPUT,
          message: `Invalid init input: ${parsed.error.message}`,
        },
      };
    }

    // Guard: check if state file already exists BEFORE appending any event.
    // This prevents orphan events when handleInit is called twice with the
    // same featureId — without this check, the event would be appended and
    // then initStateFile would fail with STATE_ALREADY_EXISTS.
    const existingStateFile = path.join(stateDir, `${input.featureId}.state.json`);
    try {
      await fs.access(existingStateFile);
      // State already exists — return error without appending event
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_ALREADY_EXISTS,
          message: `State already exists for feature: ${input.featureId}`,
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // File doesn't exist — proceed with init
    }

    // Event-first: append workflow.started event BEFORE creating state file.
    // For oneshot workflows with an explicit `synthesisPolicy`, include it on
    // the event data so ES v2 rematerialization reconstructs the policy —
    // without this, rehydrating a state from events alone silently reverts
    // the workflow to the schema default (`on-request`), losing an
    // init-time decision that drives the choice-state guard at finalize.
    const isOneshotWithPolicy =
      input.workflowType === 'oneshot' && input.synthesisPolicy !== undefined;
    let eventSequence = 0;
    if (eventStore) {
      try {
        // #1325 — route through buildValidatedEvent for defense-in-depth
        // Zod validation at the emission boundary.
        const validatedEvent = buildValidatedEvent(input.featureId, 1, {
          type: 'workflow.started' as import('../event-store/schemas.js').EventType,
          correlationId: input.featureId,
          source: 'workflow',
          data: {
            featureId: input.featureId,
            workflowType: input.workflowType,
            ...(isOneshotWithPolicy ? { synthesisPolicy: input.synthesisPolicy } : {}),
            // DR-5: repo identity, present only when the composite supplied it.
            // Absent ⇒ exactly today's event shape (unscoped legacy behavior).
            ...(repoKey !== undefined ? { repoRoot: repoKey } : {}),
          },
        });
        const event = await eventStore.appendValidated(input.featureId, validatedEvent, {
          idempotencyKey: `${input.featureId}:workflow.started`,
        });
        eventSequence = event.sequence;
      } catch (err) {
        // Event-first: if event append fails, do NOT create state file
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      // Marten R-1 (#1313): register the stream's typed row immediately
      // after the workflow.started event lands. Ordering matters — if the
      // event append fails we already returned above; if registerStream
      // throws we still proceed to state-file creation since the registry
      // is an observability/filtering aid (v2.12 ps), not load-bearing for
      // the workflow.started → state.json sequence. INSERT OR IGNORE makes
      // this idempotent against handleInit retries.
      try {
        eventStore.registerStream(input.featureId, input.workflowType);
      } catch {
        // Swallow registry write errors. The streams table is a read-side
        // index for filtered queries; failing to register a stream produces
        // a missing row in v2.12's ps view, not a broken workflow.
      }
    }

    // Oneshot-only: thread `synthesisPolicy` into the initial state under
    // `state.oneshot`. For non-oneshot workflow types the field is silently
    // dropped — the `InitInputSchema` accepts it for uniformity but only the
    // oneshot state shape has a `.oneshot.synthesisPolicy` slot.
    const extraFields: Record<string, unknown> = {
      _eventSequence: eventSequence,
      _esVersion: CURRENT_ES_VERSION,
    };
    if (input.workflowType === 'oneshot' && input.synthesisPolicy !== undefined) {
      extraFields.oneshot = { synthesisPolicy: input.synthesisPolicy };
    }

    const { state } = await initStateFile(
      stateDir,
      input.featureId,
      input.workflowType,
      extraFields,
    );

    // v2.11 Phase 1: sidecar fallback (#1082) is gone — the event-store
    // either writes through the SQLite WAL or hard-throws on lock
    // contention. The `sidecarPending` envelope ack is no longer emitted.
    return {
      success: true,
      data: {
        featureId: state.featureId,
        workflowType: state.workflowType,
        phase: state.phase,
      },
      _meta: buildCheckpointMeta(state._checkpoint),
    };
  } catch (err) {
    if (err instanceof StateStoreError) {
      return {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
      };
    }
    throw err;
  }
}

// ─── handleList ─────────────────────────────────────────────────────────────

export async function handleList(
  _input: ListInput,
  stateDir: string,
): Promise<ToolResult> {
  const { valid: entries, corrupt } = await listStateFiles(stateDir);

  const data = entries.map((entry) => ({
    featureId: entry.featureId,
    workflowType: entry.state.workflowType,
    phase: entry.state.phase,
    stateFile: entry.stateFile,
    stale: isStale(entry.state._checkpoint),
    // Expose `_checkpoint` so downstream consumers (e.g. prune-stale-workflows
    // `extractListEntries`) can read `lastActivityTimestamp` directly. Before
    // this field was added the prune handler saw every non-terminal workflow
    // as maximally stale because the fallback was `new Date(0)`.
    _checkpoint: entry.state._checkpoint,
  }));

  return {
    success: true,
    data,
    ...(corrupt.length > 0 && {
      warnings: corrupt.map((c) => `Corrupt state file: ${c.featureId} — ${c.error}`),
    }),
  };
}

// ─── handleGet ──────────────────────────────────────────────────────────────

export async function handleGet(
  input: GetInput,
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  // #1504 — there is no scalar fast path off the `.state.json` file. The file
  // is a derived stamp that goes stale (and, once the write-path is removed,
  // absent), so a top-level scalar query (`query: 'phase'`) must fold the
  // authoritative event log exactly like a full read does — events win over a
  // stale on-disk scalar. All queries (scalar, dot-path, field-projection)
  // route through the shared resolution below, which materializes from events
  // for ES v2 workflows (`handleGetFromEvents`) and reads the file only on the
  // legacy / no-event-store degradation path (`handleGetFromStateFile`).

  // Read state file — needed for version check and as fallback for legacy path
  let state: WorkflowState;
  try {
    state = await readStateFile(stateFile);
  } catch (err) {
    if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_NOT_FOUND,
          message: `State not found for feature: ${input.featureId}`,
        },
      };
    }
    throw err;
  }

  // Version discriminator: ES v2 workflows materialize from events
  const useEventSource = isEventSourced(state as unknown as Record<string, unknown>)
    && eventStore !== null
    && moduleViewMaterializer !== null;

  if (useEventSource) {
    return handleGetFromEvents(input, state, eventStore!);
  }

  // Legacy path: read directly from state file
  return handleGetFromStateFile(input, state);
}

/**
 * ES v2 read path: materialize state from events via ViewMaterializer.
 */
async function handleGetFromEvents(
  input: GetInput,
  fileState: WorkflowState,
  eventStore: EventStore,
): Promise<ToolResult> {
  const allEvents = await eventStore.query(input.featureId);

  // #1555 — an `asOf` (bounded-fold) read folds `events[0..N]` through the
  // cache-bypassing fresh fold. This is load-bearing: `materialize` is
  // hwm-cache-based (it folds only events past the cached high-water mark and
  // writes the cache), so handing it a BOUNDED list would (a) return the
  // cached LIVE state when a warm cache already sits past N, and (b) pollute
  // the cache for later live reads. `materializeFresh` folds from
  // `projection.init()` over the bounded list and never reads/writes the LRU.
  // The live path keeps the cached `materialize`. Both bound through the
  // shared `resolveAsOfEvents` seam; the CLI/MCP adapters only pass `asOf`
  // through (INV-2).
  let materialized: WorkflowStateView;
  if (input.asOf !== undefined) {
    const bounded = resolveAsOfEvents(allEvents, input.asOf);
    materialized = moduleViewMaterializer!.materializeFresh<WorkflowStateView>(
      WORKFLOW_STATE_VIEW,
      bounded,
    );
  } else {
    materialized = moduleViewMaterializer!.materialize<WorkflowStateView>(
      input.featureId,
      WORKFLOW_STATE_VIEW,
      allEvents,
    );
  }

  const materializedRecord = materialized as unknown as Record<string, unknown>;
  // Checkpoint meta comes from state file (not materialized) since it's the
  // authoritative source for checkpoint tracking.
  const meta = buildCheckpointMeta(fileState._checkpoint);
  return projectState(input, materializedRecord, meta);
}

/**
 * Legacy read path: read directly from state file (v1 workflows or missing dependencies).
 */
function handleGetFromStateFile(
  input: GetInput,
  state: WorkflowState,
): ToolResult {
  const meta = buildCheckpointMeta(state._checkpoint);
  return projectState(input, state as unknown as Record<string, unknown>, meta);
}

/**
 * Shared projection logic: apply field projection, strip internals, or resolve dot-path query.
 */
function projectState(
  input: GetInput,
  stateObj: Record<string, unknown>,
  meta: ReturnType<typeof buildCheckpointMeta>,
): ToolResult {
  // Fields projection
  if (input.fields && !input.query) {
    const projected: Record<string, unknown> = {};
    for (const field of input.fields) {
      if (field.startsWith('_')) continue;
      // Special handling for 'playbook' virtual field
      if (field === 'playbook') {
        const wfType = typeof stateObj.workflowType === 'string' ? stateObj.workflowType : '';
        const phase = typeof stateObj.phase === 'string' ? stateObj.phase : '';
        const playbook = getPlaybook(wfType, phase);
        if (playbook !== null) {
          projected.playbook = playbook;
        }
        continue;
      }
      const value = resolveDotPath(stateObj, field);
      if (value !== undefined) {
        projected[field] = value;
      }
    }
    return { success: true, data: projected, _meta: meta };
  }

  // Full state (no query, no fields)
  if (!input.query) {
    const strippedState = stripInternalFields(stateObj);
    return {
      success: true,
      data: strippedState,
      _meta: meta,
    };
  }

  // Dot-path query
  const value = resolveDotPath(stateObj, input.query);
  return {
    success: true,
    data: value,
    _meta: meta,
  };
}

// ─── handleSet ──────────────────────────────────────────────────────────────

const MAX_CAS_RETRIES = 3;

/**
 * Update fields and/or transition phase on a workflow state file.
 *
 * **Event-first contract:** When an event store is configured and a phase
 * transition occurs, the `workflow.transition` event is appended BEFORE
 * the state file is written. If the event append fails, no state is
 * modified and an error is returned. That event is keyed
 * `${featureId}:${evt.type}:${evt.from}:${evt.to}:${expectedVersion}`
 * (built in `hsm-transition-guard.ts`, which appends the suffix this
 * function passes as `idempotencyKeySuffix`).
 *
 * **ES v2 field updates:** For workflows with `_esVersion === 2`, field
 * updates emit a `state.patched` event with the patch delta before
 * writing. After the CAS write succeeds, the state file is overwritten
 * with a snapshot re-materialized from the full event stream, ensuring
 * the file is always a derived artifact. That event is keyed
 * `${featureId}:patch:${expectedVersion}:${fieldsHash}`, which guarantees
 * only **one event per (featureId, base-version, field-name-set)** — the
 * key covers field NAMES, not values, so two different patches to the same
 * fields at the same base version collide and the second is silently
 * dropped. Because `expectedVersion` is server-derived it also does NOT
 * deduplicate CAS or lost-response retries (those duplicate instead). The
 * full contract and its hazards are documented inline at the append site;
 * #1643 tracks the derivation fix. Do not rely on these keys for
 * end-to-end request idempotency.
 *
 * **Legacy v1 path:** Field-only updates write directly without events.
 *
 * **HSM single-path (DR-4, #1259):** Phase transitions route through the
 * shared `hsmTransitionGuard.attempt` primitive in the same code path the
 * canonical `handleTransition` handler uses. There is no second
 * phase-write surface — both action handlers converge on this primitive
 * for guard evaluation and event emission. The deprecated `set({phase})`
 * surface additionally emits `hsm.deprecated_action_invoked` for migration
 * telemetry; that emission is bolted on at the composite-handler boundary
 * (DR-4 acceptance criteria; T38 GREEN).
 */
export async function handleSet(
  input: SetInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: {
    skipPhases?: readonly string[];
    requiredReviews?: readonly string[];
    checkpoint?: CheckpointEnforcementConfig;
    /**
     * DR-1: resolved `.exarchos.yml workflow.maxPlanRevisions` cap. Injected
     * into the reserved ephemeral `state._maxPlanRevisions` for the pure
     * `revisionsExhausted` guard, then stripped before persistence — never
     * event-sourced (INV-1: a config threshold is not a fact).
     */
    maxPlanRevisions?: number;
    /**
     * DR-3: resolved `.exarchos.yml review.mutationEnforcement` mode and the
     * resolved mutation threshold. Injected (HIGH tier only) into
     * `_mutationEnforcement` / `_mutationThreshold` for the pure `allReviewsPassed`
     * score check, then stripped before persistence — never event-sourced (INV-1).
     */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /**
     * DR-6: resolved NoCoverage budget for the pure `allReviewsPassed` guard's
     * SECOND, orthogonal axis. Injected (HIGH tier only) into `_maxNoCoverage`,
     * then stripped before persistence — never event-sourced (INV-1). Config
     * plumbing beside `_mutationThreshold`, not a facade fork: the pass-decision
     * lives in the guard, both facades reach it through this same injector.
     */
    maxNoCoverage?: number;
  },
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
    let state: WorkflowState;
    try {
      state = await readStateFile(stateFile);
    } catch (err) {
      if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
        return {
          success: false,
          error: {
            code: ErrorCode.STATE_NOT_FOUND,
            message: `State not found for feature: ${input.featureId}`,
          },
        };
      }
      throw err;
    }

    // ─── Checkpoint gate (DR-5): block phase transition when above threshold ──
    if (input.phase && options?.checkpoint) {
      const gateResult = shouldEnforceCheckpoint(
        state._checkpoint,
        options.checkpoint,
        'phase-transition',
      );

      // DR-10: emit checkpoint.state_missing event on graceful degradation.
      // Awaited so callers that query the stream immediately after this
      // handler returns observe the event (read-your-writes consistency).
      if (gateResult.warning === 'checkpoint-state-missing' && eventStore) {
        try {
          // #1325 — route through buildValidatedEvent for defense-in-depth
          // Zod validation. Emission is best-effort.
          const validatedEvent = buildValidatedEvent(input.featureId, 1, {
            type: 'checkpoint.state_missing' as import('../event-store/schemas.js').EventType,
            correlationId: input.featureId,
            source: 'workflow',
            data: { action: 'set' },
          });
          await eventStore.appendValidated(input.featureId, validatedEvent);
        } catch {
          // Best-effort event emission — don't block the set() response
        }
      }

      if (gateResult.gated) {
        // DR-5: emit checkpoint.enforced event before returning gate response
        if (eventStore) {
          try {
            // #1325 — route through buildValidatedEvent for defense-in-depth
            // Zod validation. Emission is best-effort.
            const validatedEvent = buildValidatedEvent(input.featureId, 1, {
              type: 'checkpoint.enforced' as import('../event-store/schemas.js').EventType,
              correlationId: input.featureId,
              source: 'workflow',
              data: {
                operationsSince: gateResult.operationsSince,
                threshold: gateResult.threshold,
                blockedAction: 'phase-transition',
              },
            });
            await eventStore.appendValidated(input.featureId, validatedEvent);
          } catch {
            // Best-effort event emission — don't block the gate response
          }
        }

        return {
          success: false,
          error: {
            code: 'CHECKPOINT_REQUIRED' as typeof ErrorCode[keyof typeof ErrorCode],
            message: `Checkpoint required before phase transition: ${gateResult.operationsSince} operations since last checkpoint (threshold: ${gateResult.threshold})`,
            ...(gateResult.gate !== undefined ? { gate: gateResult.gate } : {}),
            ...(gateResult.operationsSince !== undefined ? { operationsSince: gateResult.operationsSince } : {}),
            ...(gateResult.threshold !== undefined ? { threshold: gateResult.threshold } : {}),
          },
        };
      }
    }

    // Capture version for CAS
    const expectedVersion = state._version ?? 1;

    // Work with a deep copy to avoid shared reference mutation
    const mutableState = structuredClone(state) as Record<string, unknown>;

    // ─── Field updates (applied first so phase guards see new state) ───
    //
    // RESERVED_FIELD violations are detected by `applyDotPath`, which
    // throws a `StateStoreError` populated with structured `data`
    // (`{rejectedPath, rule, alternateWritePath}`). We catch it here so
    // the caller receives a structured error envelope rather than a
    // bare crash, and so the typed `data` block reaches the client.
    // Atomicity is preserved by `structuredClone`: `mutableState` is a
    // deep copy, so abandoning the loop mid-throw leaves the on-disk
    // state untouched (#1360).
    if (input.updates) {
      try {
        for (const [dotPath, value] of Object.entries(input.updates)) {
          applyDotPath(mutableState, dotPath, value);
        }
      } catch (err) {
        if (err instanceof StateStoreError && err.code === ErrorCode.RESERVED_FIELD) {
          return {
            success: false,
            error: {
              code: err.code,
              message: err.message,
              ...(err.data !== undefined ? { data: err.data } : {}),
            },
          };
        }
        throw err;
      }
    }

    // ─── Inject required reviews for guard evaluation ──────────────────
    // The allReviewsPassed guard reads _requiredReviews to enforce that
    // specific review dimensions exist (not just that present reviews pass).
    // Explicit config overrides workflow-type defaults.
    //
    // Presence check — NOT length — so an explicit empty array disables
    // required reviews for this transition. Treating `[]` as "not
    // provided" would silently fall back to defaults, contradicting the
    // caller's intent (CodeRabbit finding on PR #1076).
    //
    // Dimension names are owned by `review-contract.ts`, which is the
    // single source of truth shared with `playbooks.ts`. Do NOT hardcode
    // names here — changing the contract requires a one-line edit in
    // `review-contract.ts` so every consumer stays aligned (see #1073).
    if (input.phase) {
      if (options?.requiredReviews !== undefined) {
        // Explicit config (including explicit empty): use as-is
        mutableState._requiredReviews = options.requiredReviews;
      } else {
        const workflowType = state.workflowType as string;
        // ─── Tier-aware required reviews (R5 / verification ladder slice 3) ──
        // The high-tier `mutation-adequacy` adequacy backstop gates the
        // `/review` boundary for HIGH-risk workflows only (review-contract.ts
        // SoT — the dimension name is never literal here). The risk tier is
        // task-classification data from prepare_delegation; it reaches the
        // review-gate path only if a workflow-level tier is stamped on state.
        // Read it from the POST-update copy (`mutableState`), not the pre-update
        // `state`, so a tier set in THIS call's `updates` (e.g.
        // `{ phase:'review', updates:{ riskTier:'high' } }`) is honored — the
        // same "field updates applied first so phase guards see new state"
        // contract enforced above. We read defensively (the state schema is
        // `.passthrough()`), and fall back to the backward-compatible no-tier
        // roster when absent — exactly the pre-slice-3 behaviour.
        // `getRequiredReviews` ignores an unrecognised tier, so a malformed
        // stamp can never inject a dimension.
        // Coerce the (defensively-read, possibly-undefined/garbage) tier to a
        // literal RiskTier for the resolver ctx. Only `high` carries an extra
        // review dimension (mutation-adequacy); every other value → the base
        // roster, so collapsing non-high to `low` is byte-identical to the prior
        // `getRequiredReviews(workflowType, rawTier)` behavior (the ctx shim).
        const rawTier = resolveWorkflowRiskTier(mutableState);
        const riskTier =
          rawTier === 'high' ? 'high' : rawTier === 'medium' ? 'medium' : 'low';
        // DR-7: route the review roster through the single REVIEW gate-set
        // resolver — `resolveGateSet('REVIEW')`, the same resolver phase-entry
        // uses — instead of calling `getRequiredReviews` directly, so REVIEW
        // obligations have ONE source. The `'review-contract'` resolver wraps
        // `getRequiredReviews` verbatim (review-contract.ts SoT), so the resolved
        // dimension set is byte-identical (parity-pinned). `boundaryTouching` is
        // unused by the review resolver; an absent/unrecognised tier falls back to
        // the workflow-type base roster (the ctx shim — never throws).
        const typeDefaults = resolveGateSet('REVIEW', {
          riskTier,
          boundaryTouching: false,
          workflowType,
        }).flatMap((g) => (g.family === 'review' ? [g.gate] : []));
        if (typeDefaults.length) {
          mutableState._requiredReviews = typeDefaults;
        }
      }

      // ─── Inject plan-revision cap for guard evaluation (DR-1) ──────────
      // `revisionsExhausted` is a PURE guard and cannot read config, so the
      // resolved `.exarchos.yml workflow.maxPlanRevisions` cap is injected here
      // (as `_requiredReviews` is above) into a reserved ephemeral field the
      // guard reads. It is stripped before persistence below — the cap is a
      // config threshold, not a fact, so it never enters the event log (INV-1).
      // The sibling `workflow.maxFixCycles` is likewise a runtime-injected
      // override, never event-sourced. Absent injection the guard falls back to
      // its default (1) — the conservative, loop-terminating value.
      if (
        typeof options?.maxPlanRevisions === 'number' &&
        Number.isFinite(options.maxPlanRevisions)
      ) {
        mutableState._maxPlanRevisions = options.maxPlanRevisions;
      }

      // ─── Inject mutation score-enforcement mode + threshold (DR-3) ──────
      // `allReviewsPassed` is a PURE guard and cannot read config, so the
      // resolved `review.mutationEnforcement` mode + threshold are injected here
      // (as `_requiredReviews` / `_maxPlanRevisions` are). HIGH tier only —
      // low/medium never run mutation-adequacy, so the guard's score check stays
      // inert there. Advisory by default: with mode !== 'block' nothing is
      // injected, so the guard never enforces. Stripped before persistence below.
      if (resolveWorkflowRiskTier(mutableState) === 'high') {
        if (options?.mutationEnforcement !== undefined) {
          mutableState._mutationEnforcement = options.mutationEnforcement;
        }
        if (
          typeof options?.mutationThreshold === 'number' &&
          Number.isFinite(options.mutationThreshold)
        ) {
          mutableState._mutationThreshold = options.mutationThreshold;
        }
        // DR-6: the resolved NoCoverage budget for `allReviewsPassed` Check 4b's
        // orthogonal axis, injected exactly as the threshold above. Config
        // plumbing, not a facade fork — the pass-decision lives in the pure guard.
        // Only plumb a well-formed budget (non-negative integer) — a negative
        // or fractional value is rejected here rather than injected, matching
        // `resolveMaxNoCoverage` and the guard's NoCoverage-count check (INV-2).
        if (
          typeof options?.maxNoCoverage === 'number' &&
          Number.isInteger(options.maxNoCoverage) &&
          options.maxNoCoverage >= 0
        ) {
          mutableState._maxNoCoverage = options.maxNoCoverage;
        }
      }
    }

    // ─── Hydrate _events from event store for guard evaluation ──────────
    // Guards read state._events for transition prerequisites (e.g.,
    // teamDisbandedEmitted). Hydrate from the JSONL event store so all
    // event types — including team.spawned, team.disbanded, task.completed
    // — are visible to guards with full data spread.
    if (input.phase && eventStore) {
      try {
        mutableState._events = await hydrateEventsFromStore(
          input.featureId, eventStore,
        );
      } catch {
        // Best-effort: proceed with existing _events on query failure
        mutableState._events = mutableState._events ?? [];
      }
    } else if (input.phase && !eventStore) {
      workflowLogger.warn(
        { featureId: input.featureId },
        'eventStore unavailable during phase transition — _events will not be hydrated, guards may fail',
      );
    }

    // ─── Phase transition — routed through HSMTransitionGuard ──────────
    // The dispatch contract for guarded phase transitions is owned by the
    // `HSMTransitionGuard` primitive (see `hsm-transition-guard.ts` /
    // Primitive 3 in `docs/designs/archive/2026-05-06-v29-bug-cluster-combined-fix.md`).
    // It evaluates the composite guard, emits exactly one of
    // `workflow.transition` or `workflow.guard-failed` per attempt, and
    // returns a structured result. `handleSet` is now responsible only
    // for state mutation on success and CAS persistence — guard evaluation
    // and event emission live behind the primitive's interface.
    //
    // `pendingTransitionEventsCount` and `transitionTopSequence` are kept
    // so the post-transition path can update `_eventSequence` without
    // re-querying the event store.
    let pendingTransitionEventsCount = 0;
    let transitionTopSequence: number | undefined;

    if (input.phase) {
      const fromPhase = state.phase;
      let attemptResult;
      try {
        attemptResult = await hsmTransitionGuard.attempt(
          input.featureId,
          fromPhase,
          input.phase,
          {
            state: mutableState,
            workflowType: state.workflowType as string,
            skipPhases: options?.skipPhases,
            idempotencyKeySuffix: String(expectedVersion),
            eventStore,
          },
        );
      } catch (err) {
        // Event-first contract: a thrown error from the primitive
        // means an event-store append failed (the only synchronous
        // failure mode on the success path). Surface it as
        // EVENT_APPEND_FAILED and abort the CAS write — state must
        // not advance past the unwritten event boundary.
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }

      if (!attemptResult.ok) {
        if (attemptResult.reason === 'no-transition-defined') {
          return {
            success: false,
            error: {
              code: ErrorCode.INVALID_TRANSITION,
              message: attemptResult.errorMessage,
              ...(attemptResult.validTargets.length
                ? { validTargets: attemptResult.validTargets }
                : {}),
            },
          };
        }
        // reason === 'guard-failed' (CIRCUIT_OPEN / PHASE_BLOCKED preserved
        // as distinct codes rather than collapsed to GUARD_FAILED).
        const guardFailure = attemptResult.failures[0];
        const errorPayload: Record<string, unknown> = {
          code:
            attemptResult.errorCode === 'CIRCUIT_OPEN'
              ? ErrorCode.CIRCUIT_OPEN
              : attemptResult.errorCode === 'PHASE_BLOCKED'
                ? ErrorCode.PHASE_BLOCKED
                : ErrorCode.GUARD_FAILED,
          message: attemptResult.errorMessage,
        };
        if (guardFailure?.expectedShape) {
          errorPayload.expectedShape = guardFailure.expectedShape;
        }
        if (guardFailure?.suggestedFix) {
          errorPayload.suggestedFix = guardFailure.suggestedFix;
        }
        return {
          success: false,
          error: errorPayload as NonNullable<ToolResult['error']>,
        };
      }

      // ok: true — apply state mutation. Idempotent attempts are no-ops.
      //
      // INV-5b (T73 / CR #13): a no-op self-transition must be a no-op
      // end-to-end — no state mutation, no event emission, no version
      // bump, no `updatedAt` rewrite, no checkpoint counter increment.
      // The HSM guard already short-circuits event emission upstream
      // (see DefaultHSMTransitionGuard.attempt's idempotency branch);
      // without this early-return `handleSet` would fall through to the
      // checkpoint counter increment + `updatedAt` write + CAS persistence
      // below, mutating `_version`, `updatedAt`, `_checkpoint.operations`,
      // and `_checkpoint.lastActivityTimestamp` despite the guard's
      // promise that nothing happened. Returning here also surfaces an
      // explicit `idempotent: true` discriminator on the response so
      // callers can distinguish a real transition from a no-op
      // acknowledgement without inspecting events. Gated on `!input.updates`
      // so a hypothetical caller passing `{ phase, updates }` together
      // still gets the field-only path; today's callers (handleTransition
      // → applyTransition) never combine the two.
      if (attemptResult.idempotent && !input.updates) {
        return {
          success: true,
          data: {
            phase: state.phase,
            updatedAt: state.updatedAt,
            idempotent: true,
          },
          _meta: buildCheckpointMeta(state._checkpoint),
        };
      }

      if (!attemptResult.idempotent) {
        mutableState.phase = attemptResult.newPhase;

        if (Object.keys(attemptResult.historyUpdates).length > 0) {
          const history = {
            ...(mutableState._history as Record<string, string>),
          };
          for (const [key, value] of Object.entries(
            attemptResult.historyUpdates,
          )) {
            history[key] = value;
          }
          mutableState._history = history;
        }

        // Reset checkpoint counter on phase transition.
        mutableState._checkpoint = resetCounter(
          mutableState._checkpoint as WorkflowState['_checkpoint'],
          attemptResult.newPhase,
        );

        pendingTransitionEventsCount = attemptResult.emittedEvents.length;
        if (attemptResult.transitionEvent.sequence > 0) {
          transitionTopSequence = attemptResult.transitionEvent.sequence;
        }
      }

      // Clean up transient guard-evaluation fields — not persisted to state
      // (INV-1: the injected config cap is not a fact and must not be folded).
      delete mutableState._requiredReviews;
      delete mutableState._maxPlanRevisions;
      delete mutableState._mutationEnforcement;
      delete mutableState._mutationThreshold;
      delete mutableState._maxNoCoverage;
    }

    // Transition events are now emitted inside `hsmTransitionGuard.attempt`
    // — see Primitive 3 in `docs/designs/archive/2026-05-06-v29-bug-cluster-combined-fix.md`.
    //
    // ─── Idempotency contract for the `state.patched` append below ───
    //
    // The real guarantee is narrow: **at most one `state.patched` event per
    // (featureId, base-version, field-name-set)**. That is the whole of it.
    //
    // Why: the key at the append site is
    //   `${featureId}:patch:${expectedVersion}:${fieldsHash}`
    // and `fieldsHash` is `[...updateKeys].sort().join(',')` over
    // `Object.keys(input.updates)` — sorted field *NAMES* only. Values never
    // enter the key. (`fieldsHash` is also a plain join, NOT a hash; the name
    // is misleading — do not read it as a digest of the patch.)
    //
    // Two consequences, and they cut in opposite directions:
    //
    // 1. COLLISION (lost write). `{status:'a'}` and `{status:'b'}` applied at
    //    the same base version derive the IDENTICAL key. The second append is
    //    silently deduplicated by the event store — the write is dropped, with
    //    no error surfaced to the caller. Distinct patches are conflated
    //    because only the key set is keyed on.
    //
    // 2. NO DEDUP ACROSS RETRIES. `expectedVersion` is server-derived
    //    (`state._version ?? 1`, re-read from disk on every pass of this
    //    loop). So it is not stable across exactly the retries a dedup key
    //    exists to cover:
    //      - CAS retry: a `VersionConflictError` means a concurrent writer
    //        advanced `_version`, so the next pass reads a NEW version and
    //        derives a DIFFERENT key. The prior pass's event is already in the
    //        store (event-first), so the retry ADDS a second event rather than
    //        collapsing onto the first.
    //      - Lost-response retry: a client that re-sends after a dropped
    //        response has its `expectedVersion` re-derived from the server's
    //        own already-advanced version — again a different key, again a
    //        duplicate.
    //
    // Net: this key drops writes it should keep (1) and duplicates writes it
    // should collapse (2). Fixing the derivation is tracked in #1643 — do not
    // infer a stronger contract than the one stated above until it lands.
    //
    // SCOPE: everything above describes ONLY the `state.patched` append in
    // this function. It does NOT cover the transition path at the
    // `hsmTransitionGuard.attempt` call above, which passes
    // `idempotencyKeySuffix: String(expectedVersion)` and keys a DIFFERENT
    // event type (`workflow.transition` and its compound/fix-cycle siblings)
    // via a different derivation built inside the guard
    // (`${featureId}:${evt.type}:${evt.from}:${evt.to}:${suffix}`, see
    // `hsm-transition-guard.ts`). Do not assume this analysis transfers to it.
    let highestEventSequence: number | undefined = transitionTopSequence;

    // ─── Event-first: append state.patched event for v2 field updates ──
    const updateKeys = input.updates ? Object.keys(input.updates) : [];
    if (
      isEventSourced(state as unknown as Record<string, unknown>)
      && eventStore
      && updateKeys.length > 0
    ) {
      try {
        const fieldsHash = [...updateKeys].sort().join(',');
        const idempotencyKey = `${input.featureId}:patch:${expectedVersion}:${fieldsHash}`;
        // #1325 — route through buildValidatedEvent for defense-in-depth
        // Zod validation at the emission boundary.
        const validatedEvent = buildValidatedEvent(input.featureId, 1, {
          type: 'state.patched' as import('../event-store/schemas.js').EventType,
          correlationId: input.featureId,
          source: 'workflow',
          data: {
            featureId: input.featureId,
            fields: updateKeys,
            patch: input.updates,
          },
        });
        const event = await eventStore.appendValidated(input.featureId, validatedEvent, { idempotencyKey });

        highestEventSequence = Math.max(highestEventSequence ?? 0, event.sequence);
      } catch (err) {
        // Event-first: if event append fails, do NOT update state
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }

    // Update _eventSequence when any events were appended
    if (highestEventSequence !== undefined) {
      mutableState._eventSequence = highestEventSequence;
    }

    // Increment checkpoint operation counter
    mutableState._checkpoint = incrementOperations(
      mutableState._checkpoint as WorkflowState['_checkpoint'],
    );

    // Update timestamp
    mutableState.updatedAt = new Date().toISOString();

    // Update lastActivityTimestamp on checkpoint
    const checkpoint = mutableState._checkpoint as Record<string, unknown>;
    checkpoint.lastActivityTimestamp = new Date().toISOString();

    // Write back to disk with CAS protection + schema validation
    try {
      await writeStateFile(stateFile, mutableState as WorkflowState, { expectedVersion });
      // writeStateFile increments _version on disk; sync mutableState to match
      (mutableState as Record<string, unknown>)._version = expectedVersion + 1;
    } catch (err) {
      // Validation failure — return structured error instead of corrupting state
      if (err instanceof StateStoreError && err.code === ErrorCode.INVALID_INPUT) {
        return {
          success: false,
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: err.message,
          },
        };
      }
      if (err instanceof VersionConflictError && attempt < MAX_CAS_RETRIES) {
        // Re-read and retry on version conflict.
        //
        // NOTE: the next iteration's append is NOT deduplicated against this
        // failed pass's event. A `VersionConflictError` means a concurrent
        // writer advanced `_version`, so the re-read derives a new
        // `expectedVersion` and therefore a new idempotency key — while this
        // pass's event is already committed (event-first). The retry appends
        // an ADDITIONAL event. See the idempotency contract above the
        // `state.patched` append for the full derivation; #1643 tracks the
        // fix.
        continue;
      }

      // CAS exhaustion: emit diagnostic event before throwing
      if (err instanceof VersionConflictError && eventStore) {
        try {
          // #1325 — route through buildValidatedEvent for defense-in-depth
          // Zod validation. Add correlationId / source consistent with
          // the canonical pattern used by every other emission in this
          // handler. Emission is best-effort.
          const validatedEvent = buildValidatedEvent(input.featureId, 1, {
            type: 'workflow.cas-failed' as import('../event-store/schemas.js').EventType,
            correlationId: input.featureId,
            source: 'workflow',
            data: {
              featureId: input.featureId,
              phase: input.phase ?? (mutableState.phase as string) ?? 'unknown',
              retries: MAX_CAS_RETRIES,
            },
          });
          await eventStore.appendValidated(input.featureId, validatedEvent);
        } catch {
          // Best-effort diagnostic emission — don't mask the actual CAS error
        }
      }

      throw err;
    }

    // ─── Re-materialize state from events for v2 workflows ──────────
    // After the CAS write succeeds, overwrite the state file with a
    // snapshot derived from the full event stream. This ensures the
    // state file is always a derived artifact of the event log.
    if (
      isEventSourced(state as unknown as Record<string, unknown>)
      && eventStore
      && moduleViewMaterializer
    ) {
      const allEvents = await eventStore.query(input.featureId);
      const materialized = moduleViewMaterializer.materialize<WorkflowStateView>(
        input.featureId,
        WORKFLOW_STATE_VIEW,
        allEvents,
      );

      // Merge materialized state with checkpoint/version metadata from the
      // mutable state (checkpoint tracking is not event-sourced)
      const latestSequence = allEvents.length
        ? allEvents[allEvents.length - 1]?.sequence
        : mutableState._eventSequence;
      const snapshot = {
        ...(materialized as unknown as Record<string, unknown>),
        _version: (mutableState._version as number),
        _eventSequence: latestSequence,
        _esVersion: CURRENT_ES_VERSION,
        _checkpoint: mutableState._checkpoint,
        updatedAt: mutableState.updatedAt,
      };

      try {
        await writeStateFile(
          stateFile,
          snapshot as unknown as WorkflowState,
          { expectedVersion: mutableState._version as number, skipValidation: true },
        );
      } catch (err) {
        if (err instanceof VersionConflictError) {
          // Another writer updated the state after our CAS write; skip rematerialization
        } else {
          throw err;
        }
      }
    }

    // Event-first: events already appended before CAS write with idempotency keys.
    // State write is the follow-up materialization step.
    //
    // v2.11 Phase 1: sidecar fallback (#1082) removed; no `sidecarPending`
    // envelope marker needed.
    //
    // Surface `workflowType` so `nextActionsFromResult` (called by
    // `envelopeWrap` in composite.ts) can compute HATEOAS links — the
    // helper requires both `phase` AND `workflowType` to look up the HSM.
    // Without it, every successful `transition` would ship an empty
    // `next_actions` array. Field is purely additive.
    return {
      success: true,
      data: {
        phase: mutableState.phase as string,
        workflowType: mutableState.workflowType as string,
        updatedAt: mutableState.updatedAt as string,
      },
      _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
    };
  }

  // Should not be reached, but satisfy TypeScript
  throw new StateStoreError(
    ErrorCode.VERSION_CONFLICT,
    `Concurrent write conflict: failed to acquire consistent version after ${MAX_CAS_RETRIES} retries for feature: ${input.featureId}, phase: ${input.phase ?? 'field-update'}`,
  );
}

// ─── handleUpdate ───────────────────────────────────────────────────────────
//
// Wave 0 (#1340, v2.10.0-preview.2): canonical state-mutation surface for
// non-phase fields. Delegates to `handleSet` with `updates` only after
// rejecting any caller that tries to smuggle a `phase` field through the
// `updates` payload. Phase mutation lives on the `transition` action and
// its HSM-guarded code path — accepting `phase` here would silently
// bypass guard evaluation, valid-target enumeration, and the
// `workflow.transition` event emission.
//
// The guard is a structured `INVALID_INPUT` + `suggestedFix` envelope
// (INV-5a — agent input ergonomics). Agents auto-correct off the
// suggestedFix shape without parsing the message string, so the guard
// stays robust under future error-message rewording.

export interface UpdateInput {
  readonly featureId: string;
  readonly updates: Record<string, unknown>;
}

/**
 * Canonical non-phase state-mutation handler. Validates that `updates`
 * does not contain a `phase` field (which would route around the HSM
 * transition guard), then delegates to `handleSet({featureId, updates})`
 * so the same event-first / CAS / per-stream-lock machinery serves both
 * the legacy `set({updates})` entry point (now removed) and the
 * canonical `update` action.
 *
 * On `phase`-in-updates: returns `{success: false, error: {code:
 * 'INVALID_INPUT', suggestedFix: {tool: 'exarchos_workflow', params:
 * {action: 'transition', ...}}}}` so callers can self-correct in one
 * tool call.
 */
export async function handleUpdate(
  input: UpdateInput,
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  if (Object.prototype.hasOwnProperty.call(input.updates, 'phase')) {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message:
          "Cannot mutate 'phase' through update — phase changes go through the HSM-guarded transition action so guard evaluation, valid-target enumeration, and the workflow.transition event emission cannot be bypassed.",
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: {
            action: 'transition',
            featureId: input.featureId,
            // Surface the offending value so callers can re-issue the
            // intended phase change with one search-and-replace; the
            // narrowed payload is a parameter shape, not a recommendation.
            target: input.updates.phase,
          },
        },
      },
    };
  }

  return handleSet(
    { featureId: input.featureId, updates: input.updates },
    stateDir,
    eventStore,
  );
}

// ─── handleTransition ───────────────────────────────────────────────────────
//
// T36/T37/DR-4: `workflow.transition({target})` is the canonical phase-mutation
// action after the HSM API single-path consolidation. The deprecated
// `workflow.set({phase})` action delegates here through the shared
// `applyTransition()` helper so both handlers emit byte-equivalent
// `workflow.transition` events from the same code path — eliminating the
// "second phase-write surface" the v2.9 substrate carried.
//
// T42/DR-5: guard-failure responses are shaped through `buildGuardFailureError()`
// so the structured envelope (`validTargets`, `expectedShape`, `suggestedFix`)
// is identical regardless of whether the failure surfaced via the canonical
// or deprecated entry point.

export interface TransitionInput {
  readonly featureId: string;
  readonly target: string;
}

/**
 * Canonical phase-transition handler. Routes through the shared
 * `applyTransition()` helper which is also consumed by `handleSet({phase})`.
 *
 * Returns the same `ToolResult` shape as `handleSet({phase})`'s success
 * branch; on failure, returns the structured guard-failure envelope
 * (DR-5) populated via `buildGuardFailureError()`.
 */
export async function handleTransition(
  input: TransitionInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: {
    skipPhases?: readonly string[];
    requiredReviews?: readonly string[];
    checkpoint?: CheckpointEnforcementConfig;
    /**
     * DR-1: resolved `.exarchos.yml workflow.maxPlanRevisions` cap. Injected
     * into the reserved ephemeral `state._maxPlanRevisions` for the pure
     * `revisionsExhausted` guard, then stripped before persistence — never
     * event-sourced (INV-1: a config threshold is not a fact).
     */
    maxPlanRevisions?: number;
    /**
     * DR-3: resolved `.exarchos.yml review.mutationEnforcement` mode and the
     * resolved mutation threshold. Injected (HIGH tier only) into
     * `_mutationEnforcement` / `_mutationThreshold` for the pure `allReviewsPassed`
     * score check, then stripped before persistence — never event-sourced (INV-1).
     */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /**
     * DR-6: resolved NoCoverage budget for the pure `allReviewsPassed` guard's
     * SECOND, orthogonal axis. Injected (HIGH tier only) into `_maxNoCoverage`,
     * then stripped before persistence — never event-sourced (INV-1). Config
     * plumbing beside `_mutationThreshold`, not a facade fork: the pass-decision
     * lives in the guard, both facades reach it through this same injector.
     */
    maxNoCoverage?: number;
  },
): Promise<ToolResult> {
  return applyTransition(
    { featureId: input.featureId, target: input.target },
    stateDir,
    eventStore,
    options,
  );
}

/**
 * Shared private helper consumed by both `handleTransition` (canonical)
 * and `handleSet({phase})` (deprecated). The body delegates to `handleSet`
 * with `phase = target` so the existing CAS / HSM-guard wiring stays in a
 * single code path; on guard-failure outcomes the response is enriched
 * with the structured DR-5 envelope.
 *
 * Keeping this as a thin pass-through (rather than re-implementing the
 * CAS loop) honors INV-2 facade equivalence — the substrate-level guard
 * primitive is the canonical core, and both action surfaces route through
 * it. The DR-5 enrichment lives here so it cannot be bypassed by callers
 * that reach for `handleSet` directly.
 */
async function applyTransition(
  input: { featureId: string; target: string },
  stateDir: string,
  eventStore: EventStore | null,
  options?: {
    skipPhases?: readonly string[];
    requiredReviews?: readonly string[];
    checkpoint?: CheckpointEnforcementConfig;
    /**
     * DR-1: resolved `.exarchos.yml workflow.maxPlanRevisions` cap. Injected
     * into the reserved ephemeral `state._maxPlanRevisions` for the pure
     * `revisionsExhausted` guard, then stripped before persistence — never
     * event-sourced (INV-1: a config threshold is not a fact).
     */
    maxPlanRevisions?: number;
    /**
     * DR-3: resolved `.exarchos.yml review.mutationEnforcement` mode and the
     * resolved mutation threshold. Injected (HIGH tier only) into
     * `_mutationEnforcement` / `_mutationThreshold` for the pure `allReviewsPassed`
     * score check, then stripped before persistence — never event-sourced (INV-1).
     */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /**
     * DR-6: resolved NoCoverage budget for the pure `allReviewsPassed` guard's
     * SECOND, orthogonal axis. Injected (HIGH tier only) into `_maxNoCoverage`,
     * then stripped before persistence — never event-sourced (INV-1). Config
     * plumbing beside `_mutationThreshold`, not a facade fork: the pass-decision
     * lives in the guard, both facades reach it through this same injector.
     */
    maxNoCoverage?: number;
  },
): Promise<ToolResult> {
  const result = await handleSet(
    { featureId: input.featureId, phase: input.target },
    stateDir,
    eventStore,
    options,
  );

  // Enrich guard-failure responses with the structured DR-5 envelope.
  if (!result.success && result.error) {
    return enrichGuardFailureError(result, input.featureId, input.target, stateDir);
  }
  return result;
}

/**
 * Augment a guard-failure ToolResult with the DR-5 structured envelope:
 * `validTargets[]` enumerated from the HSM topology, `expectedShape`
 * describing the action's `target` field, and a `suggestedFix` referencing
 * the closest valid transition (Levenshtein-nearest among the declared
 * targets). The closest-target heuristic gives operators a one-step
 * correction path; falls back to the first valid target when the input
 * is empty or no targets exist.
 */
async function enrichGuardFailureError(
  result: ToolResult,
  featureId: string,
  target: string,
  stateDir: string,
): Promise<ToolResult> {
  if (result.success || !result.error) return result;
  const code = result.error.code;
  if (
    code !== ErrorCode.GUARD_FAILED &&
    code !== ErrorCode.INVALID_TRANSITION &&
    code !== ErrorCode.CIRCUIT_OPEN &&
    code !== ErrorCode.PHASE_BLOCKED
  ) {
    // Non-guard failures (STATE_NOT_FOUND, EVENT_APPEND_FAILED, etc.)
    // pass through unchanged. PHASE_BLOCKED is a transition-boundary fault, so
    // it gets the same validTargets enrichment as the other guard failures.
    return result;
  }

  // Read the current phase from the state file so `validTargets` is computed
  // against the actual `from` phase. Best-effort: a missing state file is
  // already a separate error path (STATE_NOT_FOUND) and would have been
  // caught upstream.
  let currentPhase = 'unknown';
  let workflowType = 'feature';
  try {
    const stateFile = path.join(stateDir, `${featureId}.state.json`);
    const state = await readStateFile(stateFile);
    currentPhase = state.phase;
    workflowType = state.workflowType as string;
  } catch {
    // Fall through with defaults; the structured envelope still carries
    // the (possibly empty) validTargets list and a generic suggestedFix.
  }

  return buildGuardFailureError(result, featureId, target, currentPhase, workflowType);
}

/**
 * Build the DR-5 structured guard-failure envelope. Pure function: given a
 * failed ToolResult and the topology-relative context, return a result with
 * `validTargets[]`, `expectedShape`, and `suggestedFix` populated. Existing
 * `validTargets` (from HSMTransitionGuard) is preserved when present; the
 * `suggestedFix` heuristic prefers the Levenshtein-closest valid target.
 *
 * Identical envelope shape across CLI and MCP carriers (T42 / DR-5): the
 * `parity-harness.TRANSITION_GUARD_FAILURE_FIXTURE` test asserts byte
 * equivalence so any drift in the failure-path serialization is caught at
 * compile-time review rather than at runtime in client code.
 */
function buildGuardFailureError(
  result: ToolResult,
  featureId: string,
  target: string,
  currentPhase: string,
  workflowType: string,
): ToolResult {
  if (result.success || !result.error) return result;

  let validTargetPhases: string[] = [];
  try {
    const hsm = getHSMDefinition(workflowType);
    const targets = getValidTransitions(hsm, currentPhase);
    validTargetPhases = targets.map((t) => t.phase);
  } catch {
    validTargetPhases = [];
  }

  // Prefer the validTargets the guard primitive already surfaced; otherwise
  // fall back to the topology query above.
  const existingValidTargets = result.error.validTargets;
  const validTargets = existingValidTargets && existingValidTargets.length > 0
    ? existingValidTargets
    : validTargetPhases;

  // Closest-by-Levenshtein heuristic. With an empty target string, the
  // first valid target "wins" (string-distance from empty is the length
  // of the candidate, so any non-empty list returns the shortest).
  const candidatePhases = validTargets.map((t) =>
    typeof t === 'string' ? t : t.phase,
  );
  const closest = candidatePhases.length > 0
    ? candidatePhases.reduce((best, candidate) =>
        levenshtein(candidate, target) < levenshtein(best, target)
          ? candidate
          : best,
      )
    : undefined;

  const suggestedFix = closest
    ? {
        tool: 'exarchos_workflow',
        params: {
          action: 'transition',
          featureId,
          target: closest,
        },
      }
    : undefined;

  // DR-5 surfaces a target-shape `expectedShape` describing the action's
  // input (`target`), not the guarded-state shape the HSM primitive may
  // already have populated. Both are valuable: the state-shape tells the
  // caller what's missing, the input-shape tells them how to reformulate
  // the call. Keep the inner state-shape (when present) under
  // `requiredState` so neither signal is lost.
  const targetExpectedShape: Record<string, unknown> = {
    target: candidatePhases.length > 0
      ? candidatePhases.join(' | ')
      : '<valid HSM phase>',
  };
  if (result.error.expectedShape && Object.keys(result.error.expectedShape).length > 0) {
    targetExpectedShape.requiredState = result.error.expectedShape;
  }

  return {
    ...result,
    error: {
      ...result.error,
      validTargets,
      expectedShape: targetExpectedShape,
      ...(suggestedFix ? { suggestedFix } : {}),
    },
  };
}

/** Levenshtein edit distance — shared closest-valid-target heuristic. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

// ─── handleCheckpoint ──────────────────────────────────────────────────────

/**
 * Optional knobs threaded into `handleCheckpoint` that are not part of
 * the dispatch input itself. Today only `handoffLint` is wired (#1244);
 * future per-call overrides for things like staleness or counter reset
 * policy can join the same struct without re-shaping the signature.
 *
 * The production wiring source-of-truth is `.exarchos.yml`'s
 * `handoffLint.hardFail` flag (DR-1244). Tests pass this directly so
 * the hard-fail path can be exercised without yaml-fixture plumbing.
 */
export interface HandleCheckpointOptions {
  readonly handoffLint?: {
    readonly hardFail?: boolean;
  };
}

export async function handleCheckpoint(
  input: CheckpointInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: HandleCheckpointOptions,
): Promise<ToolResult> {
  // T4 (#1240) — validate the dispatch payload at the handler boundary
  // before any state-file I/O or event emission. The MCP tool registration
  // (`server.tool` below) only declares `featureId` and `summary` in its
  // raw shape, so a `handoff` value forwarded from the CLI/SDK reaches
  // here untyped. Re-parsing through `CheckpointInputSchema` enforces
  // `HandoffEntryData`'s per-field byte caps (DIM-7) and strips any
  // unknown keys before the value is digested into the idempotency key
  // or persisted on the event. Returning a structured INVALID_INPUT
  // failure (rather than throwing) matches the rest of the dispatch
  // surface and lets the counter stay un-reset on rejection.
  const parsed = CheckpointInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message: `Invalid checkpoint input: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      },
    };
  }
  const validated = parsed.data;

  // #1244 — markdown-aware handoff lint. Runs over the validated payload
  // BEFORE any state-file read or event-store write so the hard-fail
  // path leaves the event stream untouched on rejection. The lint is
  // a no-op when `handoff` is absent (pre-#1240 callers) — `lintHandoff`
  // short-circuits on each empty field, so the cost is a few array
  // existence checks for the legacy shape.
  //
  // Soft-fail (default): findings surface on `data.handoffLintFindings`
  // and a human-readable summary lands on `warnings`. The checkpoint
  // event is still appended — the lint is advisory, not blocking.
  //
  // Hard-fail (`options.handoffLint.hardFail === true`, mirrored from
  // `.exarchos.yml`'s `handoffLint.hardFail`): the call rejects with
  // `INVALID_INPUT` and `data.findings` carries the structured
  // violations. No event is appended, so the operator can fix the
  // prose and retry without scrubbing a partial write.
  let handoffLintFindings: HandoffLintFinding[] = [];
  if (validated.handoff) {
    handoffLintFindings = lintHandoff(validated.handoff);
    if (handoffLintFindings.length > 0 && options?.handoffLint?.hardFail === true) {
      return {
        success: false,
        error: {
          code: ErrorCode.INVALID_INPUT,
          message: `Handoff prose failed lint (${handoffLintFindings.length} finding${
            handoffLintFindings.length === 1 ? '' : 's'
          }); see data.findings for details`,
        },
        data: { findings: handoffLintFindings },
      };
    }
  }

  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  let state: WorkflowState;
  try {
    state = await readStateFile(stateFile);
  } catch (err) {
    if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_NOT_FOUND,
          message: `State not found for feature: ${input.featureId}`,
        },
      };
    }
    throw err;
  }

  // Work with a deep copy to avoid shared reference mutation
  const mutableState = structuredClone(state) as Record<string, unknown>;

  // Reset checkpoint counter with current phase and optional summary
  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    state.phase,
    input.summary,
  );

  // Emit checkpoint event to external store (event-first, guaranteed).
  //
  // C3 (#1241): include a sha256 prefix of the `handoff` payload in the
  // idempotency key so refinement calls (same featureId+phase+version
  // but distinct handoff content) land as distinct events. T4 (#1240)
  // formalizes `handoff` on `CheckpointInputSchema` — `validated.handoff`
  // is now typed against `HandoffEntryData` and missing/undefined drops
  // through to the legacy `JSON.stringify({}) === '{}'` digest, keeping
  // dedup behaviour stable for pre-#1240 callers.
  const handoff = validated.handoff;
  const handoffDigest = createHash('sha256')
    .update(JSON.stringify(handoff ?? {}))
    .digest('hex')
    .slice(0, 16);
  const checkpointIdempotencyKey =
    `${input.featureId}:checkpoint:${state.phase}:${state._version}:${handoffDigest}`;
  if (eventStore) {
    try {
      // #1325 — route through buildValidatedEvent for defense-in-depth
      // Zod validation at the emission boundary.
      const validatedEvent = buildValidatedEvent(input.featureId, 1, {
        type: 'workflow.checkpoint' as import('../event-store/schemas.js').EventType,
        correlationId: input.featureId,
        source: 'workflow',
        // T4 (#1240): persist the handoff payload on the event when the
        // caller supplied one. Spread-on-condition keeps `data.handoff`
        // absent for legacy callers — historical events on disk lacked
        // this key entirely, and the rehydration projection's `v:1`
        // tolerant schema relies on that absence rather than an explicit
        // `null` to flag pre-#1240 entries.
        data: {
          counter: 0,
          phase: state.phase,
          featureId: input.featureId,
          ...(handoff !== undefined && { handoff }),
        },
      });
      await eventStore.appendValidated(input.featureId, validatedEvent, { idempotencyKey: checkpointIdempotencyKey });
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  // T034 (DR-6) — materialize the rehydration projection. Performed AFTER
  // the `workflow.checkpoint` event above is appended so the snapshot folds
  // that event into the projection too (the rehydration reducer treats
  // `workflow.checkpoint` as unhandled, so this is a no-op for sequence, but
  // the ordering keeps the invariant "snapshot reflects everything known as
  // of the checkpoint moment").
  //
  // We reuse `hydrateFromSnapshotThenTail` (T031) so the fold-from-latest-
  // snapshot-then-tail logic is identical to the rehydrate handler — same
  // trust boundary on `snapshot.state`, same empty-stream behaviour. When no
  // event store is configured this step is skipped entirely; the checkpoint
  // reset still takes effect but no projection is materialized.
  //
  // Hoisted out of the `if (eventStore)` scope so the return below can
  // surface `projectionSequence` in `data` (T035, DR-6) — the CLI adapter
  // renders this to let operators see at a glance how many events are
  // behind the new checkpoint.
  let projectionSequence: number | undefined;
  if (eventStore) {
    // The hydrate-then-write block is the I/O-heavy part of checkpoint:
    // event-store query, snapshot sidecar read, JSONL serialization,
    // atomic temp-file write, rename. Any of those can throw on a
    // healthy-looking process (transient EIO, EROFS, ENOSPC mid-fsync,
    // sidecar permissions race). Catch them all and surface a structured
    // failure rather than letting the exception bubble out of
    // `handleCheckpoint` — the workflow state file (counter reset) has
    // already been written above, so an unhandled throw here would leave
    // disk state divergent from the dispatch envelope. (Sentry HIGH on
    // PR #1178: tools.ts:1036 missing error handling around
    // hydrateFromSnapshotThenTail and appendSnapshot.)
    let document: RehydrationDocument;
    let lastEventSequence: number;
    try {
      ({ state: document, lastEventSequence } = await hydrateFromSnapshotThenTail<
        RehydrationDocument,
        WorkflowEvent
      >(
        rehydrationReducer,
        eventStore,
        input.featureId,
        stateDir,
        REHYDRATION_PROJECTION_ID,
        REHYDRATION_PROJECTION_VERSION,
      ));
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.PROJECTION_REPLAY_FAILED,
          message: `hydrate-from-snapshot failed during checkpoint: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
    // The dispatch envelope's `projectionSequence` exposes a checkpoint-lag
    // signal to operators ("how far through the stream is this checkpoint")
    // and the CLI adapter renders it directly. The meaningful value here is
    // the absorbed event-store position (`lastEventSequence`), not the
    // reducer's internal handled-event counter (`document.projectionSequence`)
    // — those two values diverge whenever the stream contains unhandled
    // events, and the operator-facing meaning needs the stream position.
    // (CodeRabbit PR #1178 follow-up review.)
    projectionSequence = lastEventSequence;

    // SnapshotRecord.sequence is the highest event-store sequence absorbed
    // into `document` — NOT `document.projectionSequence`. The two values
    // diverge whenever the stream contains events the rehydration reducer
    // doesn't fold (e.g. `gate.executed` is unhandled by
    // `rehydrationReducer.apply`), and a later `rehydrate` call uses this
    // field as `sinceSequence` against `eventStore.query`. Storing the
    // projection sequence here would make the query under-skip, causing
    // already-absorbed events to be re-applied on every read. (Sentry HIGH
    // on PR #1178.)
    const snapshotRecord: SnapshotRecord = {
      projectionId: REHYDRATION_PROJECTION_ID,
      projectionVersion: REHYDRATION_PROJECTION_VERSION,
      sequence: lastEventSequence,
      state: document,
      timestamp: new Date().toISOString(),
    };

    // `byteSize` is the serialized payload size of this record. Pre-Wave-A
    // the snapshot store wrote one JSONL line per record and this metric
    // included the trailing `\n` delimiter (CodeRabbit PR #1178). Post-Wave-A
    // snapshots persist into the SQLite `projection_snapshots` table with no
    // newline framing, so we measure the JSON payload only. The
    // `workflow.checkpoint_written` event can still be emitted pre-write
    // because the payload bytes are independent of the substrate.
    const serialized = JSON.stringify(snapshotRecord);
    const byteSize = Buffer.byteLength(serialized, 'utf8');

    try {
      appendSnapshot(eventStore.getReadBackend(), input.featureId, snapshotRecord);
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.SNAPSHOT_WRITE_FAILED,
          message: `snapshot write failed during checkpoint: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    try {
      // #1325 — route through buildValidatedEvent for defense-in-depth
      // Zod validation at the emission boundary.
      const validatedEvent = buildValidatedEvent(input.featureId, 1, {
        type: 'workflow.checkpoint_written' as import('../event-store/schemas.js').EventType,
        correlationId: input.featureId,
        source: 'workflow',
        data: {
          projectionId: REHYDRATION_PROJECTION_ID,
          // The event payload's `projectionSequence` field carries the same
          // operator-facing checkpoint-lag signal the dispatch envelope does
          // — the absorbed stream position, not the reducer's handled-event
          // counter. Aligned with the envelope assignment above so observers
          // see one consistent number regardless of which surface they read.
          // (CodeRabbit PR #1178 follow-up review.)
          projectionSequence: lastEventSequence,
          byteSize,
        },
      });
      await eventStore.appendValidated(input.featureId, validatedEvent, {
        // Idempotency: one written event per (feature, projection, absorbed
        // sequence). `document.projectionSequence` only advances on events
        // the reducer handled, so two snapshots that absorbed different sets
        // of *unhandled* events would collide on the same key and the second
        // legitimate `workflow.checkpoint_written` would be silently
        // suppressed. Keying off `lastEventSequence` (the highest event-store
        // sequence absorbed into the snapshot — also stored as
        // `SnapshotRecord.sequence`) keeps each fresh on-disk snapshot
        // observable. (CodeRabbit PR #1178 review.)
        idempotencyKey: `${input.featureId}:checkpoint_written:${REHYDRATION_PROJECTION_ID}:${lastEventSequence}`,
      });
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Event append failed (workflow.checkpoint_written): ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  // CodeRabbit major on PR #1297 (tools.ts:930-960): the version-advancing
  // `writeStateFile` MUST be deferred until AFTER the snapshot fold and
  // `workflow.checkpoint_written` append both succeed. The idempotency
  // key for the `workflow.checkpoint` event above includes
  // `state._version`, and `writeStateFile` advances disk `_version` from
  // N to N+1 as a side effect of writing. If the write happened earlier
  // and any later step failed, the operator's retry would read N+1,
  // compute a different idempotency key, and the event-store dedup would
  // miss — duplicating the checkpoint event on the stream. Deferring the
  // write is the minimum-mutation fix that keeps retries collapsing onto
  // one checkpoint event by holding `_version` stable until the whole
  // bundle commits.
  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();
  mutableState.updatedAt = new Date().toISOString();
  await writeStateFile(stateFile, mutableState as WorkflowState);

  // v2.11 substrate cut (#1082): sidecar fallback removed; no `sidecarPending`.
  // T-23 (rehydration-machinery-refactor) — compose `phasePlaybook` for the
  // dispatch envelope using the shared helper that `handleRehydrate` also
  // calls (T-20). After the `workflow.checkpoint` event has landed and
  // BEFORE we build the return value so the envelope reflects the same
  // (workflowType, phase) the checkpoint was recorded for. The helper
  // returns `null` for unregistered pairs (e.g. discovery/completed) and a
  // serialized `SerializedPhasePlaybook` for registered ones (e.g.
  // feature/delegate → skill: 'delegate'). The v:3 envelope schema
  // treats `phasePlaybook` as nullable, not optional, so we surface the
  // null explicitly rather than omitting the field — CLI/SDK renderers
  // spread the value without an `undefined` guard.
  const phasePlaybook = composePhasePlaybook(
    state.workflowType as string,
    state.phase,
  );

  // #1244 — soft-fail surfacing. Findings are only attached when
  // non-empty so the field's *presence* on the data envelope is itself
  // the signal to the caller. Clean handoffs produce no field, no
  // warnings entry; this keeps the response payload small for the
  // happy path. The summary on `warnings` carries a count + the
  // distinct source fields so operators see the shape without
  // unmarshalling `data.handoffLintFindings`.
  const handoffWarnings: string[] = [];
  if (handoffLintFindings.length > 0) {
    const sources = Array.from(
      new Set(handoffLintFindings.map((f) => f.source)),
    ).sort();
    handoffWarnings.push(
      `handoff prose lint: ${handoffLintFindings.length} finding${
        handoffLintFindings.length === 1 ? '' : 's'
      } across ${sources.join(', ')}`,
    );
  }

  return {
    success: true,
    data: {
      phase: (mutableState._checkpoint as Record<string, unknown>).phase as string,
      // T035, DR-6: surface the materialized projection's sequence so the
      // CLI adapter can render "N events behind this checkpoint" without
      // a follow-up query. Omitted when no event store is configured —
      // the materialization block above skips entirely in that mode.
      ...(projectionSequence !== undefined && { projectionSequence }),
      // T-23: present unconditionally (null for unregistered pairs) — the
      // v:3 envelope schema requires the field's presence, not just
      // truthiness. (#1082 sidecar field deleted in v2.11 substrate cut.)
      phasePlaybook,
      // #1244: only attach the findings array when non-empty so the
      // happy path stays slim and the field's presence is itself a
      // self-describing signal.
      ...(handoffLintFindings.length > 0 && { handoffLintFindings }),
    },
    ...(handoffWarnings.length > 0 && { warnings: handoffWarnings }),
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}

// ─── handleReconcileState ───────────────────────────────────────────────

/**
 * Reconcile workflow state from events in the JSONL event store.
 *
 * Delegates to `reconcileFromEvents` which rebuilds state from events,
 * applying any that are newer than the state's `_eventSequence`.
 * Idempotent — running with no new events returns `{ reconciled: false, eventsApplied: 0 }`.
 */
export async function handleReconcileState(
  input: { featureId: string },
  stateDir: string,
  eventStore: EventStore | null,
): Promise<ToolResult> {
  // Validate featureId
  if (!input.featureId) {
    return {
      success: false,
      error: {
        code: ErrorCode.INVALID_INPUT,
        message: 'featureId is required for reconcile action',
      },
    };
  }

  // Guard: event store must be configured
  if (!eventStore) {
    return {
      success: false,
      error: {
        code: ErrorCode.EVENT_STORE_NOT_CONFIGURED,
        message: 'Event store is not configured — reconcile requires an event store',
      },
    };
  }

  try {
    const result = await reconcileFromEvents(stateDir, input.featureId, eventStore);
    return {
      success: true,
      data: {
        reconciled: result.reconciled,
        eventsApplied: result.eventsApplied,
      },
    };
  } catch (err) {
    if (err instanceof StateStoreError) {
      return {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.data !== undefined ? { data: err.data } : {}),
        },
      };
    }
    throw err;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve a dot-path against an object, returning the value at that path.
 * Returns undefined if the path does not exist.
 */
function resolveDotPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const segments = dotPath.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;

    // Handle array bracket notation: "tasks[0]"
    const bracketMatch = segment.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      current = (current as Record<string, unknown>)[bracketMatch[1] ?? ''];
      if (!Array.isArray(current)) return undefined;
      current = current[parseInt(bracketMatch[2] ?? '0', 10)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}


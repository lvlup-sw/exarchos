import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  InitInput,
  ListInput,
  GetInput,
  SetInput,
  CheckpointInput,
  WorkflowState,
} from './types.js';
import { ErrorCode, isReservedField } from './schemas.js';
import {
  initStateFile,
  readStateFile,
  writeStateFile,
  applyDotPath,
  listStateFiles,
  StateStoreError,
  VersionConflictError,
} from './state-store.js';
import {
  buildCheckpointMeta,
  incrementOperations,
  resetCounter,
  isStale,
} from './checkpoint.js';
import { mapInternalToExternalType } from './events.js';
import { getHSMDefinition, executeTransition } from './state-machine.js';
import { formatResult, type ToolResult } from '../format.js';
import * as fs from 'node:fs/promises';
import type { EventStore } from '../event-store/store.js';
import type { ViewMaterializer } from '../views/materializer.js';
import { WORKFLOW_STATE_VIEW, type WorkflowStateView } from '../views/workflow-state-projection.js';
import * as path from 'node:path';

// ─── Module-Level EventStore Configuration ──────────────────────────────────

let moduleEventStore: EventStore | null = null;

/** Configure the EventStore instance used by workflow tool handlers. */
export function configureWorkflowEventStore(store: EventStore | null): void {
  moduleEventStore = store;
}

// ─── Module-Level ViewMaterializer Configuration ─────────────────────────────

let moduleViewMaterializer: ViewMaterializer | null = null;

/** Configure the ViewMaterializer instance used by handleGet for ES v2 workflows. */
export function configureWorkflowMaterializer(materializer: ViewMaterializer | null): void {
  moduleViewMaterializer = materializer;
}

// Re-export from dedicated modules for backward compatibility
export { handleNextAction } from './next-action.js';
export { handleCancel } from './cancel.js';
export { handleSummary, handleReconcile, handleTransitions } from './query.js';

// ─── Fast-Path Query Fields ──────────────────────────────────────────────────

const FAST_PATH_FIELDS = new Set(['phase', 'featureId', 'workflowType', 'track', 'version']);

async function readFieldFast(stateFile: string, field: string): Promise<{ value: unknown; checkpoint: unknown }> {
  const raw = await fs.readFile(stateFile, 'utf-8');
  const parsed = JSON.parse(raw);
  return { value: parsed[field], checkpoint: parsed._checkpoint };
}

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

// ─── handleInit ─────────────────────────────────────────────────────────────

/**
 * Initialize a new workflow state file.
 *
 * **Event-first contract:** When an event store is configured, the
 * `workflow.started` event is appended BEFORE the state file is created.
 * If the event append fails, no state file is written and an error is
 * returned. When no event store is configured, the state file is created
 * with `_eventSequence = 0` for graceful degradation.
 */
export async function handleInit(
  input: InitInput,
  stateDir: string,
): Promise<ToolResult> {
  try {
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

    // Event-first: append workflow.started event BEFORE creating state file
    let eventSequence = 0;
    if (moduleEventStore) {
      try {
        const event = await moduleEventStore.append(input.featureId, {
          type: 'workflow.started' as import('../event-store/schemas.js').EventType,
          correlationId: input.featureId,
          source: 'workflow',
          data: {
            featureId: input.featureId,
            workflowType: input.workflowType,
          },
        }, { idempotencyKey: `${input.featureId}:workflow.started` });
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
    }

    const { state } = await initStateFile(
      stateDir,
      input.featureId,
      input.workflowType,
      { _eventSequence: eventSequence, _esVersion: CURRENT_ES_VERSION },
    );

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
    if (err instanceof StateStoreError && err.code === ErrorCode.STATE_ALREADY_EXISTS) {
      return {
        success: false,
        error: {
          code: ErrorCode.STATE_ALREADY_EXISTS,
          message: `State already exists for feature: ${input.featureId}`,
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
  const entries = await listStateFiles(stateDir);

  const data = entries.map((entry) => ({
    featureId: entry.featureId,
    workflowType: entry.state.workflowType,
    phase: entry.state.phase,
    stateFile: entry.stateFile,
    stale: isStale(entry.state._checkpoint),
  }));

  return {
    success: true,
    data,
  };
}

// ─── handleGet ──────────────────────────────────────────────────────────────

export async function handleGet(
  input: GetInput,
  stateDir: string,
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);

  // Fast path for simple top-level scalar queries — skips Zod validation.
  // The state file is kept in sync for v2 workflows, so fast path is safe
  // for both legacy and ES v2 workflows.
  if (input.query && FAST_PATH_FIELDS.has(input.query)) {
    try {
      const { value, checkpoint } = await readFieldFast(stateFile, input.query);
      if (value === undefined || checkpoint == null) {
        throw new Error('FAST_PATH_MISS');
      }
      return {
        success: true,
        data: value,
        _meta: buildCheckpointMeta(checkpoint as WorkflowState['_checkpoint']),
      };
    } catch {
      // Fall through to full validation path (handles STATE_NOT_FOUND etc.)
    }
  }

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
    && moduleEventStore !== null
    && moduleViewMaterializer !== null;

  if (useEventSource) {
    return handleGetFromEvents(input, state);
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
): Promise<ToolResult> {
  const events = await moduleEventStore!.query(input.featureId);
  const materialized = moduleViewMaterializer!.materialize<WorkflowStateView>(
    input.featureId,
    WORKFLOW_STATE_VIEW,
    events,
  );

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

// ─── Event Emission Helper ──────────────────────────────────────────────────

interface TransitionEventRecord {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly trigger: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Emit transition events to the external JSONL event store.
 * Used by both the success path (after CAS write) and the failure path
 * (diagnostic events like guard-failed, circuit-open).
 *
 * @returns Error message string on failure, undefined on success or when no events to emit.
 */
async function emitTransitionEvents(
  featureId: string,
  events: readonly TransitionEventRecord[],
): Promise<string | undefined> {
  if (!moduleEventStore || events.length === 0) return undefined;
  try {
    for (const evt of events) {
      await moduleEventStore.append(featureId, {
        type: mapInternalToExternalType(evt.type) as import('../event-store/schemas.js').EventType,
        correlationId: featureId,
        source: 'workflow',
        data: {
          from: evt.from,
          to: evt.to,
          trigger: evt.trigger,
          featureId,
          ...(evt.metadata ?? {}),
        },
      });
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// ─── handleSet ──────────────────────────────────────────────────────────────

const MAX_CAS_RETRIES = 3;

/**
 * Update fields and/or transition phase on a workflow state file.
 *
 * **Event-first contract:** When an event store is configured and a phase
 * transition occurs, the `workflow.transition` event is appended BEFORE
 * the state file is written. If the event append fails, no state is
 * modified and an error is returned. Idempotency keys prevent duplicate
 * events on CAS retry: `${featureId}:${from}:${to}:${expectedVersion}`.
 *
 * For field-only updates (no phase change), no events are emitted and
 * `_eventSequence` is not modified.
 */
export async function handleSet(
  input: SetInput,
  stateDir: string,
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

    // Capture version for CAS
    const expectedVersion = state._version ?? 1;

    // Work with a deep copy to avoid shared reference mutation
    const mutableState = structuredClone(state) as Record<string, unknown>;

    // ─── Field updates (applied first so phase guards see new state) ───
    if (input.updates) {
      // Check for reserved fields before applying any updates
      for (const dotPath of Object.keys(input.updates)) {
        if (isReservedField(dotPath)) {
          return {
            success: false,
            error: {
              code: ErrorCode.RESERVED_FIELD,
              message: `Cannot update reserved field: ${dotPath}`,
            },
          };
        }
      }

      for (const [dotPath, value] of Object.entries(input.updates)) {
        applyDotPath(mutableState, dotPath, value);
      }
    }

    // ─── Phase transition (guards evaluate against updated state) ──────
    // Collect transition events for event-first emission before CAS write
    let pendingTransitionEvents: TransitionEventRecord[] = [];

    if (input.phase) {
      const hsm = getHSMDefinition(state.workflowType);
      const result = executeTransition(hsm, mutableState, input.phase);

      if (!result.success) {
        // Emit diagnostic events (guard-failed, circuit-open) before returning error.
        // These are emitted BEFORE state write since no state change occurs on failure.
        await emitTransitionEvents(input.featureId, result.events);

        const errorCode = result.errorCode ?? ErrorCode.INVALID_TRANSITION;
        return {
          success: false,
          error: {
            code: errorCode,
            message: result.errorMessage ?? `Transition failed to '${input.phase}'`,
            ...(result.validTargets?.length ? { validTargets: result.validTargets } : {}),
          },
        };
      }

      if (!result.idempotent && result.newPhase) {
        // Collect transition events for event-first emission
        pendingTransitionEvents = result.events.map((e) => ({
          type: e.type,
          from: e.from,
          to: e.to,
          trigger: e.trigger,
          metadata: e.metadata,
        }));

        // Mutate state
        mutableState.phase = result.newPhase;

        // Apply history updates
        if (result.historyUpdates) {
          const history = { ...(mutableState._history as Record<string, string>) };
          for (const [key, value] of Object.entries(result.historyUpdates)) {
            history[key] = value;
          }
          mutableState._history = history;
        }

        // Reset checkpoint counter on phase transition
        mutableState._checkpoint = resetCounter(
          mutableState._checkpoint as WorkflowState['_checkpoint'],
          result.newPhase,
        );
      }
    }

    // ─── Event-first: append transition events BEFORE CAS write ───────
    // Idempotency keys prevent duplicate events on CAS retry.
    let highestEventSequence: number | undefined;

    if (moduleEventStore && pendingTransitionEvents.length > 0) {
      try {
        for (const transitionEvent of pendingTransitionEvents) {
          const idempotencyKey = `${input.featureId}:${transitionEvent.from}:${transitionEvent.to}:${expectedVersion}`;
          const event = await moduleEventStore.append(input.featureId, {
            type: mapInternalToExternalType(transitionEvent.type) as import('../event-store/schemas.js').EventType,
            correlationId: input.featureId,
            source: 'workflow',
            data: {
              from: transitionEvent.from,
              to: transitionEvent.to,
              trigger: transitionEvent.trigger,
              featureId: input.featureId,
              ...(transitionEvent.metadata ?? {}),
            },
          }, { idempotencyKey });

          if (highestEventSequence === undefined || event.sequence > highestEventSequence) {
            highestEventSequence = event.sequence;
          }
        }
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

    // Update _eventSequence only when transition events were appended
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
        // Re-read and retry on version conflict — events already appended
        // with idempotency key, so re-append on next iteration is safely
        // deduplicated
        continue;
      }

      // CAS exhaustion: emit diagnostic event before throwing
      if (err instanceof VersionConflictError && moduleEventStore) {
        try {
          await moduleEventStore.append(input.featureId, {
            type: 'workflow.cas-failed' as import('../event-store/schemas.js').EventType,
            data: {
              featureId: input.featureId,
              phase: input.phase ?? (mutableState.phase as string) ?? 'unknown',
              retries: MAX_CAS_RETRIES,
            },
          });
        } catch {
          // Best-effort diagnostic emission — don't mask the actual CAS error
        }
      }

      throw err;
    }

    // Event-first: events already appended before CAS write with idempotency keys.
    // State write is the follow-up materialization step.
    return {
      success: true,
      data: {
        phase: mutableState.phase as string,
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

// ─── handleCheckpoint ──────────────────────────────────────────────────────

export async function handleCheckpoint(
  input: CheckpointInput,
  stateDir: string,
): Promise<ToolResult> {
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

  // Emit checkpoint event to external store (event-first, guaranteed)
  if (moduleEventStore) {
    try {
      await moduleEventStore.append(input.featureId, {
        type: 'workflow.checkpoint' as import('../event-store/schemas.js').EventType,
        correlationId: input.featureId,
        source: 'workflow',
        data: {
          counter: 0,
          phase: state.phase,
          featureId: input.featureId,
        },
      });
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

  // Update lastActivityTimestamp
  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  // Update top-level timestamp
  mutableState.updatedAt = new Date().toISOString();

  // Write back to disk
  await writeStateFile(stateFile, mutableState as WorkflowState);

  return {
    success: true,
    data: {
      phase: (mutableState._checkpoint as Record<string, unknown>).phase as string,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
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
      current = (current as Record<string, unknown>)[bracketMatch[1]];
      if (!Array.isArray(current)) return undefined;
      current = current[parseInt(bracketMatch[2], 10)];
    } else {
      current = (current as Record<string, unknown>)[segment];
    }
  }

  return current;
}

// ─── Shared Schema Components ───────────────────────────────────────────────

const featureIdParam = z.string().min(1).regex(/^[a-z0-9-]+$/);
const workflowTypeParam = z.enum(['feature', 'debug', 'refactor']);

// ─── Registration Function ──────────────────────────────────────────────────

export function registerWorkflowTools(server: McpServer, stateDir: string): void {
  server.tool(
    'exarchos_workflow_init',
    'Initialize a new workflow state file for a feature/debug/refactor workflow',
    { featureId: featureIdParam, workflowType: workflowTypeParam },
    async (args) => formatResult(await handleInit(args, stateDir)),
  );

  server.tool(
    'exarchos_workflow_list',
    'List all active workflow state files with staleness information',
    {},
    async (args) => formatResult(await handleList(args, stateDir)),
  );

  server.tool(
    'exarchos_workflow_get',
    'Query a field via dot-path (e.g. query:"phase"), project specific fields (fields:["phase","featureId"]), or get full state if neither',
    { featureId: featureIdParam, query: z.string().optional(), fields: z.array(z.string()).optional() },
    async (args) => formatResult(await handleGet(args, stateDir)),
  );

  server.tool(
    'exarchos_workflow_set',
    'Update fields and/or transition phase. Returns {phase, updatedAt}',
    {
      featureId: featureIdParam,
      updates: z.record(z.string(), z.unknown()).optional(),
      phase: z.string().optional(),
    },
    async (args) => formatResult(await handleSet(args, stateDir)),
  );

  server.tool(
    'exarchos_workflow_checkpoint',
    'Create an explicit checkpoint, resetting the operation counter',
    { featureId: featureIdParam, summary: z.string().optional() },
    async (args) => formatResult(await handleCheckpoint(args, stateDir)),
  );
}

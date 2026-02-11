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
import * as path from 'node:path';

// ─── Module-Level EventStore Configuration ──────────────────────────────────

let moduleEventStore: EventStore | null = null;

/** Configure the EventStore instance used by workflow tool handlers. */
export function configureWorkflowEventStore(store: EventStore): void {
  moduleEventStore = store;
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

// ─── handleInit ─────────────────────────────────────────────────────────────

export async function handleInit(
  input: InitInput,
  stateDir: string,
): Promise<ToolResult> {
  try {
    const { state } = await initStateFile(stateDir, input.featureId, input.workflowType);
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

  // Fast path for simple top-level scalar queries — skips Zod validation
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

  const meta = buildCheckpointMeta(state._checkpoint);

  if (!input.query) {
    const strippedState = stripInternalFields(state as unknown as Record<string, unknown>);
    return {
      success: true,
      data: strippedState,
      _meta: meta,
    };
  }

  // Resolve dot-path query against the state object
  const value = resolveDotPath(state as unknown as Record<string, unknown>, input.query);
  return {
    success: true,
    data: value,
    _meta: meta,
  };
}

// ─── handleSet ──────────────────────────────────────────────────────────────

export async function handleSet(
  input: SetInput,
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
  if (input.phase) {
    const hsm = getHSMDefinition(state.workflowType);
    const result = executeTransition(hsm, mutableState, input.phase);

    if (!result.success) {
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
      // Event-first: emit to external event store BEFORE mutating state (best-effort)
      if (moduleEventStore) {
        try {
          for (const transitionEvent of result.events) {
            await moduleEventStore.append(input.featureId, {
              type: mapInternalToExternalType(transitionEvent.type) as import('../event-store/schemas.js').EventType,
              data: {
                from: transitionEvent.from,
                to: transitionEvent.to,
                trigger: transitionEvent.trigger,
                featureId: input.featureId,
                ...(transitionEvent.metadata ?? {}),
              },
            });
          }
        } catch {
          // External store is supplementary; JSONL append failure must not break workflow
        }
      }

      // THEN mutate state
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

  // Increment checkpoint operation counter
  mutableState._checkpoint = incrementOperations(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
  );

  // Update timestamp
  mutableState.updatedAt = new Date().toISOString();

  // Update lastActivityTimestamp on checkpoint
  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  // Write back to disk
  await writeStateFile(stateFile, mutableState as WorkflowState);

  return {
    success: true,
    data: {
      phase: mutableState.phase as string,
      updatedAt: mutableState.updatedAt as string,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
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

  // Emit checkpoint event to external store (event-first, best-effort)
  if (moduleEventStore) {
    try {
      await moduleEventStore.append(input.featureId, {
        type: 'workflow.checkpoint' as import('../event-store/schemas.js').EventType,
        data: {
          counter: 0,
          phase: state.phase,
          featureId: input.featureId,
        },
      });
    } catch {
      // External store is supplementary; JSONL append failure must not break workflow
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
    'Query a field via dot-path (e.g. query:"phase") or get full state if no query',
    { featureId: featureIdParam, query: z.string().optional() },
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

import type {
  InitInput,
  ListInput,
  GetInput,
  SetInput,
  CheckpointInput,
  CheckpointMeta,
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
import { appendEvent } from './events.js';
import { getHSMDefinition, executeTransition } from './state-machine.js';
import * as path from 'node:path';

// Re-export from dedicated modules for backward compatibility
export { handleNextAction } from './next-action.js';
export { handleCancel } from './cancel.js';
export { handleSummary, handleReconcile, handleTransitions } from './query.js';

// ─── Tool Result Interface ──────────────────────────────────────────────────

export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; message: string; validTargets?: readonly string[] };
  readonly _meta?: CheckpointMeta;
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
    return {
      success: true,
      data: state,
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
      // Update phase
      mutableState.phase = result.newPhase;

      // Apply events from the transition
      let events = mutableState._events as WorkflowState['_events'];
      let eventSequence = mutableState._eventSequence as number;

      for (const transitionEvent of result.events) {
        const appended = appendEvent(
          events,
          eventSequence,
          transitionEvent.type as WorkflowState['_events'][number]['type'],
          transitionEvent.trigger,
          {
            from: transitionEvent.from,
            to: transitionEvent.to,
            metadata: transitionEvent.metadata,
          },
        );
        events = appended.events;
        eventSequence = appended.eventSequence;
      }

      mutableState._events = events;
      mutableState._eventSequence = eventSequence;

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

  // Append checkpoint event to event log
  const trigger = input.summary ?? 'explicit checkpoint';
  const appended = appendEvent(
    mutableState._events as WorkflowState['_events'],
    mutableState._eventSequence as number,
    'checkpoint',
    trigger,
  );
  mutableState._events = appended.events;
  mutableState._eventSequence = appended.eventSequence;

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

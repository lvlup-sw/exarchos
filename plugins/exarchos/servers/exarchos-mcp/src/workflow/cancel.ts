import type {
  CancelInput,
  CheckpointMeta,
  WorkflowState,
} from './types.js';
import { ErrorCode } from './schemas.js';
import {
  readStateFile,
  writeStateFile,
  StateStoreError,
} from './state-store.js';
import {
  buildCheckpointMeta,
  resetCounter,
} from './checkpoint.js';
import { appendEvent } from './events.js';
import { getHSMDefinition, executeTransition } from './state-machine.js';
import { executeCompensation } from './compensation.js';
import * as path from 'node:path';

// ─── Tool Result Interface ──────────────────────────────────────────────────

export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; message: string; validTargets?: readonly string[] };
  readonly _meta?: CheckpointMeta;
}

// ─── handleCancel ──────────────────────────────────────────────────────────

export async function handleCancel(
  input: CancelInput,
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

  // Check if already cancelled
  if (state.phase === 'cancelled') {
    return {
      success: false,
      error: {
        code: ErrorCode.ALREADY_CANCELLED,
        message: `Workflow '${input.featureId}' is already cancelled`,
      },
    };
  }

  const mutableState = structuredClone(state) as Record<string, unknown>;
  const currentPhase = state.phase;
  const events = (mutableState._events as WorkflowState['_events']) ?? [];
  const eventSequence = (mutableState._eventSequence as number) ?? 0;
  const dryRun = input.dryRun ?? false;

  // Execute compensation actions
  const compensationResult = await executeCompensation(
    mutableState,
    currentPhase,
    events,
    eventSequence,
    { dryRun, stateDir },
  );

  // If dry run, return what would happen without modifying state
  if (dryRun) {
    return {
      success: true,
      data: {
        dryRun: true,
        actions: compensationResult.actions,
        currentPhase,
        wouldTransitionTo: 'cancelled',
      },
      _meta: buildCheckpointMeta(state._checkpoint),
    };
  }

  // Check if compensation had failures
  if (!compensationResult.success) {
    const failedActions = compensationResult.actions.filter((a) => a.status === 'failed');
    return {
      success: false,
      error: {
        code: ErrorCode.COMPENSATION_PARTIAL,
        message: `Compensation partially failed: ${failedActions.map((a) => a.message).join('; ')}`,
      },
    };
  }

  // Transition to cancelled via HSM
  const hsm = getHSMDefinition(state.workflowType);
  const transitionResult = executeTransition(hsm, mutableState, 'cancelled');

  if (!transitionResult.success) {
    return {
      success: false,
      error: {
        code: transitionResult.errorCode ?? ErrorCode.INVALID_TRANSITION,
        message: transitionResult.errorMessage ?? 'Failed to transition to cancelled',
      },
    };
  }

  // Apply phase change
  mutableState.phase = 'cancelled';

  // Build up events: start with existing events + compensation events
  let updatedEvents = [...events, ...compensationResult.events];
  let updatedSequence = eventSequence + compensationResult.events.length;

  // Append transition events from HSM
  for (const transitionEvent of transitionResult.events) {
    const appended = appendEvent(
      updatedEvents,
      updatedSequence,
      transitionEvent.type as WorkflowState['_events'][number]['type'],
      transitionEvent.trigger,
      {
        from: transitionEvent.from,
        to: transitionEvent.to,
        metadata: transitionEvent.metadata,
      },
    );
    updatedEvents = appended.events;
    updatedSequence = appended.eventSequence;
  }

  // Append cancel event with reason metadata
  const cancelMetadata: Record<string, unknown> = {};
  if (input.reason) {
    cancelMetadata.reason = input.reason;
  }
  cancelMetadata.compensationActions = compensationResult.actions.length;
  cancelMetadata.compensationSuccess = compensationResult.success;

  const cancelAppended = appendEvent(
    updatedEvents,
    updatedSequence,
    'cancel',
    'user-cancel',
    {
      from: currentPhase,
      to: 'cancelled',
      metadata: cancelMetadata,
    },
  );
  updatedEvents = cancelAppended.events;
  updatedSequence = cancelAppended.eventSequence;

  mutableState._events = updatedEvents;
  mutableState._eventSequence = updatedSequence;

  // Apply history updates from transition
  if (transitionResult.historyUpdates) {
    const history = { ...(mutableState._history as Record<string, string>) };
    for (const [key, value] of Object.entries(transitionResult.historyUpdates)) {
      history[key] = value;
    }
    mutableState._history = history;
  }

  // Reset checkpoint counter
  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    'cancelled',
    'Workflow cancelled',
  );

  // Update timestamp
  mutableState.updatedAt = new Date().toISOString();

  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  // Write updated state
  await writeStateFile(stateFile, mutableState as WorkflowState);

  return {
    success: true,
    data: {
      phase: 'cancelled',
      actions: compensationResult.actions,
      previousPhase: currentPhase,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}

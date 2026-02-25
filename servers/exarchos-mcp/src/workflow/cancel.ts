import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type {
  CancelInput,
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
import { mapInternalToExternalType } from './events.js';
import { getHSMDefinition, executeTransition } from './state-machine.js';
import { executeCompensation, type CompensationCheckpoint } from './compensation.js';
import type { EventStore } from '../event-store/store.js';
import { formatResult, type ToolResult } from '../format.js';
import * as path from 'node:path';

// ─── Event-Sourcing Version Discriminator ───────────────────────────────────

const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
function isEventSourced(state: Record<string, unknown>): boolean {
  return state._esVersion === CURRENT_ES_VERSION;
}

// ─── Module-Level EventStore Configuration ──────────────────────────────────

let moduleEventStore: EventStore | null = null;

/** Configure the EventStore instance used by cancel handlers. */
export function configureCancelEventStore(store: EventStore | null): void {
  moduleEventStore = store;
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
  const dryRun = input.dryRun ?? false;

  // Read existing compensation checkpoint from prior partial failure (if any)
  const existingCheckpoint = mutableState._compensationCheckpoint as CompensationCheckpoint | undefined;

  // Execute compensation actions (pass empty events array — events now in external store)
  const compensationResult = await executeCompensation(
    mutableState,
    currentPhase,
    [],
    0,
    { dryRun, stateDir, checkpoint: existingCheckpoint },
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
    // Persist checkpoint so retry can resume from completed actions
    mutableState._compensationCheckpoint = compensationResult.checkpoint;
    mutableState.updatedAt = new Date().toISOString();
    await writeStateFile(stateFile, mutableState as WorkflowState);

    const failedActions = compensationResult.actions.filter((a) => a.status === 'failed');
    return {
      success: false,
      error: {
        code: ErrorCode.COMPENSATION_PARTIAL,
        message: `Compensation partially failed: ${failedActions.map((a) => a.message).join('; ')}`,
      },
    };
  }

  // Determine event-sourcing version for v1/v2 path discrimination
  const useEventFirst = isEventSourced(mutableState) && moduleEventStore !== null;

  // Bridge compensation events to external event store
  if (moduleEventStore && compensationResult.events.length > 0) {
    if (useEventFirst) {
      // ES v2: event-first — propagate errors, abort cancel if append fails
      try {
        for (let i = 0; i < compensationResult.events.length; i++) {
          const event = compensationResult.events[i];
          const externalType = mapInternalToExternalType(event.type);
          await moduleEventStore.append(input.featureId, {
            type: externalType as import('../event-store/schemas.js').EventType,
            data: { ...event.metadata, featureId: input.featureId },
          }, { idempotencyKey: `${input.featureId}:cancel:compensation:${event.type}:${i}` });
        }
      } catch (err) {
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed during cancel compensation: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    } else {
      // V1 legacy: best-effort — swallow errors
      try {
        for (let i = 0; i < compensationResult.events.length; i++) {
          const event = compensationResult.events[i];
          const externalType = mapInternalToExternalType(event.type);
          await moduleEventStore.append(input.featureId, {
            type: externalType as import('../event-store/schemas.js').EventType,
            data: { ...event.metadata, featureId: input.featureId },
          });
        }
      } catch {
        // V1 legacy: external store is supplementary; JSONL append failure must not break cancel
      }
    }
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

  // Build cancel metadata
  const cancelMetadata: Record<string, unknown> = {};
  if (input.reason) {
    cancelMetadata.reason = input.reason;
  }
  cancelMetadata.compensationActions = compensationResult.actions.length;
  cancelMetadata.compensationSuccess = compensationResult.success;

  // Event-first: emit to external event store BEFORE mutating state
  if (moduleEventStore) {
    if (useEventFirst) {
      // ES v2: event-first — propagate errors, abort cancel if append fails
      try {
        for (const transitionEvent of transitionResult.events) {
          await moduleEventStore.append(input.featureId, {
            type: mapInternalToExternalType(transitionEvent.type) as import('../event-store/schemas.js').EventType,
            data: {
              from: transitionEvent.from,
              to: transitionEvent.to,
              trigger: transitionEvent.trigger,
              featureId: input.featureId,
              ...(transitionEvent.metadata ?? {}),
            },
          }, { idempotencyKey: `${input.featureId}:cancel:transition:${transitionEvent.from}:cancelled` });
        }
        // Emit cancel event with distinct type and full metadata
        await moduleEventStore.append(input.featureId, {
          type: mapInternalToExternalType('cancel') as import('../event-store/schemas.js').EventType,
          data: {
            from: currentPhase,
            to: 'cancelled',
            trigger: 'user-cancel',
            featureId: input.featureId,
            ...cancelMetadata,
          },
        }, { idempotencyKey: `${input.featureId}:cancel:complete` });
      } catch (err) {
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed during cancel: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    } else {
      // V1 legacy: best-effort — swallow errors
      try {
        for (const transitionEvent of transitionResult.events) {
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
        await moduleEventStore.append(input.featureId, {
          type: mapInternalToExternalType('cancel') as import('../event-store/schemas.js').EventType,
          data: {
            from: currentPhase,
            to: 'cancelled',
            trigger: 'user-cancel',
            featureId: input.featureId,
            ...cancelMetadata,
          },
        });
      } catch {
        // V1 legacy: external store is supplementary; JSONL append failure must not break cancel
      }
    }
  }

  // THEN mutate state
  mutableState.phase = 'cancelled';

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

  // Clear compensation checkpoint on successful cancellation
  delete mutableState._compensationCheckpoint;

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

// ─── Registration Function ──────────────────────────────────────────────────

export function registerCancelTool(server: McpServer, stateDir: string): void {
  server.tool(
    'exarchos_workflow_cancel',
    'Cancel a workflow with saga compensation and cleanup',
    {
      featureId: z.string().min(1).regex(/^[a-z0-9-]+$/),
      reason: z.string().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) => formatResult(await handleCancel(args, stateDir)),
  );
}

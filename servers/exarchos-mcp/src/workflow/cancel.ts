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
import { allocatePhaseAttemptId, readPhaseAttemptId } from './phase-attempt-id.js';
import { executeCompensation, type CompensationCheckpoint } from './compensation.js';
import type { EventStore } from '../event-store/store.js';
import {
  CancelReadyData,
  CancelRequestedData,
  type EventType,
} from '../event-store/schemas.js';
import { buildValidatedEvent } from '../event-store/event-factory.js';
import { getDispatchContext } from '../dispatch/dispatch-context.js';
import { deriveLocalOperatorIdentity } from '../dispatch/caller-identity.js';
import { type ToolResult } from '../format.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ─── Event-Sourcing Version Discriminator ───────────────────────────────────

const CURRENT_ES_VERSION = 2;

/** Check whether a workflow state uses the pure event-sourcing path. */
function isEventSourced(state: Record<string, unknown>): boolean {
  return state._esVersion === CURRENT_ES_VERSION;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function cancellationKey(...parts: readonly string[]): string {
  return `cancel:${sha256(parts.join('\0'))}`;
}

function trustedCancellationProvenance(stateDir: string): Record<string, unknown> {
  const authorization = getDispatchContext()?.authorization;
  const identity = authorization?.identity ?? deriveLocalOperatorIdentity(stateDir);
  return {
    caller: {
      principalKind: identity.role === 'operator' ? 'operator' : 'agent',
      principalId: identity.subjectId,
      role: identity.role,
    },
    ...(authorization !== undefined
      ? {
          authorization: {
            authorizationId: `${authorization.policy.id}:${getDispatchContext()!.operationId}`,
            posture: authorization.posture,
            capabilityIds: [...authorization.capabilities],
            resolverVersion: authorization.resolver.version,
            resolvedAt: authorization.resolvedAt,
          },
        }
      : {}),
  };
}

async function appendCancellationFactOnce(
  eventStore: EventStore,
  featureId: string,
  operationId: string,
  type: EventType,
  data: Record<string, unknown>,
): Promise<void> {
  const dispatch = getDispatchContext();
  const timestamp = new Date().toISOString();
  const validated = buildValidatedEvent(featureId, 1, {
    type,
    data,
    timestamp,
    source: 'workflow',
    idempotencyKey: operationId,
    ...(dispatch !== undefined
      ? {
          operationId: dispatch.operationId,
          correlationId: dispatch.correlationId,
          ...(dispatch.causationId !== undefined
            ? { causationId: dispatch.causationId }
            : {}),
        }
      : {}),
  });
  const {
    streamId: _streamId,
    sequence: _sequence,
    ...eventInput
  } = validated;
  const stableData = JSON.stringify(data, (key, value) =>
    key.endsWith('At') || key === 'caller' || key === 'authorization'
      ? undefined
      : value);
  const requestDigest = `sha256:${sha256(JSON.stringify({ type, data: stableData }))}`;
  await eventStore.getAppender().decideOnce(
    operationId,
    requestDigest,
    () => ({
      streamId: featureId,
      events: [eventInput],
      result: { appended: true },
    }),
  );
}

// ─── Module-Level EventStore (removed — now threaded via DispatchContext) ─────

// ─── handleCancel ──────────────────────────────────────────────────────────

export async function handleCancel(
  input: CancelInput,
  stateDir: string,
  eventStore: EventStore | null,
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
  const phaseAttemptId = allocatePhaseAttemptId(
    input.featureId,
    currentPhase,
    'cancelled',
    readPhaseAttemptId(state),
    state._version ?? 1,
  );
  const cancelId = `cancel:${phaseAttemptId}`;
  // v2 workflows without a store retain the migration-compatible legacy path.
  // `!== null` alone does NOT exclude `undefined`: the legacy two-arg call
  // `handleCancel(input, stateDir)` passes no store at all. The pre-existing
  // event-first block was shielded by an outer `if (eventStore)`, but the
  // cancellation process manager runs BEFORE that guard, so an undefined store
  // reached `appendCancellationFactOnce` and crashed. Exclude both nullish
  // forms here, at the one place the decision is made.
  const useEventFirst =
    isEventSourced(mutableState) && eventStore !== null && eventStore !== undefined;

  // Read existing compensation checkpoint from prior partial failure (if any)
  const existingCheckpoint = mutableState._compensationCheckpoint as CompensationCheckpoint | undefined;

  // If dry run, return what would happen without modifying state
  if (dryRun) {
    const compensationResult = await executeCompensation(
      mutableState,
      currentPhase,
      [],
      0,
      { dryRun: true, stateDir, checkpoint: existingCheckpoint },
    );
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

  let compensationResult;
  if (useEventFirst) {
    const provenance = trustedCancellationProvenance(stateDir);
    const requestedAt = new Date().toISOString();
    const requestData = {
      eventVersion: '1.0',
      cancelId,
      featureId: input.featureId,
      from: currentPhase,
      phaseAttemptId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      requestedAt,
      ...provenance,
    };
    const parsedRequest = CancelRequestedData.safeParse(requestData);
    if (!parsedRequest.success) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Cancellation request evidence was malformed: ${parsedRequest.error.message}`,
        },
      };
    }
    try {
      await appendCancellationFactOnce(
        eventStore,
        input.featureId,
        cancellationKey(input.featureId, cancelId, 'requested'),
        'cancel.requested',
        parsedRequest.data,
      );
      compensationResult = await executeCompensation(
        mutableState,
        currentPhase,
        [],
        0,
        {
          dryRun: false,
          stateDir,
          eventStore,
          featureId: input.featureId,
          cancelProcess: { cancelId, phaseAttemptId },
        },
      );
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Cancellation process persistence failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  } else {
    compensationResult = await executeCompensation(
      mutableState,
      currentPhase,
      [],
      0,
      { dryRun: false, stateDir, checkpoint: existingCheckpoint },
    );
  }

  // Check if compensation had failures
  if (!compensationResult.success) {
    // Legacy callers still resume from the state checkpoint. ES v2 resumes
    // exclusively by folding durable cancellation outcomes.
    if (!useEventFirst) {
      mutableState._compensationCheckpoint = compensationResult.checkpoint;
      mutableState.updatedAt = new Date().toISOString();
      await writeStateFile(stateFile, mutableState as WorkflowState);
    }

    const failedActions = compensationResult.actions.filter((a) => a.status === 'failed');
    return {
      success: false,
      error: {
        code: ErrorCode.COMPENSATION_PARTIAL,
        message: `Compensation partially failed: ${failedActions.map((a) => a.message).join('; ')}`,
      },
    };
  }

  // Legacy bridge only. ES v2 compensation already emitted typed process facts.
  if (eventStore && compensationResult.events.length > 0) {
    try {
      for (let i = 0; i < compensationResult.events.length; i++) {
        const event = compensationResult.events[i];
        if (event === undefined) continue;
        const externalType = mapInternalToExternalType(event.type);
        await eventStore.append(input.featureId, {
          type: externalType as import('../event-store/schemas.js').EventType,
          data: { ...event.metadata, featureId: input.featureId },
        });
      }
    } catch {
      // V1 legacy: external store is supplementary.
    }
  }

  if (useEventFirst) {
    const outcomes = compensationResult.durableOutcomes;
    if (
      outcomes === undefined
      || outcomes.completedActionIds.length !== compensationResult.actions.length
    ) {
      return {
        success: false,
        error: {
          code: ErrorCode.COMPENSATION_PARTIAL,
          message: 'Cancellation readiness requires a durable outcome for every compensation action',
        },
      };
    }
    const provenance = trustedCancellationProvenance(stateDir);
    const readyAt = new Date().toISOString();
    const digestValue = sha256(JSON.stringify({
      cancelId,
      completedActionIds: outcomes.completedActionIds,
      outcomeSequences: outcomes.outcomeSequences,
    }));
    const readyData = {
      eventVersion: '1.0',
      evidenceId: `cancel-ready:${phaseAttemptId}`,
      cancelId,
      featureId: input.featureId,
      phaseAttemptId,
      completedActionIds: [...outcomes.completedActionIds],
      outcomeSequences: [...outcomes.outcomeSequences],
      contentDigest: { algorithm: 'sha256', value: digestValue },
      readyAt,
      ...provenance,
    };
    const parsedReady = CancelReadyData.safeParse(readyData);
    if (!parsedReady.success) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Cancellation readiness evidence was malformed: ${parsedReady.error.message}`,
        },
      };
    }
    try {
      await appendCancellationFactOnce(
        eventStore,
        input.featureId,
        cancellationKey(input.featureId, cancelId, 'ready'),
        'cancel.ready',
        parsedReady.data,
      );
      const replayedReady = (await eventStore.query(input.featureId)).find((event) => {
        if (event.type !== 'cancel.ready') return false;
        const parsed = CancelReadyData.safeParse(event.data);
        return parsed.success && parsed.data.cancelId === cancelId;
      });
      if (replayedReady === undefined) {
        throw new Error('cancel.ready was not durably observable after append');
      }
    } catch (err) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message: `Cancellation readiness append failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  // Existing v2.12 final transition path (no strict admission/policy routing).
  mutableState._pendingPhaseAttemptId = phaseAttemptId;
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
  cancelMetadata.phaseAttemptId = phaseAttemptId;

  // Event-first: emit to external event store BEFORE mutating state
  if (eventStore) {
    if (useEventFirst) {
      // ES v2: event-first — propagate errors, abort cancel if append fails
      try {
        for (const transitionEvent of transitionResult.events) {
          await eventStore.append(input.featureId, {
            type: mapInternalToExternalType(transitionEvent.type) as import('../event-store/schemas.js').EventType,
            data: {
              from: transitionEvent.from,
              to: transitionEvent.to,
              trigger: transitionEvent.trigger,
              featureId: input.featureId,
              ...(transitionEvent.metadata ?? {}),
            },
          }, { idempotencyKey: `${input.featureId}:cancel:transition:${transitionEvent.type}:${transitionEvent.from}:cancelled` });
        }
        // Emit cancel event with distinct type and full metadata
        await eventStore.append(input.featureId, {
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
          await eventStore.append(input.featureId, {
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
        await eventStore.append(input.featureId, {
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
  mutableState.phaseAttemptId = phaseAttemptId;
  delete mutableState._pendingPhaseAttemptId;

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
      phaseAttemptId,
    },
    _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
  };
}

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
import { hsmTransitionGuard } from './hsm-transition-guard.js';
import { recordLiveTransition } from './admission/live-shadow-observer.js';
import { allocatePhaseAttemptId, readPhaseAttemptId } from './phase-attempt-id.js';
import { executeCompensation, CANCEL_MAX_ATTEMPTS, type CompensationCheckpoint } from './compensation.js';
import type { EventStore } from '../events/store.js';
import {
  CancelReadyData,
  CancelRequestedData,
} from '../events/schemas.js';
import {
  acquireCancelOwnership,
  appendFencedCancelEvent,
  buildCancelReadiness,
  manualInterventionActions,
  queryCancelSaga,
} from './cancel-process-manager.js';
import { getDispatchContext } from '../dispatch/dispatch-context.js';
import { deriveLocalOperatorIdentity } from '../dispatch/caller-identity.js';
import { type ToolResult } from '../format.js';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

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
  const dispatch = getDispatchContext();
  const authorization = dispatch?.authorization;
  const identity = authorization?.identity ?? deriveLocalOperatorIdentity(stateDir);
  return {
    caller: {
      principalKind: identity.role === 'operator' ? 'operator' : 'agent',
      principalId: identity.subjectId,
      role: identity.role,
    },
    ...(authorization !== undefined && dispatch !== undefined
      ? {
          authorization: {
            authorizationId: `${authorization.policy.id}:${dispatch.operationId}`,
            posture: authorization.posture,
            capabilityIds: [...authorization.capabilities],
            resolverVersion: authorization.resolver.version,
            resolvedAt: authorization.resolvedAt,
          },
        }
      : {}),
  };
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
  // Fencing epoch acquired on ownership (P04-02). 0 means "no owner yet"; the
  // event-sourced path replaces it with a strictly-monotonic epoch that fences
  // out any stale instance's subsequent writes.
  let cancelEpoch = 0;
  const cancelInstanceId = `cancel-instance:${randomUUID()}`;
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
    const granted = parsedRequest.data.authorization?.capabilityIds ?? [];
    if (parsedRequest.data.authorization !== undefined && granted.length === 0) {
      return {
        success: false,
        error: {
          code: ErrorCode.EVENT_APPEND_FAILED,
          message:
            'Cancellation request evidence was malformed: capabilityIds must contain at least one capability',
        },
      };
    }
    try {
      // ── Acquire ownership + fencing epoch (P04-02) ───────────────────────
      // The process manager takes the cancellation under a monotonic fencing
      // token BEFORE recording intent. Every subsequent write carries this
      // epoch and is rejected atomically if a newer instance has taken over.
      const owned = await acquireCancelOwnership(eventStore, {
        featureId: input.featureId,
        cancelId,
        phaseAttemptId,
        instanceId: cancelInstanceId,
        operationId: `cancel:ownership:${cancelId}:${cancelInstanceId}`,
      });
      cancelEpoch = owned.epoch;
      await appendFencedCancelEvent(eventStore, {
        featureId: input.featureId,
        cancelId,
        writerEpoch: cancelEpoch,
        type: 'cancel.requested',
        data: parsedRequest.data,
        idempotencyKey: cancellationKey(input.featureId, cancelId, 'requested'),
        operationId: `cancel:requested:${cancelId}`,
      });
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
          cancelProcess: {
            cancelId,
            phaseAttemptId,
            writerEpoch: cancelEpoch,
            instanceId: cancelInstanceId,
            maxAttempts: CANCEL_MAX_ATTEMPTS,
          },
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
    // Surface manual-intervention explicitly (P04-02): retry-exhausted actions
    // are a real, queryable terminal state, not a silently swallowed failure.
    let manualNote = '';
    if (useEventFirst) {
      const saga = await queryCancelSaga(eventStore, input.featureId, cancelId);
      const manual = manualInterventionActions(saga);
      if (manual.length > 0) {
        manualNote =
          ` Manual intervention required for: ${manual.map((a) => a.actionId).join(', ')}`;
      }
    }
    return {
      success: false,
      error: {
        code: ErrorCode.COMPENSATION_PARTIAL,
        message: `Compensation partially failed: ${failedActions.map((a) => a.message).join('; ')}.${manualNote}`,
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
          type: externalType as import('../events/schemas.js').EventType,
          data: { ...event.metadata, featureId: input.featureId },
        });
      }
    } catch {
      // V1 legacy: external store is supplementary.
    }
  }

  if (useEventFirst) {
    // ── Completion gate (P04-02) ─────────────────────────────────────────
    // `buildCancelReadiness` is the SOLE constructor of a `cancel.ready` proof:
    // it folds the durable log and refuses unless EVERY required compensation
    // has a durably-recorded success. Reporting cancellation complete before all
    // outcomes are recorded is therefore structurally impossible, not merely
    // avoided by convention.
    const saga = await queryCancelSaga(eventStore, input.featureId, cancelId);
    const requiredActionIds = compensationResult.actions.map((a) => a.actionId);
    const provenance = trustedCancellationProvenance(stateDir);
    const caller = provenance.caller as Record<string, unknown>;
    const authorization = provenance.authorization as Record<string, unknown> | undefined;
    const readiness = buildCancelReadiness(saga, requiredActionIds, {
      featureId: input.featureId,
      cancelId,
      phaseAttemptId,
      evidenceId: `cancel-ready:${phaseAttemptId}`,
      caller,
      ...(authorization !== undefined ? { authorization } : {}),
    });
    if (!readiness.ok) {
      const manual = manualInterventionActions(saga);
      const blockedReason =
        readiness.plan.kind === 'blocked' ? readiness.plan.reason : 'unrecorded-outcome';
      const blockedPending =
        readiness.plan.kind === 'blocked' ? readiness.plan.pendingActionIds : requiredActionIds;
      const message =
        blockedReason === 'manual-intervention-required'
          ? `Cancellation requires manual intervention for: ${
              manual.map((a) => a.actionId).join(', ') || blockedPending.join(', ')
            }`
          : 'Cancellation readiness requires a durable outcome for every compensation action';
      return {
        success: false,
        error: { code: ErrorCode.COMPENSATION_PARTIAL, message },
      };
    }
    try {
      await appendFencedCancelEvent(eventStore, {
        featureId: input.featureId,
        cancelId,
        writerEpoch: cancelEpoch,
        type: 'cancel.ready',
        data: readiness.data,
        idempotencyKey: cancellationKey(input.featureId, cancelId, 'ready'),
        operationId: `cancel:ready:${cancelId}`,
      });
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

  // ─── Phase mutation — the SINGLE guarded primitive (DR-7 / INV-9) ─────
  //
  // Characterized bypass this replaces: cancel called `executeTransition`
  // directly (cancel.ts:367), so the cancellation phase mutation ran with no
  // guard dispatch and no shadow observation. `allowUniversalFinalTransition`
  // admits the universal `cancelled` edge, which carries no explicit HSM
  // definition and is exactly why the bypass existed.
  mutableState._pendingPhaseAttemptId = phaseAttemptId;
  const attempt = await hsmTransitionGuard.attempt(
    input.featureId,
    currentPhase,
    'cancelled',
    {
      state: mutableState,
      workflowType: state.workflowType,
      // Pure evaluation — this handler owns emission so the cancellation
      // trail commits atomically below.
      eventStore: null,
      allowUniversalFinalTransition: true,
      // The same live shadow observer `tools.ts` wires onto the guarded
      // transition path. DR-23 / T-31: the guard context is in pure-evaluation
      // mode (`eventStore: null`) because THIS handler owns authoritative
      // emission — but the shadow evidence is a separate, non-authoritative
      // stream, so the observer is handed this handler's real store rather than
      // the (deliberately null) context one.
      shadowObserver: (observation) =>
        recordLiveTransition(observation, mutableState, eventStore),
    },
  );

  if (!attempt.ok) {
    return {
      success: false,
      error: {
        code:
          attempt.errorCode === 'CIRCUIT_OPEN'
            ? ErrorCode.CIRCUIT_OPEN
            : attempt.errorCode === 'PHASE_BLOCKED'
              ? ErrorCode.PHASE_BLOCKED
              : attempt.errorCode === 'INVALID_TRANSITION'
                ? ErrorCode.INVALID_TRANSITION
                : ErrorCode.GUARD_FAILED,
        message: attempt.errorMessage,
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

  // Event-first: emit to external event store BEFORE mutating state.
  //
  // DR-7, third criterion — the cancellation trail (HSM lifecycle events +
  // the explicit `workflow.cancel` event) commits in ONE atomic transaction.
  // It was previously a sequential `append` loop, so a failure after event k
  // left a PARTIAL cancellation trail durably on the stream.
  if (eventStore) {
    const cancelTrail = [
      ...attempt.emittedEvents.map((transitionEvent) => ({
        type: mapInternalToExternalType(transitionEvent.type) as import('../events/schemas.js').EventType,
        data: {
          from: transitionEvent.from,
          to: transitionEvent.to,
          trigger: transitionEvent.trigger,
          featureId: input.featureId,
          ...(transitionEvent.metadata ?? {}),
        },
        idempotencyKey: `${input.featureId}:cancel:transition:${transitionEvent.type}:${transitionEvent.from}:cancelled`,
      })),
      {
        type: mapInternalToExternalType('cancel') as import('../events/schemas.js').EventType,
        data: {
          from: currentPhase,
          to: 'cancelled',
          trigger: 'user-cancel',
          featureId: input.featureId,
          ...cancelMetadata,
        },
        idempotencyKey: `${input.featureId}:cancel:complete`,
      },
    ];
    // `phaseAttemptId` is retry-stable, so the operation id is stable across
    // retries of the SAME cancellation.
    const cancelTrailOperationId = `cancel:${input.featureId}:${phaseAttemptId}`;
    if (useEventFirst) {
      // ES v2: event-first — propagate errors, abort cancel if append fails
      try {
        await eventStore.appendTrailAtomically(
          input.featureId,
          cancelTrail,
          cancelTrailOperationId,
        );
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
        await eventStore.appendTrailAtomically(
          input.featureId,
          cancelTrail.map(({ idempotencyKey: _dropped, ...event }) => event),
          `${cancelTrailOperationId}:legacy`,
        );
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
  if (Object.keys(attempt.historyUpdates).length > 0) {
    const history = { ...(mutableState._history as Record<string, string>) };
    for (const [key, value] of Object.entries(attempt.historyUpdates)) {
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

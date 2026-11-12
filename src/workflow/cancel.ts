import type {
  CancelInput,
  WorkflowState,
} from './types.js';
import { ErrorCode } from './schemas.js';
import {
  readStateFile,
  writeStateFile,
  StateStoreError,
  VersionConflictError,
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
import { decide } from './decide/decide.js';
import { compileDecideDefinition, type DecideDefinition } from './decide/edges.js';
import { phaseMoveEvents, type TransitionEvent } from './decide/emit.js';
import { builtInDefinition, isBuiltInDefinitionType } from './definitions/built-in.js';
import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';
import { foldGuardInput } from '../projections/guard-input/fold.js';
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

const CURRENT_ES_VERSION = 2;

/** The type of the row that starts a workflow stream. */
const START_ROW_TYPE = 'workflow.started';

/** The text that starts the warning of a cancel that the state document decided. */
const DOCUMENT_FALLBACK_WARNING = 'GUARD_INPUT_DOCUMENT_FALLBACK';

/** The most writes of the document level of an idempotent cancel. A conflict reads the document again. */
const MAX_LEVEL_WRITES = 4;

/**
 * The route of one cancel. The fold route decides on the ledger fold of the rows of a built-in type.
 * The document route keeps the path of the state document, with the warnings of a fallback.
 */
type CancelRoute =
  | {
      readonly kind: 'fold';
      readonly def: DecideDefinition;
      /** The guard input of the fold, with no phase attempt id. */
      readonly input: Readonly<Record<string, unknown>>;
      readonly from: string;
      /** The phase attempt id of the fold, the predecessor of the move. */
      readonly foldAttemptId: string | undefined;
      /** The highest sequence of the rows. */
      readonly version: number;
    }
  | { readonly kind: 'document'; readonly warnings: readonly string[] };

/** Returns the message of a thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Returns the highest sequence of the rows, or 0 when the rows are empty. */
function highestSequence(rows: readonly WorkflowEvent[]): number {
  return rows.reduce((highest, row) => Math.max(highest, row.sequence), 0);
}

/** Returns the document route with one fallback warning that names the reason. */
function documentFallback(reason: string): CancelRoute {
  return {
    kind: 'document',
    warnings: [`${DOCUMENT_FALLBACK_WARNING}: the state document decided this cancel, because ${reason}.`],
  };
}

/**
 * Picks the route of a cancel. A type that is not a built-in type keeps the document route with no warning.
 * A built-in type decides on the fold when the store holds its rows: an event store, a document on the ledger and a start row.
 * Otherwise the document decides, and the route carries one fallback warning. A failed read or fold of the rows also gives
 * the document route, because a cancel reads no guard condition.
 */
async function cancelRouteOf(state: WorkflowState, featureId: string, eventStore: EventStore | null): Promise<CancelRoute> {
  const workflowType = state.workflowType;
  if (!isBuiltInDefinitionType(workflowType)) return { kind: 'document', warnings: [] };
  if (eventStore === null || eventStore === undefined) return documentFallback('no event store is open');
  if (state._esVersion !== CURRENT_ES_VERSION) return documentFallback('the state document is not on the ledger');
  try {
    const rows = await eventStore.query(featureId);
    if (!rows.some((row) => row.type === START_ROW_TYPE)) return documentFallback('the stream holds no start row');
    const input = foldGuardInput(rows);
    return {
      kind: 'fold',
      def: compileDecideDefinition(workflowType, builtInDefinition(workflowType), []),
      input,
      from: typeof input.phase === 'string' ? input.phase : '',
      foldAttemptId: readPhaseAttemptId(input),
      version: highestSequence(rows),
    };
  } catch (err) {
    return documentFallback(`the ledger fold failed: ${messageOf(err)}`);
  }
}

/** Puts the warnings of a route before the warnings of a result. A route with no warning returns the result unchanged. */
function withRouteWarnings(result: ToolResult, route: CancelRoute): ToolResult {
  if (route.kind === 'fold' || route.warnings.length === 0) return result;
  return { ...result, warnings: [...route.warnings, ...(result.warnings ?? [])] };
}

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

/**
 * Cancel a workflow: run compensation, then move the phase to `cancelled`.
 * The event-first path needs an ES v2 state and a store. It takes ownership under a fencing epoch before it
 * records intent, and only `buildCancelReadiness` makes the `cancel.ready` proof.
 *
 * A built-in type with a store, a ledger document and a start row decides on the ledger fold.
 * The fold gives the source phase, the phase attempt id and the terminal check, and `phaseMoveEvents` gives the trail.
 * The fallback cases and a failed fold keep the path of the state document with one warning.
 * A custom type keeps that path with no warning. The trail commits atomically before the state write.
 */
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

  const route = await cancelRouteOf(state, input.featureId, eventStore);
  return withRouteWarnings(await cancelOnRoute(input, stateDir, eventStore, stateFile, state, route), route);
}

/**
 * Levels a document that lags behind a fold at `cancelled`, and replies `idempotent: true` with no row.
 * The level writes the phase and the attempt id of the fold, the checkpoint reset and the event sequence of
 * the rows. A version conflict reads the document again, and a document that reached `cancelled` needs no write.
 */
async function levelCancelledDocument(
  stateFile: string,
  state: WorkflowState,
  route: Extract<CancelRoute, { kind: 'fold' }>,
): Promise<ToolResult> {
  const previousPhase = state.phase;
  let current = state;
  for (let write = 1; write <= MAX_LEVEL_WRITES; write++) {
    if (current.phase === 'cancelled') break;
    const checkpoint = resetCounter(current._checkpoint, 'cancelled', 'Workflow cancelled');
    const levelled: WorkflowState = {
      ...current,
      phase: 'cancelled',
      _checkpoint: checkpoint,
      _eventSequence: route.version,
      updatedAt: new Date().toISOString(),
    };
    if (route.foldAttemptId !== undefined) levelled.phaseAttemptId = route.foldAttemptId;
    try {
      await writeStateFile(stateFile, levelled, { expectedVersion: current._version ?? 1 });
      return idempotentCancelReply(previousPhase, route, checkpoint);
    } catch (err) {
      if (!(err instanceof VersionConflictError) || write === MAX_LEVEL_WRITES) throw err;
      current = await readStateFile(stateFile);
    }
  }
  return idempotentCancelReply(previousPhase, route, current._checkpoint);
}

/** The reply of a cancel whose fold is at `cancelled`. Its data fits the cancelled arm of the cancel output schema. */
function idempotentCancelReply(
  previousPhase: string,
  route: Extract<CancelRoute, { kind: 'fold' }>,
  checkpoint: WorkflowState['_checkpoint'],
): ToolResult {
  return {
    success: true,
    data: {
      phase: 'cancelled',
      actions: [],
      previousPhase,
      phaseAttemptId: route.foldAttemptId ?? '',
      idempotent: true,
    },
    _meta: buildCheckpointMeta(checkpoint),
  };
}

/** The events of an admitted cancel move and the history that the move records. */
interface CancelMove {
  readonly events: readonly TransitionEvent[];
  readonly historyUpdates: Readonly<Record<string, string>>;
}

/**
 * Decides the cancel move on the fold. The legacy guard runs on the same input with no store, so it feeds
 * only the admission live shadow and the message of a refusal. A throw of the legacy guard changes nothing.
 */
async function decideCancelOnTheFold(
  featureId: string,
  route: Extract<CancelRoute, { kind: 'fold' }>,
  phaseAttemptId: string,
  eventStore: EventStore | null,
): Promise<{ readonly ok: true; readonly move: CancelMove } | { readonly ok: false; readonly result: ToolResult }> {
  const input: Record<string, unknown> = { ...route.input, _pendingPhaseAttemptId: phaseAttemptId };
  let legacyMessage: string | undefined;
  try {
    const legacy = await hsmTransitionGuard.attempt(featureId, route.from, 'cancelled', {
      state: input,
      workflowType: route.def.workflowType,
      eventStore: null,
      allowUniversalFinalTransition: true,
      shadowObserver: (observation) => recordLiveTransition(observation, input, eventStore),
    });
    if (!legacy.ok) legacyMessage = legacy.errorMessage;
  } catch {
    legacyMessage = undefined;
  }
  const outcome = decide(route.def, input, { kind: 'cancel' });
  if (outcome.kind !== 'admit') {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          code: ErrorCode.INVALID_TRANSITION,
          message: legacyMessage ?? `No transition from '${route.from}' to 'cancelled'`,
        },
      },
    };
  }
  const moved = phaseMoveEvents(route.def, input, outcome.move);
  if (!moved.success) {
    return {
      ok: false,
      result: {
        success: false,
        error: {
          code: moved.errorCode === 'PHASE_BLOCKED' ? ErrorCode.PHASE_BLOCKED : ErrorCode.GUARD_FAILED,
          message: moved.errorMessage ?? legacyMessage ?? `The cancel of '${featureId}' did not move the phase`,
        },
      },
    };
  }
  return { ok: true, move: { events: moved.events, historyUpdates: { ...(moved.historyUpdates ?? {}) } } };
}

/** Runs one cancel on its route. The caller adds the warnings of the route. */
async function cancelOnRoute(
  input: CancelInput,
  stateDir: string,
  eventStore: EventStore | null,
  stateFile: string,
  state: WorkflowState,
  route: CancelRoute,
): Promise<ToolResult> {
  const terminalPhase = route.kind === 'fold' ? route.from : state.phase;
  if (terminalPhase === 'cancelled') {
    if (route.kind === 'fold' && state.phase !== 'cancelled') {
      return levelCancelledDocument(stateFile, state, route);
    }
    return {
      success: false,
      error: {
        code: ErrorCode.ALREADY_CANCELLED,
        message: `Workflow '${input.featureId}' is already cancelled`,
      },
    };
  }

  const mutableState = structuredClone(state) as Record<string, unknown>;
  const currentPhase = route.kind === 'fold' ? route.from : state.phase;
  const dryRun = input.dryRun ?? false;
  const phaseAttemptId = allocatePhaseAttemptId(
    input.featureId,
    currentPhase,
    'cancelled',
    route.kind === 'fold' ? route.foldAttemptId : readPhaseAttemptId(state),
    route.kind === 'fold' ? route.version : (state._version ?? 1),
  );
  const cancelId = `cancel:${phaseAttemptId}`;
  const useEventFirst =
    isEventSourced(mutableState) && eventStore !== null && eventStore !== undefined;

  const existingCheckpoint = mutableState._compensationCheckpoint as CompensationCheckpoint | undefined;

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

  if (!compensationResult.success) {
    if (!useEventFirst) {
      mutableState._compensationCheckpoint = compensationResult.checkpoint;
      mutableState.updatedAt = new Date().toISOString();
      await writeStateFile(stateFile, mutableState as WorkflowState);
    }

    const failedActions = compensationResult.actions.filter((a) => a.status === 'failed');
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
    }
  }

  if (useEventFirst) {
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

  mutableState._pendingPhaseAttemptId = phaseAttemptId;
  let move: CancelMove;
  if (route.kind === 'fold') {
    const decided = await decideCancelOnTheFold(input.featureId, route, phaseAttemptId, eventStore);
    if (!decided.ok) return decided.result;
    move = decided.move;
  } else {
    const attempt = await hsmTransitionGuard.attempt(
      input.featureId,
      currentPhase,
      'cancelled',
      {
        state: mutableState,
        workflowType: state.workflowType,
        eventStore: null,
        allowUniversalFinalTransition: true,
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
    move = { events: attempt.emittedEvents, historyUpdates: attempt.historyUpdates };
  }

  const cancelMetadata: Record<string, unknown> = {};
  if (input.reason) {
    cancelMetadata.reason = input.reason;
  }
  cancelMetadata.compensationActions = compensationResult.actions.length;
  cancelMetadata.compensationSuccess = compensationResult.success;
  cancelMetadata.phaseAttemptId = phaseAttemptId;

  if (eventStore) {
    const cancelTrail = [
      ...move.events.map((transitionEvent) => ({
        type: mapInternalToExternalType(transitionEvent.type) as import('../events/schemas.js').EventType,
        correlationId: input.featureId,
        source: 'workflow',
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
        correlationId: input.featureId,
        source: 'workflow',
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
    const cancelTrailOperationId = `cancel:${input.featureId}:${phaseAttemptId}`;
    if (useEventFirst) {
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
      try {
        await eventStore.appendTrailAtomically(
          input.featureId,
          cancelTrail.map(({ idempotencyKey: _dropped, ...event }) => event),
          `${cancelTrailOperationId}:legacy`,
        );
      } catch {
      }
    }
  }

  mutableState.phase = 'cancelled';
  mutableState.phaseAttemptId = phaseAttemptId;
  delete mutableState._pendingPhaseAttemptId;

  if (Object.keys(move.historyUpdates).length > 0) {
    const history = { ...(mutableState._history as Record<string, string>) };
    for (const [key, value] of Object.entries(move.historyUpdates)) {
      history[key] = value;
    }
    mutableState._history = history;
  }

  mutableState._checkpoint = resetCounter(
    mutableState._checkpoint as WorkflowState['_checkpoint'],
    'cancelled',
    'Workflow cancelled',
  );

  mutableState.updatedAt = new Date().toISOString();

  const checkpoint = mutableState._checkpoint as Record<string, unknown>;
  checkpoint.lastActivityTimestamp = new Date().toISOString();

  delete mutableState._compensationCheckpoint;

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

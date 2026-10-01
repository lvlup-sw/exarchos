import { buildValidatedEvent } from '../../events/event-factory.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import { workflowLogger } from '../../logger.js';
import { recordLiveTransition } from '../admission/live-shadow-observer.js';
import { buildCheckpointMeta, type CheckpointEnforcementConfig, incrementOperations, resetCounter, shouldEnforceCheckpoint } from '../checkpoint.js';
import { hsmTransitionGuard } from '../hsm-transition-guard.js';
import { allocatePhaseAttemptId, readPhaseAttemptId } from '../phase-attempt-id.js';
import { resolveGateSet } from '../phase-kind.js';
import { ErrorCode } from '../schemas.js';
import { applyDotPath, hydrateEventsFromStore, readStateFile, StateStoreError, validateStateForWrite, VersionConflictError, writeStateFile } from '../state-store.js';
import type { SetInput, WorkflowState } from '../types.js';
import { resolveBoundaryTouching, resolveRiskTier } from '../verification-policy-resolver.js';
import * as path from 'node:path';
import { CURRENT_ES_VERSION, isEventSourced } from './shared.js';

/**
 * The CAS retry limit. A retry re-reads the state and gets a new `expectedVersion`.
 * Thus a retry that appends `state.patched` adds a second event and does not collapse onto the first.
 * After the last retry, the handler appends `workflow.cas-failed` to an event store on a best-effort basis and rethrows.
 */
const MAX_CAS_RETRIES = 3;

/**
 * Updates fields, transitions the phase, or both, on a workflow state file.
 * It applies field updates to a copy first, so the phase guards see the new state.
 * The guard also gets the prior state, so an update to the risk tier cannot weaken its own transition.
 * A no-op self-transition without updates returns `idempotent: true` and writes nothing.
 *
 * Events go to the store before the state write. A failed transition or patch append returns `EVENT_APPEND_FAILED` and writes nothing.
 * For an event-sourced workflow with field updates and an event store, the handler validates the new state, then appends `state.patched`.
 * Its idempotency key holds `expectedVersion` and the field names, not the values.
 * Thus two patches to the same fields at one version collide, and the store drops the second.
 *
 * The handler does not rebuild the state file from the fold, because the fold can give a state that fails the schema.
 */
export async function handleSet(
  input: SetInput,
  stateDir: string,
  eventStore: EventStore | null,
  options?: {
    skipPhases?: readonly string[];
    /**
     * The review dimensions for the `allReviewsPassed` guard. An explicit value, even `[]`, wins.
     * Else the handler uses the REVIEW gate set for the risk tier of the updated state.
     */
    requiredReviews?: readonly string[];
    /**
     * When set, a phase transition above the checkpoint threshold returns `CHECKPOINT_REQUIRED`.
     * The handler appends `checkpoint.enforced` or `checkpoint.state_missing` to an event store on a best-effort basis.
     */
    checkpoint?: CheckpointEnforcementConfig;
    /**
     * The plan-revision cap for the pure `revisionsExhausted` guard.
     * The handler injects it as `_maxPlanRevisions` and deletes it before the write.
     * A config threshold is not a fact, so the handler does not persist it.
     */
    maxPlanRevisions?: number;
    /**
     * The mutation enforcement mode and threshold for the score check of `allReviewsPassed`.
     * The handler injects them at high risk tier only, and deletes them before the write.
     */
    mutationEnforcement?: 'block' | 'advisory';
    mutationThreshold?: number;
    /**
     * The NoCoverage budget for `allReviewsPassed`. The handler injects it at high risk tier only.
     * It injects only a non-negative integer, and deletes it before the write.
     */
    maxNoCoverage?: number;
  },
): Promise<ToolResult> {
  const stateFile = path.join(stateDir, `${input.featureId}.state.json`);
  let transitionPhaseAttemptId: string | undefined;

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

    if (input.phase && options?.checkpoint) {
      const gateResult = shouldEnforceCheckpoint(
        state._checkpoint,
        options.checkpoint,
        'phase-transition',
      );

      if (gateResult.warning === 'checkpoint-state-missing' && eventStore) {
        try {
          const validatedEvent = buildValidatedEvent(input.featureId, 1, {
            type: 'checkpoint.state_missing' as import('../../events/schemas.js').EventType,
            correlationId: input.featureId,
            source: 'workflow',
            data: { action: 'set' },
          });
          await eventStore.appendValidated(input.featureId, validatedEvent);
        } catch {
        }
      }

      if (gateResult.gated) {
        if (eventStore) {
          try {
            const validatedEvent = buildValidatedEvent(input.featureId, 1, {
              type: 'checkpoint.enforced' as import('../../events/schemas.js').EventType,
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

    const expectedVersion = state._version ?? 1;

    const mutableState = structuredClone(state) as Record<string, unknown>;

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

    if (input.phase) {
      if (options?.requiredReviews !== undefined) {
        mutableState._requiredReviews = options.requiredReviews;
      } else {
        const workflowType = state.workflowType as string;
        const resolvedTier = resolveRiskTier(mutableState.riskTier);
        const boundaryTouching = resolveBoundaryTouching(mutableState.boundaryTouching);
        const typeDefaults = resolveGateSet('REVIEW', {
          riskTier: resolvedTier,
          boundaryTouching,
          workflowType,
        }).flatMap((g) => (g.family === 'review' ? [g.gate] : []));
        if (typeDefaults.length) {
          mutableState._requiredReviews = typeDefaults;
        }
      }

      if (
        typeof options?.maxPlanRevisions === 'number' &&
        Number.isFinite(options.maxPlanRevisions)
      ) {
        mutableState._maxPlanRevisions = options.maxPlanRevisions;
      }

      if (resolveRiskTier(mutableState.riskTier) === 'high') {
        if (options?.mutationEnforcement !== undefined) {
          mutableState._mutationEnforcement = options.mutationEnforcement;
        }
        if (
          typeof options?.mutationThreshold === 'number' &&
          Number.isFinite(options.mutationThreshold)
        ) {
          mutableState._mutationThreshold = options.mutationThreshold;
        }
        if (
          typeof options?.maxNoCoverage === 'number' &&
          Number.isInteger(options.maxNoCoverage) &&
          options.maxNoCoverage >= 0
        ) {
          mutableState._maxNoCoverage = options.maxNoCoverage;
        }
      }
    }

    if (input.phase && eventStore) {
      try {
        mutableState._events = await hydrateEventsFromStore(
          input.featureId, eventStore,
        );
      } catch {
        mutableState._events = mutableState._events ?? [];
      }
    } else if (input.phase && !eventStore) {
      workflowLogger.warn(
        { featureId: input.featureId },
        'eventStore unavailable during phase transition — _events will not be hydrated, guards may fail',
      );
    }

    let pendingTransitionEventsCount = 0;
    let transitionTopSequence: number | undefined;

    if (input.phase) {
      const fromPhase = state.phase;
      if (fromPhase !== input.phase && transitionPhaseAttemptId === undefined) {
        transitionPhaseAttemptId = allocatePhaseAttemptId(
          input.featureId,
          fromPhase,
          input.phase,
          readPhaseAttemptId(state),
          expectedVersion,
        );
      }
      if (transitionPhaseAttemptId !== undefined) {
        mutableState._pendingPhaseAttemptId = transitionPhaseAttemptId;
      }
      let attemptResult;
      try {
        attemptResult = await hsmTransitionGuard.attempt(
          input.featureId,
          fromPhase,
          input.phase,
          {
            state: mutableState,
            priorState: state as unknown as Record<string, unknown>,
            workflowType: state.workflowType as string,
            skipPhases: options?.skipPhases,
            idempotencyKeySuffix: String(expectedVersion),
            eventStore,
            shadowObserver: (observation, observerEventStore) =>
              recordLiveTransition(observation, mutableState, observerEventStore),
          },
        );
      } catch (err) {
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

      if (attemptResult.idempotent && !input.updates) {
        return {
          success: true,
          data: {
            phase: state.phase,
            updatedAt: state.updatedAt,
            idempotent: true,
            phaseAttemptId: readPhaseAttemptId(state),
          },
          _meta: buildCheckpointMeta(state._checkpoint),
        };
      }

      if (!attemptResult.idempotent) {
        mutableState.phase = attemptResult.newPhase;
        mutableState.phaseAttemptId = transitionPhaseAttemptId;

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

        mutableState._checkpoint = resetCounter(
          mutableState._checkpoint as WorkflowState['_checkpoint'],
          attemptResult.newPhase,
        );

        pendingTransitionEventsCount = attemptResult.emittedEvents.length;
        if (attemptResult.transitionEvent.sequence > 0) {
          transitionTopSequence = attemptResult.transitionEvent.sequence;
        }
      }

      delete mutableState._requiredReviews;
      delete mutableState._maxPlanRevisions;
      delete mutableState._mutationEnforcement;
      delete mutableState._mutationThreshold;
      delete mutableState._maxNoCoverage;
      delete mutableState._pendingPhaseAttemptId;
    }

    let highestEventSequence: number | undefined = transitionTopSequence;

    const updateKeys = input.updates ? Object.keys(input.updates) : [];
    if (
      isEventSourced(state)
      && eventStore
      && updateKeys.length > 0
    ) {
      const invalid = validateStateForWrite(mutableState as WorkflowState);
      if (invalid !== undefined) {
        return { success: false, error: { code: ErrorCode.INVALID_INPUT, message: invalid } };
      }

      try {
        const fieldsHash = [...updateKeys].sort().join(',');
        const idempotencyKey = `${input.featureId}:patch:${expectedVersion}:${fieldsHash}`;
        const validatedEvent = buildValidatedEvent(input.featureId, 1, {
          type: 'state.patched' as import('../../events/schemas.js').EventType,
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
        return {
          success: false,
          error: {
            code: ErrorCode.EVENT_APPEND_FAILED,
            message: `Event append failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    }

    if (highestEventSequence !== undefined) {
      mutableState._eventSequence = highestEventSequence;
    }

    mutableState._checkpoint = incrementOperations(
      mutableState._checkpoint as WorkflowState['_checkpoint'],
    );

    mutableState.updatedAt = new Date().toISOString();

    const checkpoint = mutableState._checkpoint as Record<string, unknown>;
    checkpoint.lastActivityTimestamp = new Date().toISOString();

    try {
      await writeStateFile(stateFile, mutableState as WorkflowState, { expectedVersion });
      (mutableState as Record<string, unknown>)._version = expectedVersion + 1;
    } catch (err) {
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
        continue;
      }

      if (err instanceof VersionConflictError && eventStore) {
        try {
          const validatedEvent = buildValidatedEvent(input.featureId, 1, {
            type: 'workflow.cas-failed' as import('../../events/schemas.js').EventType,
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
        }
      }

      throw err;
    }


    return {
      success: true,
      data: {
        phase: mutableState.phase as string,
        workflowType: mutableState.workflowType as string,
        updatedAt: mutableState.updatedAt as string,
        phaseAttemptId: mutableState.phaseAttemptId as string,
      },
      _meta: buildCheckpointMeta(mutableState._checkpoint as WorkflowState['_checkpoint']),
    };
  }

  throw new StateStoreError(
    ErrorCode.VERSION_CONFLICT,
    `Concurrent write conflict: failed to acquire consistent version after ${MAX_CAS_RETRIES} retries for feature: ${input.featureId}, phase: ${input.phase ?? 'field-update'}`,
  );
}

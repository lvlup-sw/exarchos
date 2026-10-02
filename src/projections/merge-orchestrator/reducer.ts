/**
 * `merge-orchestrator@v1` projection reducer.
 *
 * It folds the `merge.*` events of a feature stream into the {@link MergeOrchestratorState} phase machine in `types.ts`.
 * Each state change is an event, and each state read is a fold over the durable event log.
 * Writers emit only `merge.recovered` for recovery. The reducer also folds the retired `merge.rollback`, so old logs replay to the same state.
 * `apply` is pure and does not mutate its `state` argument.
 */
import type { ProjectionReducer } from '../types.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import {
  initialMergeOrchestratorState,
  type MergeActionMetadata,
  type MergeOrchestratorState,
  type MergePreflightMetadata,
  type MergeRecoveryContext,
} from './types.js';

function extractString(
  data: WorkflowEvent['data'],
  key: string,
): string | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function extractBoolean(
  data: WorkflowEvent['data'],
  key: string,
): boolean | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'boolean' ? raw : undefined;
}

function extractNumber(
  data: WorkflowEvent['data'],
  key: string,
): number | undefined {
  if (!data) return undefined;
  const raw = data[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Reads the `strategy` enum from `data`.
 * It returns `undefined` for a missing or unknown value, so the metadata never holds a value outside the enum.
 */
function extractStrategy(
  data: WorkflowEvent['data'],
): MergeActionMetadata['strategy'] | undefined {
  const raw = extractString(data, 'strategy');
  if (raw === 'squash' || raw === 'rebase' || raw === 'merge') return raw;
  return undefined;
}

/**
 * Reads the `recoveryError` enum from a recovery event.
 * It returns `undefined` for a missing or unknown value, so the projection never holds a value outside the enum.
 */
function extractRecoveryError(
  data: WorkflowEvent['data'],
): MergeRecoveryContext['recoveryError'] | undefined {
  const raw = extractString(data, 'recoveryError');
  if (
    raw === 'reset-keep-blocked' ||
    raw === 'reset-failed' ||
    raw === 'unexpected-mid-merge-drift'
  )
    return raw;
  return undefined;
}

/**
 * Joins the `failureReasons` strings of a `merge.preflight` event into one comma-separated reason.
 * When the array has no reason, it uses the flat `reason` string that some emitters write.
 */
function extractPreflightReason(
  data: WorkflowEvent['data'],
): string | undefined {
  if (!data) return undefined;
  const reasons = data['failureReasons'];
  if (Array.isArray(reasons)) {
    const strs = reasons.filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    if (strs.length > 0) return strs.join(', ');
  }
  return extractString(data, 'reason');
}

/**
 * Handles `merge.preflight`: records the gate outcome and moves the phase to `preflight`.
 * A missing `passed` flag counts as `false`, so a malformed event records a failed preflight and never an invented pass.
 * It also copies the branch fields when the event has them.
 */
function applyMergePreflight(
  state: MergeOrchestratorState,
  event: WorkflowEvent,
): MergeOrchestratorState {
  const passed = extractBoolean(event.data, 'passed') ?? false;
  const reason = passed ? undefined : extractPreflightReason(event.data);
  const preflight: MergePreflightMetadata = passed
    ? { passed: true }
    : reason !== undefined
      ? { passed: false, reason }
      : { passed: false };
  const merge = mergeFromEvent(state.merge, event);
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'preflight',
    preflight,
    ...(merge !== state.merge ? { merge } : {}),
  };
}

/**
 * Handles `merge.requested`, the durable intent to merge.
 * It records the merge fields and moves the phase to `requested`, between `preflight` and `executed`.
 */
function applyMergeRequested(
  state: MergeOrchestratorState,
  event: WorkflowEvent,
): MergeOrchestratorState {
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'requested',
    merge: mergeFromEvent(state.merge, event),
  };
}

/**
 * Handles `merge.executed`: records the merge outcome and moves the phase to `executed`.
 * It keeps the earlier merge fields.
 */
function applyMergeExecuted(
  state: MergeOrchestratorState,
  event: WorkflowEvent,
): MergeOrchestratorState {
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'executed',
    merge: mergeFromEvent(state.merge, event),
  };
}

/**
 * Handles `merge.recovered` and the retired `merge.rollback`: any phase moves to `recovering`.
 * It records `reason`, `recoveryError` and the `rollbackError` detail. It does not overwrite the earlier merge metadata.
 * Only `merge.rollback` has `rollbackError`. This handler does not read `recoveryErrorDetail`, the detail field of `merge.recovered`.
 */
function applyMergeRollback(
  state: MergeOrchestratorState,
  event: WorkflowEvent,
): MergeOrchestratorState {
  const reason = extractString(event.data, 'reason');
  const error = extractString(event.data, 'rollbackError');
  const recoveryError = extractRecoveryError(event.data);
  const recovery: MergeRecoveryContext = {
    ...(reason !== undefined ? { reason } : {}),
    ...(recoveryError !== undefined ? { recoveryError } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'recovering',
    ...(Object.keys(recovery).length > 0 ? { recovery } : {}),
  };
}

/**
 * Handles `merge.completed`, the terminal transition.
 * It keeps all earlier metadata, so the final state is a full record of the lifecycle.
 */
function applyMergeCompleted(
  state: MergeOrchestratorState,
  _event: WorkflowEvent,
): MergeOrchestratorState {
  return {
    ...state,
    projectionSequence: state.projectionSequence + 1,
    phase: 'completed',
  };
}

/**
 * Folds the merge fields of an event into a new {@link MergeActionMetadata} record.
 * A field in the event overwrites the old value. An absent field keeps the old value.
 * When the event has no merge field, it returns `existing` unchanged.
 */
function mergeFromEvent(
  existing: MergeActionMetadata | undefined,
  event: WorkflowEvent,
): MergeActionMetadata | undefined {
  const taskId = extractString(event.data, 'taskId');
  const sourceBranch = extractString(event.data, 'sourceBranch');
  const targetBranch = extractString(event.data, 'targetBranch');
  const strategy = extractStrategy(event.data);
  const prNumber = extractNumber(event.data, 'prNumber');
  const mergeSha = extractString(event.data, 'mergeSha');
  const rollbackSha = extractString(event.data, 'rollbackSha');

  const anyPresent =
    taskId !== undefined ||
    sourceBranch !== undefined ||
    targetBranch !== undefined ||
    strategy !== undefined ||
    prNumber !== undefined ||
    mergeSha !== undefined ||
    rollbackSha !== undefined;
  if (!anyPresent) return existing;

  return {
    ...(existing ?? {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(sourceBranch !== undefined ? { sourceBranch } : {}),
    ...(targetBranch !== undefined ? { targetBranch } : {}),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(mergeSha !== undefined ? { mergeSha } : {}),
    ...(rollbackSha !== undefined ? { rollbackSha } : {}),
  };
}

/**
 * The `merge-orchestrator@v1` reducer. The `./index.ts` barrel registers it with `defaultRegistry` on import.
 * An unknown event type returns `state` unchanged, so `projectionSequence` advances only for handled events.
 */
export const mergeOrchestratorReducer: ProjectionReducer<
  MergeOrchestratorState,
  WorkflowEvent
> = {
  id: 'merge-orchestrator@v1',
  version: 1,
  scope: 'stream' as const,
  initial: initialMergeOrchestratorState,
  apply(state: MergeOrchestratorState, event: WorkflowEvent): MergeOrchestratorState {
    switch (event.type) {
      case 'merge.preflight':
        return applyMergePreflight(state, event);
      case 'merge.requested':
        return applyMergeRequested(state, event);
      case 'merge.executed':
        return applyMergeExecuted(state, event);
      case 'merge.recovered':
      case 'merge.rollback':
        return applyMergeRollback(state, event);
      case 'merge.completed':
        return applyMergeCompleted(state, event);
      default:
        return state;
    }
  },
};

export type { MergeOrchestratorState } from './types.js';

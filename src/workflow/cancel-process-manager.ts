/**
 * Cancellation process manager: a replayable saga over the feature event log.
 *
 * Each step of a cancellation is a durable `cancel.*` event, and the manager holds
 * no in-memory state. `foldCancelSaga` rebuilds the saga from the log, so restart
 * and takeover reach the same decisions. A completed compensation is never issued again.
 *
 * Each owner gets a higher fencing epoch, and the epoch check runs in the same SQLite
 * transaction as the append. Only `buildCancelReadiness` makes the readiness proof.
 * Retries are bounded, and exhaustion escalates to `manual-intervention-required`.
 * The module owns the decisions, and a driver owns the effects.
 */
import { createHash } from 'node:crypto';
import type { EventStore } from '../events/store.js';
import type { EventInput } from '../events/atomic-appender.js';
import { buildValidatedEvent } from '../events/event-factory.js';
import {
  CancelCompensationCompletedData,
  CancelOwnershipAcquiredData,
  CancelReadyData,
  type EventType,
} from '../events/schemas.js';

/**
 * The minimal event shape that the fold reads. `WorkflowEvent` and
 * `DecideOnceStoredEvent` both satisfy it, so one fold enforces fencing after a
 * read and inside an atomic append.
 */
export interface FoldableCancelEvent {
  readonly type: string;
  readonly data?: Record<string, unknown> | undefined;
  readonly sequence?: number | undefined;
}

export type CompensationActionStatus =
  | 'pending'
  | 'intended'
  | 'succeeded'
  | 'failed'
  | 'manual-intervention';

export interface CompensationActionState {
  readonly actionId: string;
  readonly status: CompensationActionStatus;
  /** Count of `cancel.compensation-requested` — the number of attempts issued. */
  readonly attempts: number;
  /** Count of `cancel.compensation-failed` outcomes. */
  readonly failures: number;
  /** Count of `cancel.compensation-retry-scheduled`. */
  readonly retriesScheduled: number;
  readonly lastFailureReason?: CompensationFailureReason | undefined;
  readonly lastMessage?: string | undefined;
  /** Sequence of the durable `cancel.compensation-completed`, when present. */
  readonly completedSequence?: number | undefined;
}

export interface CancelSagaState {
  readonly cancelId: string | undefined;
  readonly requested: boolean;
  /** The highest fencing epoch in the log. It is 0 when no owner exists. */
  readonly currentEpoch: number;
  /** Instance id holding `currentEpoch`, when any. */
  readonly owner: string | undefined;
  /** True once a `cancel.ready` readiness proof is durably present. */
  readonly ready: boolean;
  readonly actions: ReadonlyMap<string, CompensationActionState>;
}

export type CompensationFailureReason = 'effect-failed' | 'malformed-result';

/**
 * The fencing guard rejected a write because the writer epoch is lower than the
 * epoch of the current owner.
 */
export class StaleEpochError extends Error {
  readonly code = 'CANCEL_STALE_EPOCH' as const;

  constructor(
    readonly writerEpoch: number,
    readonly currentEpoch: number,
    readonly cancelId: string | undefined,
  ) {
    super(
      `CANCEL_STALE_EPOCH: writer epoch ${writerEpoch} is fenced out by current owner epoch ${currentEpoch}`
        + (cancelId !== undefined ? ` (cancelId=${cancelId})` : ''),
    );
    this.name = 'StaleEpochError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(
  data: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readFailureReason(
  data: Record<string, unknown> | undefined,
): CompensationFailureReason | undefined {
  const value = data?.reason;
  return value === 'effect-failed' || value === 'malformed-result'
    ? value
    : undefined;
}

interface ActionAccumulator {
  requested: number;
  failures: number;
  retriesScheduled: number;
  completed: boolean;
  completedSequence: number | undefined;
  manual: boolean;
  lastFailureReason: CompensationFailureReason | undefined;
  lastMessage: string | undefined;
}

function deriveStatus(acc: ActionAccumulator): CompensationActionStatus {
  if (acc.completed) return 'succeeded';
  if (acc.manual) return 'manual-intervention';
  if (acc.failures > 0 && acc.failures >= acc.requested) return 'failed';
  if (acc.requested > 0) return 'intended';
  return 'pending';
}

/**
 * Rebuild the saga state from the event log. The fold is pure. An event without a
 * string `actionId` cannot advance an action. With a `cancelId`, the fold skips
 * events that name a different cancellation.
 */
export function foldCancelSaga(
  events: readonly FoldableCancelEvent[],
  cancelId?: string,
): CancelSagaState {
  const actions = new Map<string, ActionAccumulator>();
  let requested = false;
  let currentEpoch = 0;
  let owner: string | undefined;
  let ready = false;

  const upsert = (actionId: string): ActionAccumulator => {
    const existing = actions.get(actionId);
    if (existing !== undefined) return existing;
    const created: ActionAccumulator = {
      requested: 0,
      failures: 0,
      retriesScheduled: 0,
      completed: false,
      completedSequence: undefined,
      manual: false,
      lastFailureReason: undefined,
      lastMessage: undefined,
    };
    actions.set(actionId, created);
    return created;
  };

  for (const event of events) {
    if (!event.type.startsWith('cancel.')) continue;
    const data = asRecord(event.data);
    const eventCancelId = readString(data, 'cancelId');
    if (cancelId !== undefined && eventCancelId !== undefined && eventCancelId !== cancelId) {
      continue;
    }

    switch (event.type) {
      case 'cancel.requested':
        requested = true;
        break;
      case 'cancel.ownership-acquired': {
        const epoch = data?.epoch;
        if (typeof epoch === 'number' && epoch > currentEpoch) {
          currentEpoch = epoch;
          owner = readString(data, 'instanceId');
        }
        break;
      }
      case 'cancel.compensation-requested': {
        const actionId = readString(data, 'actionId');
        if (actionId !== undefined) upsert(actionId).requested += 1;
        break;
      }
      case 'cancel.compensation-completed': {
        const actionId = readString(data, 'actionId');
        if (actionId !== undefined) {
          const acc = upsert(actionId);
          acc.completed = true;
          if (typeof event.sequence === 'number') acc.completedSequence = event.sequence;
        }
        break;
      }
      case 'cancel.compensation-failed': {
        const actionId = readString(data, 'actionId');
        if (actionId !== undefined) {
          const acc = upsert(actionId);
          acc.failures += 1;
          acc.lastFailureReason = readFailureReason(data);
          acc.lastMessage = readString(data, 'message');
        }
        break;
      }
      case 'cancel.compensation-retry-scheduled': {
        const actionId = readString(data, 'actionId');
        if (actionId !== undefined) upsert(actionId).retriesScheduled += 1;
        break;
      }
      case 'cancel.manual-intervention-required': {
        const actionId = readString(data, 'actionId');
        if (actionId !== undefined) upsert(actionId).manual = true;
        break;
      }
      case 'cancel.ready':
        ready = true;
        break;
      default:
        break;
    }
  }

  const materialised = new Map<string, CompensationActionState>();
  for (const [actionId, acc] of actions) {
    materialised.set(actionId, {
      actionId,
      status: deriveStatus(acc),
      attempts: acc.requested,
      failures: acc.failures,
      retriesScheduled: acc.retriesScheduled,
      lastFailureReason: acc.lastFailureReason,
      lastMessage: acc.lastMessage,
      completedSequence: acc.completedSequence,
    });
  }

  return {
    cancelId,
    requested,
    currentEpoch,
    owner,
    ready,
    actions: materialised,
  };
}

/** The pending-action state for an action absent from the fold. */
function actionOrPending(
  saga: CancelSagaState,
  actionId: string,
): CompensationActionState {
  return (
    saga.actions.get(actionId) ?? {
      actionId,
      status: 'pending',
      attempts: 0,
      failures: 0,
      retriesScheduled: 0,
      lastFailureReason: undefined,
      lastMessage: undefined,
      completedSequence: undefined,
    }
  );
}

/** The next fencing epoch, one more than the current epoch. */
export function nextCancelEpoch(saga: CancelSagaState): number {
  return saga.currentEpoch + 1;
}

/**
 * Reject a write from a stale epoch. A writer with an epoch lower than the current
 * owner lost ownership. An epoch equal to `currentEpoch` can write.
 */
export function assertEpochCurrent(saga: CancelSagaState, writerEpoch: number): void {
  if (writerEpoch < saga.currentEpoch) {
    throw new StaleEpochError(writerEpoch, saga.currentEpoch, saga.cancelId);
  }
}

export interface CancelRetryPolicy {
  /** Maximum compensation attempts before escalating to manual intervention. */
  readonly maxAttempts: number;
}

/**
 * The next step for one compensation action, from the folded saga. `satisfied`
 * means that the compensation is complete and is never issued again.
 */
export type CompensationActionPlan =
  | { readonly kind: 'satisfied'; readonly actionId: string }
  | { readonly kind: 'blocked-manual'; readonly actionId: string }
  | { readonly kind: 'execute'; readonly actionId: string; readonly attempt: number }
  | {
      readonly kind: 'retry';
      readonly actionId: string;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly reason: CompensationFailureReason;
      readonly message: string;
    }
  | {
      readonly kind: 'escalate-manual';
      readonly actionId: string;
      readonly attempts: number;
      readonly reason: 'retries-exhausted';
    };

/**
 * Decide the next step for one compensation action from the fold counts.
 *
 * A completed action is `satisfied`, and a manual escalation is `blocked-manual`.
 * An attempt without an outcome, after a crash, resumes as the same attempt, so the
 * effect must be idempotent. When each attempt failed, the action retries until
 * `maxAttempts`, then escalates.
 */
export function decideCompensationAction(
  saga: CancelSagaState,
  actionId: string,
  policy: CancelRetryPolicy,
): CompensationActionPlan {
  if (policy.maxAttempts < 1) {
    throw new Error('CancelRetryPolicy.maxAttempts must be >= 1');
  }
  const action = actionOrPending(saga, actionId);

  if (action.status === 'succeeded') {
    return { kind: 'satisfied', actionId };
  }
  if (action.status === 'manual-intervention') {
    return { kind: 'blocked-manual', actionId };
  }
  if (action.attempts === 0) {
    return { kind: 'execute', actionId, attempt: 1 };
  }
  if (action.attempts > action.failures) {
    return { kind: 'execute', actionId, attempt: action.attempts };
  }
  if (action.failures >= policy.maxAttempts) {
    return {
      kind: 'escalate-manual',
      actionId,
      attempts: action.failures,
      reason: 'retries-exhausted',
    };
  }
  return {
    kind: 'retry',
    actionId,
    failedAttempt: action.failures,
    nextAttempt: action.failures + 1,
    reason: action.lastFailureReason ?? 'effect-failed',
    message: action.lastMessage ?? 'compensation attempt failed',
  };
}

export type CancelCompletionPlan =
  | { readonly kind: 'ready'; readonly completedActionIds: readonly string[] }
  | {
      readonly kind: 'blocked';
      readonly reason: 'unrecorded-outcome' | 'manual-intervention-required';
      readonly pendingActionIds: readonly string[];
    };

/**
 * Decide if the cancellation is complete. The plan is `ready` only when each
 * required action has a durable success. When both block, the plan names the manual
 * escalation and not the unrecorded outcome.
 */
export function planCancelCompletion(
  saga: CancelSagaState,
  requiredActionIds: readonly string[],
): CancelCompletionPlan {
  const manual: string[] = [];
  const unrecorded: string[] = [];
  for (const actionId of requiredActionIds) {
    const status = actionOrPending(saga, actionId).status;
    if (status === 'manual-intervention') manual.push(actionId);
    else if (status !== 'succeeded') unrecorded.push(actionId);
  }
  if (manual.length > 0) {
    return {
      kind: 'blocked',
      reason: 'manual-intervention-required',
      pendingActionIds: manual,
    };
  }
  if (unrecorded.length > 0) {
    return {
      kind: 'blocked',
      reason: 'unrecorded-outcome',
      pendingActionIds: unrecorded,
    };
  }
  return { kind: 'ready', completedActionIds: [...requiredActionIds] };
}

export interface CancelReadinessParams {
  readonly featureId: string;
  readonly cancelId: string;
  readonly phaseAttemptId: string;
  readonly evidenceId: string;
  readonly caller: Record<string, unknown>;
  readonly authorization?: Record<string, unknown> | undefined;
  readonly readyAt?: string;
}

export type CancelReadinessResult =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly plan: CancelCompletionPlan };

/**
 * The only constructor of a `cancel.ready` proof. It returns a validated payload
 * only when `planCancelCompletion` is `ready`. Otherwise it returns the blocking plan.
 * A success without a positive sequence also blocks, so no proof is unbacked.
 */
export function buildCancelReadiness(
  saga: CancelSagaState,
  requiredActionIds: readonly string[],
  params: CancelReadinessParams,
): CancelReadinessResult {
  const plan = planCancelCompletion(saga, requiredActionIds);
  if (plan.kind !== 'ready') {
    return { ok: false, plan };
  }

  const outcomeSequences: number[] = [];
  for (const actionId of requiredActionIds) {
    const seq = saga.actions.get(actionId)?.completedSequence;
    if (typeof seq !== 'number' || seq <= 0) {
      return {
        ok: false,
        plan: {
          kind: 'blocked',
          reason: 'unrecorded-outcome',
          pendingActionIds: [actionId],
        },
      };
    }
    outcomeSequences.push(seq);
  }

  const digestValue = sha256(
    JSON.stringify({
      cancelId: params.cancelId,
      completedActionIds: plan.completedActionIds,
      outcomeSequences,
    }),
  );
  const data = {
    eventVersion: '1.0',
    evidenceId: params.evidenceId,
    cancelId: params.cancelId,
    featureId: params.featureId,
    phaseAttemptId: params.phaseAttemptId,
    completedActionIds: [...plan.completedActionIds],
    outcomeSequences,
    contentDigest: { algorithm: 'sha256', value: digestValue },
    readyAt: params.readyAt ?? new Date().toISOString(),
    caller: params.caller,
    ...(params.authorization !== undefined
      ? { authorization: params.authorization }
      : {}),
  };
  const parsed = CancelReadyData.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      plan: {
        kind: 'blocked',
        reason: 'unrecorded-outcome',
        pendingActionIds: [...requiredActionIds],
      },
    };
  }
  return { ok: true, data };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function eventInputFrom(
  featureId: string,
  type: EventType,
  data: Record<string, unknown>,
  idempotencyKey: string,
): EventInput {
  const validated = buildValidatedEvent(featureId, 1, {
    type,
    data,
    source: 'workflow',
    idempotencyKey,
    timestamp: new Date().toISOString(),
  });
  const { streamId: _streamId, sequence: _sequence, ...eventInput } = validated;
  return eventInput;
}

export interface AcquireOwnershipParams {
  readonly featureId: string;
  readonly cancelId: string;
  readonly phaseAttemptId: string;
  readonly instanceId: string;
  /** Distinct per acquisition attempt so retries dedupe but takeovers do not. */
  readonly operationId: string;
}

/**
 * Allocate the next fencing epoch and append `cancel.ownership-acquired`. The read,
 * the increment, and the append run in one SQLite transaction, so two acquisitions
 * cannot get the same epoch.
 */
export async function acquireCancelOwnership(
  store: EventStore,
  params: AcquireOwnershipParams,
): Promise<{ readonly epoch: number }> {
  const requestDigest = `sha256:${sha256(
    JSON.stringify({ op: 'acquire', cancelId: params.cancelId, instanceId: params.instanceId }),
  )}`;
  return store.getAppender().decideOnce(
    params.operationId,
    requestDigest,
    (ctx) => {
      const snapshot = ctx.readStream(params.featureId);
      const saga = foldCancelSaga(snapshot.events, params.cancelId);
      const epoch = nextCancelEpoch(saga);
      const data = {
        eventVersion: '1.0',
        cancelId: params.cancelId,
        featureId: params.featureId,
        phaseAttemptId: params.phaseAttemptId,
        epoch,
        instanceId: params.instanceId,
        acquiredAt: new Date().toISOString(),
      };
      const eventInput = eventInputFrom(
        params.featureId,
        'cancel.ownership-acquired',
        data,
        `cancel:${sha256(`${params.featureId}\0${params.cancelId}\0ownership\0${epoch}`)}`,
      );
      return {
        streamId: params.featureId,
        events: [eventInput],
        result: { epoch },
      };
    },
  );
}

/**
 * Append a cancellation event under an atomic fencing check. The epoch check runs
 * in the append transaction. A stale writer gets `StaleEpochError`, and nothing is
 * written. Each logical write needs its own `operationId`, so a retry deduplicates.
 */
export async function appendFencedCancelEvent(
  store: EventStore,
  params: {
    readonly featureId: string;
    readonly cancelId: string;
    readonly writerEpoch: number;
    readonly type: EventType;
    readonly data: Record<string, unknown>;
    readonly idempotencyKey: string;
    readonly operationId: string;
  },
): Promise<{ readonly appended: true }> {
  const requestDigest = `sha256:${sha256(
    JSON.stringify({ type: params.type, key: params.idempotencyKey }),
  )}`;
  return store.getAppender().decideOnce(
    params.operationId,
    requestDigest,
    (ctx) => {
      const snapshot = ctx.readStream(params.featureId);
      const saga = foldCancelSaga(snapshot.events, params.cancelId);
      assertEpochCurrent(saga, params.writerEpoch);
      const eventInput = eventInputFrom(
        params.featureId,
        params.type,
        params.data,
        params.idempotencyKey,
      );
      return {
        streamId: params.featureId,
        events: [eventInput],
        result: { appended: true as const },
      };
    },
  );
}

/** Fold the durable log for `featureId` into the current saga state. */
export async function queryCancelSaga(
  store: EventStore,
  featureId: string,
  cancelId?: string,
): Promise<CancelSagaState> {
  const events = await store.query(featureId);
  return foldCancelSaga(events, cancelId);
}

/** True when a compensation outcome is durably recorded and successful. */
export function isCompensationSatisfied(
  saga: CancelSagaState,
  actionId: string,
): boolean {
  return actionOrPending(saga, actionId).status === 'succeeded';
}

/** The actions that are escalated to manual intervention. */
export function manualInterventionActions(
  saga: CancelSagaState,
): readonly CompensationActionState[] {
  const out: CompensationActionState[] = [];
  for (const action of saga.actions.values()) {
    if (action.status === 'manual-intervention') out.push(action);
  }
  return out;
}

export { CancelCompensationCompletedData, CancelOwnershipAcquiredData };

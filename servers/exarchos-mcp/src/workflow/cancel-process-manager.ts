// ─── Cancellation process manager (P04-02 / EFF-005, transition task 053) ────
//
// A replayable saga over the feature event log. Every state transition of a
// cancellation — intent, fencing-epoch acquisition, per-action compensation
// intent/result, retry scheduling, manual-intervention escalation, and the
// final readiness proof — is a durable event. The manager holds NO in-memory
// state: `foldCancelSaga` reconstructs the entire saga from the log, so restart
// and takeover fold to identical decisions.
//
// The five structural properties this module enforces:
//   1. Replayable       — state is a pure fold over `cancel.*` events.
//   2. Idempotent       — a completed compensation is `satisfied`; the decision
//                          engine never re-issues it (across restart OR takeover).
//   3. Fenced           — a monotonically increasing epoch is allocated on
//                          ownership acquisition; a stale-epoch writer is rejected
//                          with a typed `StaleEpochError`. Enforcement is atomic:
//                          the epoch check runs inside the same SQLite
//                          transaction that would append (via `decideOnce`), so a
//                          fenced-out write can never land.
//   4. No premature done — the ONLY constructor of a readiness proof
//                          (`buildCancelReadiness`) refuses unless every required
//                          action has a durably-recorded success. Premature
//                          completion is structurally impossible, not merely
//                          avoided by convention.
//   5. Bounded + surfaced — retries are bounded; exhaustion transitions to
//                          `manual-intervention-required`, a real, queryable
//                          terminal state rather than a swallowed failure.
//
// This module is intentionally decoupled from the concrete compensation effects
// (worktree teardown, branch deletion, …). It owns the DECISIONS; a driver owns
// the EFFECTS. See `cancel-process-manager.saga.test.ts` for an end-to-end
// driver exercising all four exit proofs against a real `EventStore`.

import { createHash } from 'node:crypto';
import type { EventStore } from '../event-store/store.js';
import type { EventInput } from '../event-store/atomic-appender.js';
import { buildValidatedEvent } from '../event-store/event-factory.js';
import {
  CancelCompensationCompletedData,
  CancelOwnershipAcquiredData,
  CancelReadyData,
  type EventType,
} from '../event-store/schemas.js';

// ─── Foldable event shape ────────────────────────────────────────────────────

/**
 * The minimal event projection the fold consumes. Satisfied by both
 * `WorkflowEvent` (from `EventStore.query`) and the transaction-scoped
 * `DecideOnceStoredEvent` (from `decideOnce`), so the SAME fold enforces
 * fencing both after a fresh read and inside an atomic append.
 */
export interface FoldableCancelEvent {
  readonly type: string;
  readonly data?: Record<string, unknown> | undefined;
  readonly sequence?: number | undefined;
}

// ─── Saga state (a pure fold) ────────────────────────────────────────────────

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
  /** Highest fencing epoch observed; 0 when no owner has been acquired. */
  readonly currentEpoch: number;
  /** Instance id holding `currentEpoch`, when any. */
  readonly owner: string | undefined;
  /** True once a `cancel.ready` readiness proof is durably present. */
  readonly ready: boolean;
  readonly actions: ReadonlyMap<string, CompensationActionState>;
}

export type CompensationFailureReason = 'effect-failed' | 'malformed-result';

// ─── Typed fencing error ─────────────────────────────────────────────────────

/**
 * A stale-epoch write was rejected. Thrown by the fencing guard (and, atomically,
 * inside `appendFencedCancelEvent`) when a writer's epoch is lower than the
 * epoch of the current owner. The classic distributed-lock fencing token: the
 * coordinator (here, the folded log) refuses any token below the latest issued.
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

// ─── Fold ────────────────────────────────────────────────────────────────────

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
 * Reconstruct the saga state from the event log. Pure and total: any event
 * whose payload does not parse is ignored (fail-closed — an unrecognised event
 * cannot advance the saga), so a malformed outcome leaves the action re-runnable
 * rather than silently "done".
 *
 * When `cancelId` is provided, only events for that cancellation are folded.
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

// ─── Fencing ─────────────────────────────────────────────────────────────────

/** The next fencing epoch to allocate (strictly greater than every prior). */
export function nextCancelEpoch(saga: CancelSagaState): number {
  return saga.currentEpoch + 1;
}

/**
 * Reject a write from a fenced-out (stale) epoch. A writer holding an epoch
 * lower than the current owner has lost ownership and MUST NOT write. An epoch
 * equal to `currentEpoch` (the reigning owner) is allowed.
 */
export function assertEpochCurrent(saga: CancelSagaState, writerEpoch: number): void {
  if (writerEpoch < saga.currentEpoch) {
    throw new StaleEpochError(writerEpoch, saga.currentEpoch, saga.cancelId);
  }
}

// ─── Decision engine ─────────────────────────────────────────────────────────

export interface CancelRetryPolicy {
  /** Maximum compensation attempts before escalating to manual intervention. */
  readonly maxAttempts: number;
}

/**
 * The next action the driver should take for one compensation action, decided
 * purely from the folded saga. `satisfied` is the idempotency guarantee: a
 * completed compensation is never re-issued, on restart or takeover.
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
 * Decide the next step for a single compensation action.
 *
 * Attempt accounting is derived entirely from the fold:
 *   - `attempts`  = count of `cancel.compensation-requested`
 *   - `failures`  = count of `cancel.compensation-failed`
 * A completed compensation is terminal-success (`satisfied`). A manual escalation
 * is terminal-unresolved (`blocked-manual`). Otherwise the bounded ladder is:
 * execute → (fail) → retry → execute → … → exhaust → escalate-manual.
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
  // An attempt was requested but has no terminal outcome (crash mid-attempt).
  // Resume the SAME attempt — the effect is required to be idempotent.
  if (action.attempts > action.failures) {
    return { kind: 'execute', actionId, attempt: action.attempts };
  }
  // Every issued attempt resolved as a failure (attempts === failures).
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

// ─── Completion gate (no premature done) ─────────────────────────────────────

export type CancelCompletionPlan =
  | { readonly kind: 'ready'; readonly completedActionIds: readonly string[] }
  | {
      readonly kind: 'blocked';
      readonly reason: 'unrecorded-outcome' | 'manual-intervention-required';
      readonly pendingActionIds: readonly string[];
    };

/**
 * Decide whether cancellation may be reported complete. `ready` is returned
 * ONLY when every required action has a durably-recorded success. If any action
 * is in manual-intervention the plan is blocked on that; if any outcome is not
 * yet recorded the plan is blocked on that. This is the structural gate that
 * makes "reporting complete before outcomes are recorded" impossible.
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
 * The SOLE constructor of a `cancel.ready` readiness proof. Returns a validated
 * payload ONLY when `planCancelCompletion` is `ready`; otherwise returns the
 * blocking plan and NO event. Because this is the only exported builder, a
 * premature readiness event cannot be constructed — the "no premature
 * completion" property is enforced by construction, not by discipline.
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
      // Defensive: `ready` implies every action succeeded, and a durable
      // success always carries a positive sequence. If the sequence is somehow
      // absent, refuse rather than emit an unbacked proof.
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

// ─── Store-backed atomic helpers ─────────────────────────────────────────────

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
 * Atomically allocate the next fencing epoch and append a
 * `cancel.ownership-acquired` fact. Read → compute `currentEpoch + 1` → append
 * all run inside one SQLite transaction, so two racing acquisitions cannot mint
 * the same epoch.
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
 * Append a cancellation process event under an ATOMIC fencing check. The epoch
 * comparison happens inside the same transaction that would append, so a
 * fenced-out (stale-epoch) writer's event can never be committed — the closure
 * throws `StaleEpochError` and the transaction rolls back with nothing written.
 *
 * `operationId` must be distinct per logical write so a legitimate retry dedupes
 * (fast-path claim hit, no re-append) while distinct writes each run the check.
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

// ─── Query helper ────────────────────────────────────────────────────────────

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

/** Actions currently escalated to manual intervention (a queryable terminal). */
export function manualInterventionActions(
  saga: CancelSagaState,
): readonly CompensationActionState[] {
  const out: CompensationActionState[] = [];
  for (const action of saga.actions.values()) {
    if (action.status === 'manual-intervention') out.push(action);
  }
  return out;
}

// Re-export the completed-outcome schema so drivers can validate durable results
// against the same contract the fold trusts.
export { CancelCompensationCompletedData, CancelOwnershipAcquiredData };

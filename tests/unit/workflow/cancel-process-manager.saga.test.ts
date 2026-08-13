// ─── Cancellation process-manager saga (P04-02 / EFF-005) exit proofs ────────
//
// Drives the replayable saga engine (`cancel-process-manager.ts`) against a
// REAL `EventStore` to prove the four exit properties of transition task 053:
//   (a) restart mid-saga does not repeat a completed compensation;
//   (b) takeover by a second instance does not repeat it, and the fenced-out
//       instance's writes are rejected with a typed error;
//   (c) cancellation cannot report complete before all outcomes are recorded;
//   (d) retry exhaustion lands in a queryable manual-intervention-required state.
//
// Plus focused unit tests that pin each pure decision so the kill-probe can
// turn a reverted guard red.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import {
  acquireCancelOwnership,
  appendFencedCancelEvent,
  assertEpochCurrent,
  buildCancelReadiness,
  decideCompensationAction,
  foldCancelSaga,
  isCompensationSatisfied,
  manualInterventionActions,
  nextCancelEpoch,
  planCancelCompletion,
  queryCancelSaga,
  StaleEpochError,
  type CancelRetryPolicy,
  type CompensationActionState,
  type FoldableCancelEvent,
} from '../../../src/workflow/cancel-process-manager.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

type CompensationOutcome = 'executed' | 'skipped' | 'failed';

interface SagaContext {
  readonly featureId: string;
  readonly cancelId: string;
  readonly phaseAttemptId: string;
}

const CALLER = {
  principalKind: 'operator',
  principalId: 'operator:test',
  role: 'operator',
} as const;

function makeContext(): SagaContext {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const phaseAttemptId = `phase-attempt:${suffix}`;
  return {
    featureId: `cancel-saga-${suffix}`,
    cancelId: `cancel:${phaseAttemptId}`,
    phaseAttemptId,
  };
}

function iso(): string {
  return new Date().toISOString();
}

function opId(ctx: SagaContext, actionId: string, attempt: number, kind: string): string {
  return `${ctx.featureId}:${ctx.cancelId}:${actionId}:${attempt}:${kind}`;
}

function idemKey(ctx: SagaContext, actionId: string, attempt: number, kind: string): string {
  return `cancel:${ctx.featureId}:${actionId}:${attempt}:${kind}`;
}

async function appendRequested(
  store: EventStore,
  ctx: SagaContext,
  actionId: string,
  attempt: number,
  epoch: number,
): Promise<void> {
  await appendFencedCancelEvent(store, {
    featureId: ctx.featureId,
    cancelId: ctx.cancelId,
    writerEpoch: epoch,
    type: 'cancel.compensation-requested',
    data: {
      eventVersion: '1.0',
      cancelId: ctx.cancelId,
      featureId: ctx.featureId,
      phaseAttemptId: ctx.phaseAttemptId,
      actionId,
      requestedAt: iso(),
    },
    idempotencyKey: idemKey(ctx, actionId, attempt, 'requested'),
    operationId: opId(ctx, actionId, attempt, 'requested'),
  });
}

async function appendCompleted(
  store: EventStore,
  ctx: SagaContext,
  actionId: string,
  attempt: number,
  epoch: number,
  status: 'executed' | 'skipped',
): Promise<void> {
  await appendFencedCancelEvent(store, {
    featureId: ctx.featureId,
    cancelId: ctx.cancelId,
    writerEpoch: epoch,
    type: 'cancel.compensation-completed',
    data: {
      eventVersion: '1.0',
      cancelId: ctx.cancelId,
      featureId: ctx.featureId,
      phaseAttemptId: ctx.phaseAttemptId,
      actionId,
      status,
      message: `compensation ${actionId} ${status}`,
      completedAt: iso(),
    },
    idempotencyKey: idemKey(ctx, actionId, attempt, 'completed'),
    operationId: opId(ctx, actionId, attempt, 'completed'),
  });
}

async function appendFailed(
  store: EventStore,
  ctx: SagaContext,
  actionId: string,
  attempt: number,
  epoch: number,
): Promise<void> {
  await appendFencedCancelEvent(store, {
    featureId: ctx.featureId,
    cancelId: ctx.cancelId,
    writerEpoch: epoch,
    type: 'cancel.compensation-failed',
    data: {
      eventVersion: '1.0',
      cancelId: ctx.cancelId,
      featureId: ctx.featureId,
      phaseAttemptId: ctx.phaseAttemptId,
      actionId,
      reason: 'effect-failed',
      message: `compensation ${actionId} failed on attempt ${attempt}`,
      failedAt: iso(),
    },
    idempotencyKey: idemKey(ctx, actionId, attempt, 'failed'),
    operationId: opId(ctx, actionId, attempt, 'failed'),
  });
}

async function runAttempt(
  store: EventStore,
  ctx: SagaContext,
  actionId: string,
  attempt: number,
  epoch: number,
  effect: () => CompensationOutcome,
): Promise<void> {
  await appendRequested(store, ctx, actionId, attempt, epoch);
  const outcome = effect();
  if (outcome === 'failed') {
    await appendFailed(store, ctx, actionId, attempt, epoch);
  } else {
    await appendCompleted(store, ctx, actionId, attempt, epoch, outcome);
  }
}

/** One decision + action for the first action that still needs work. */
async function stepSaga(
  store: EventStore,
  ctx: SagaContext,
  actionIds: readonly string[],
  effects: ReadonlyMap<string, () => CompensationOutcome>,
  policy: CancelRetryPolicy,
  epoch: number,
): Promise<'progressed' | 'quiescent'> {
  const saga = await queryCancelSaga(store, ctx.featureId, ctx.cancelId);
  for (const actionId of actionIds) {
    const plan = decideCompensationAction(saga, actionId, policy);
    if (plan.kind === 'satisfied' || plan.kind === 'blocked-manual') continue;

    const effect = effects.get(actionId);
    if (effect === undefined) throw new Error(`no effect registered for ${actionId}`);

    if (plan.kind === 'execute') {
      await runAttempt(store, ctx, actionId, plan.attempt, epoch, effect);
      return 'progressed';
    }
    if (plan.kind === 'retry') {
      await appendFencedCancelEvent(store, {
        featureId: ctx.featureId,
        cancelId: ctx.cancelId,
        writerEpoch: epoch,
        type: 'cancel.compensation-retry-scheduled',
        data: {
          eventVersion: '1.0',
          cancelId: ctx.cancelId,
          featureId: ctx.featureId,
          phaseAttemptId: ctx.phaseAttemptId,
          actionId,
          epoch,
          attempt: plan.failedAttempt,
          maxAttempts: policy.maxAttempts,
          reason: plan.reason,
          message: plan.message,
          scheduledAt: iso(),
        },
        idempotencyKey: idemKey(ctx, actionId, plan.failedAttempt, 'retry'),
        operationId: opId(ctx, actionId, plan.failedAttempt, 'retry'),
      });
      await runAttempt(store, ctx, actionId, plan.nextAttempt, epoch, effect);
      return 'progressed';
    }
    // escalate-manual
    await appendFencedCancelEvent(store, {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      writerEpoch: epoch,
      type: 'cancel.manual-intervention-required',
      data: {
        eventVersion: '1.0',
        cancelId: ctx.cancelId,
        featureId: ctx.featureId,
        phaseAttemptId: ctx.phaseAttemptId,
        actionId,
        epoch,
        attempts: plan.attempts,
        reason: plan.reason,
        message: `compensation ${actionId} exhausted ${plan.attempts} attempts`,
        requiredAt: iso(),
      },
      idempotencyKey: idemKey(ctx, actionId, plan.attempts, 'manual'),
      operationId: opId(ctx, actionId, plan.attempts, 'manual'),
    });
    return 'progressed';
  }
  return 'quiescent';
}

async function driveSaga(
  store: EventStore,
  ctx: SagaContext,
  actionIds: readonly string[],
  effects: ReadonlyMap<string, () => CompensationOutcome>,
  policy: CancelRetryPolicy,
  epoch: number,
  cap = 40,
): Promise<void> {
  for (let i = 0; i < cap; i++) {
    const outcome = await stepSaga(store, ctx, actionIds, effects, policy, epoch);
    if (outcome === 'quiescent') return;
  }
  throw new Error('driveSaga did not reach quiescence within the iteration cap');
}

function countingEffect(
  counter: { count: number },
  outcome: CompensationOutcome,
): () => CompensationOutcome {
  return () => {
    counter.count += 1;
    return outcome;
  };
}

async function appendRequestedIntent(
  store: EventStore,
  ctx: SagaContext,
  epoch: number,
): Promise<void> {
  await appendFencedCancelEvent(store, {
    featureId: ctx.featureId,
    cancelId: ctx.cancelId,
    writerEpoch: epoch,
    type: 'cancel.requested',
    data: {
      eventVersion: '1.0',
      cancelId: ctx.cancelId,
      featureId: ctx.featureId,
      from: 'delegate',
      phaseAttemptId: ctx.phaseAttemptId,
      requestedAt: iso(),
      caller: CALLER,
    },
    idempotencyKey: `cancel:${ctx.featureId}:requested`,
    operationId: `${ctx.featureId}:${ctx.cancelId}:requested`,
  });
}

// ─── Pure unit tests (discriminating decision pins) ──────────────────────────

describe('foldCancelSaga', () => {
  function ev(type: string, data: Record<string, unknown>, sequence: number): FoldableCancelEvent {
    return { type, data, sequence };
  }

  it('Fold_ReconstructsPerActionStatusEpochAndReadiness', () => {
    const cancelId = 'cancel:x';
    const events: FoldableCancelEvent[] = [
      ev('cancel.requested', { cancelId }, 1),
      ev('cancel.ownership-acquired', { cancelId, epoch: 1, instanceId: 'A' }, 2),
      ev('cancel.compensation-requested', { cancelId, actionId: 'alpha' }, 3),
      ev('cancel.compensation-completed', { cancelId, actionId: 'alpha' }, 4),
      ev('cancel.compensation-requested', { cancelId, actionId: 'beta' }, 5),
      ev('cancel.compensation-failed', { cancelId, actionId: 'beta', reason: 'effect-failed', message: 'boom' }, 6),
      ev('cancel.manual-intervention-required', { cancelId, actionId: 'beta' }, 7),
      ev('cancel.ownership-acquired', { cancelId, epoch: 2, instanceId: 'B' }, 8),
    ];
    const saga = foldCancelSaga(events, cancelId);
    expect(saga.requested).toBe(true);
    expect(saga.currentEpoch).toBe(2);
    expect(saga.owner).toBe('B');
    expect(saga.ready).toBe(false);
    expect(saga.actions.get('alpha')?.status).toBe('succeeded');
    expect(saga.actions.get('alpha')?.completedSequence).toBe(4);
    expect(saga.actions.get('beta')?.status).toBe('manual-intervention');
  });

  it('Fold_IgnoresEventsForOtherCancellations', () => {
    const events: FoldableCancelEvent[] = [
      { type: 'cancel.compensation-completed', data: { cancelId: 'other', actionId: 'alpha' }, sequence: 1 },
    ];
    const saga = foldCancelSaga(events, 'mine');
    expect(saga.actions.has('alpha')).toBe(false);
  });

  it('Fold_TreatsRequestedWithoutOutcomeAsIntended', () => {
    const events: FoldableCancelEvent[] = [
      { type: 'cancel.compensation-requested', data: { cancelId: 'c', actionId: 'alpha' }, sequence: 1 },
    ];
    const saga = foldCancelSaga(events, 'c');
    expect(saga.actions.get('alpha')?.status).toBe('intended');
  });
});

describe('decideCompensationAction', () => {
  const policy: CancelRetryPolicy = { maxAttempts: 3 };
  const cancelId = 'c';

  function sagaFrom(events: FoldableCancelEvent[]) {
    return foldCancelSaga(events, cancelId);
  }

  it('Decide_FreshAction_ExecutesAttemptOne', () => {
    const plan = decideCompensationAction(sagaFrom([]), 'alpha', policy);
    expect(plan).toEqual({ kind: 'execute', actionId: 'alpha', attempt: 1 });
  });

  it('Decide_CompletedAction_IsSatisfiedAndNeverRepeated', () => {
    const plan = decideCompensationAction(
      sagaFrom([
        { type: 'cancel.compensation-requested', data: { cancelId, actionId: 'alpha' }, sequence: 1 },
        { type: 'cancel.compensation-completed', data: { cancelId, actionId: 'alpha' }, sequence: 2 },
      ]),
      'alpha',
      policy,
    );
    expect(plan.kind).toBe('satisfied');
  });

  it('Decide_InFlightAttempt_ResumesSameAttempt', () => {
    const plan = decideCompensationAction(
      sagaFrom([
        { type: 'cancel.compensation-requested', data: { cancelId, actionId: 'alpha' }, sequence: 1 },
      ]),
      'alpha',
      policy,
    );
    expect(plan).toEqual({ kind: 'execute', actionId: 'alpha', attempt: 1 });
  });

  it('Decide_FailedUnderBudget_SchedulesRetry', () => {
    const plan = decideCompensationAction(
      sagaFrom([
        { type: 'cancel.compensation-requested', data: { cancelId, actionId: 'alpha' }, sequence: 1 },
        { type: 'cancel.compensation-failed', data: { cancelId, actionId: 'alpha', reason: 'effect-failed', message: 'boom' }, sequence: 2 },
      ]),
      'alpha',
      policy,
    );
    expect(plan).toMatchObject({ kind: 'retry', failedAttempt: 1, nextAttempt: 2, reason: 'effect-failed' });
  });

  it('Decide_FailuresAtBudget_EscalatesToManual', () => {
    const events: FoldableCancelEvent[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      events.push({ type: 'cancel.compensation-requested', data: { cancelId, actionId: 'alpha' }, sequence: attempt * 2 - 1 });
      events.push({ type: 'cancel.compensation-failed', data: { cancelId, actionId: 'alpha', reason: 'effect-failed', message: 'boom' }, sequence: attempt * 2 });
    }
    const plan = decideCompensationAction(sagaFrom(events), 'alpha', policy);
    expect(plan).toEqual({ kind: 'escalate-manual', actionId: 'alpha', attempts: 3, reason: 'retries-exhausted' });
  });

  it('Decide_ManualAction_IsBlocked', () => {
    const plan = decideCompensationAction(
      sagaFrom([
        { type: 'cancel.manual-intervention-required', data: { cancelId, actionId: 'alpha' }, sequence: 1 },
      ]),
      'alpha',
      policy,
    );
    expect(plan.kind).toBe('blocked-manual');
  });

  it('Decide_RejectsNonPositiveBudget', () => {
    expect(() => decideCompensationAction(sagaFrom([]), 'alpha', { maxAttempts: 0 })).toThrow();
  });
});

describe('fencing guards', () => {
  it('NextEpoch_IsStrictlyMonotonic', () => {
    const s0 = foldCancelSaga([], 'c');
    expect(nextCancelEpoch(s0)).toBe(1);
    const s1 = foldCancelSaga(
      [{ type: 'cancel.ownership-acquired', data: { cancelId: 'c', epoch: 4, instanceId: 'A' }, sequence: 1 }],
      'c',
    );
    expect(nextCancelEpoch(s1)).toBe(5);
  });

  it('AssertEpochCurrent_RejectsStaleWriterWithTypedError', () => {
    const saga = foldCancelSaga(
      [{ type: 'cancel.ownership-acquired', data: { cancelId: 'c', epoch: 2, instanceId: 'B' }, sequence: 1 }],
      'c',
    );
    expect(() => assertEpochCurrent(saga, 1)).toThrow(StaleEpochError);
    // The reigning owner (equal epoch) is allowed.
    expect(() => assertEpochCurrent(saga, 2)).not.toThrow();
  });
});

describe('planCancelCompletion / buildCancelReadiness (no premature completion)', () => {
  const cancelId = 'c';
  const required = ['alpha', 'beta'];

  function readinessParams(ctx: SagaContext) {
    return {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      phaseAttemptId: ctx.phaseAttemptId,
      evidenceId: `cancel-ready:${ctx.phaseAttemptId}`,
      caller: CALLER as unknown as Record<string, unknown>,
    };
  }

  it('Completion_BlockedWhileAnyOutcomeUnrecorded', () => {
    const saga = foldCancelSaga(
      [
        { type: 'cancel.compensation-requested', data: { cancelId, actionId: 'alpha' }, sequence: 1 },
        { type: 'cancel.compensation-completed', data: { cancelId, actionId: 'alpha' }, sequence: 2 },
      ],
      cancelId,
    );
    const plan = planCancelCompletion(saga, required);
    expect(plan).toEqual({ kind: 'blocked', reason: 'unrecorded-outcome', pendingActionIds: ['beta'] });
  });

  it('Completion_BlockedOnManualIntervention', () => {
    const saga = foldCancelSaga(
      [
        { type: 'cancel.compensation-completed', data: { cancelId, actionId: 'alpha' }, sequence: 2 },
        { type: 'cancel.manual-intervention-required', data: { cancelId, actionId: 'beta' }, sequence: 3 },
      ],
      cancelId,
    );
    const plan = planCancelCompletion(saga, required);
    expect(plan.kind).toBe('blocked');
    expect(plan).toMatchObject({ reason: 'manual-intervention-required', pendingActionIds: ['beta'] });
  });

  it('BuildReadiness_RefusesUnlessEveryOutcomeRecorded', () => {
    const ctx = makeContext();
    const saga = foldCancelSaga(
      [{ type: 'cancel.compensation-completed', data: { cancelId: ctx.cancelId, actionId: 'alpha' }, sequence: 2 }],
      ctx.cancelId,
    );
    const result = buildCancelReadiness(saga, ['alpha', 'beta'], readinessParams(ctx));
    expect(result.ok).toBe(false);
  });

  it('BuildReadiness_ProducesValidProofWhenAllRecorded', () => {
    const ctx = makeContext();
    const saga = foldCancelSaga(
      [
        { type: 'cancel.compensation-completed', data: { cancelId: ctx.cancelId, actionId: 'alpha' }, sequence: 2 },
        { type: 'cancel.compensation-completed', data: { cancelId: ctx.cancelId, actionId: 'beta' }, sequence: 5 },
      ],
      ctx.cancelId,
    );
    const result = buildCancelReadiness(saga, ['alpha', 'beta'], readinessParams(ctx));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.completedActionIds).toEqual(['alpha', 'beta']);
      expect(result.data.outcomeSequences).toEqual([2, 5]);
    }
  });
});

// ─── Store-backed exit proofs ────────────────────────────────────────────────

describe('cancellation process-manager exit proofs (against a real EventStore)', () => {
  let stateDir: string;
  let store: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'cancel-saga-'));
    store = new EventStore(stateDir);
    await store.initialize();
  });

  afterEach(async () => {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  });

  const policy: CancelRetryPolicy = { maxAttempts: 3 };
  const actions = ['alpha', 'beta', 'gamma'] as const;

  it('ExitProof_A_RestartMidSaga_DoesNotRepeatCompletedCompensation', async () => {
    const ctx = makeContext();
    const counters = { alpha: { count: 0 }, beta: { count: 0 }, gamma: { count: 0 } };
    const effects = new Map<string, () => CompensationOutcome>([
      ['alpha', countingEffect(counters.alpha, 'executed')],
      ['beta', countingEffect(counters.beta, 'executed')],
      ['gamma', countingEffect(counters.gamma, 'executed')],
    ]);

    const { epoch } = await acquireCancelOwnership(store, {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      phaseAttemptId: ctx.phaseAttemptId,
      instanceId: 'instance-A',
      operationId: `${ctx.featureId}:acquire:A`,
    });
    expect(epoch).toBe(1);
    await appendRequestedIntent(store, ctx, epoch);

    // Partial progress: complete alpha only, then simulate a crash.
    await stepSaga(store, ctx, actions, effects, policy, epoch);
    expect(isCompensationSatisfied(await queryCancelSaga(store, ctx.featureId, ctx.cancelId), 'alpha')).toBe(true);
    expect(counters.alpha.count).toBe(1);

    // Restart: drop the in-memory store, reopen the durable log, resume.
    store.close();
    store = new EventStore(stateDir);
    await store.initialize();

    await driveSaga(store, ctx, actions, effects, policy, epoch);

    // The completed compensation (alpha) is NOT re-executed across the restart.
    expect(counters.alpha.count).toBe(1);
    expect(counters.beta.count).toBe(1);
    expect(counters.gamma.count).toBe(1);

    const events = await store.query(ctx.featureId);
    const alphaCompletions = events.filter(
      (e) => e.type === 'cancel.compensation-completed' && (e.data as Record<string, unknown>).actionId === 'alpha',
    );
    expect(alphaCompletions).toHaveLength(1);

    const saga = await queryCancelSaga(store, ctx.featureId, ctx.cancelId);
    expect(planCancelCompletion(saga, [...actions]).kind).toBe('ready');
  });

  it('ExitProof_B_Takeover_DoesNotRepeatAndFencesOutStaleInstance', async () => {
    const ctx = makeContext();
    const counters = { alpha: { count: 0 }, beta: { count: 0 }, gamma: { count: 0 } };
    const effects = new Map<string, () => CompensationOutcome>([
      ['alpha', countingEffect(counters.alpha, 'executed')],
      ['beta', countingEffect(counters.beta, 'executed')],
      ['gamma', countingEffect(counters.gamma, 'executed')],
    ]);

    // Instance A acquires epoch 1 and completes alpha, then stalls.
    const a = await acquireCancelOwnership(store, {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      phaseAttemptId: ctx.phaseAttemptId,
      instanceId: 'instance-A',
      operationId: `${ctx.featureId}:acquire:A`,
    });
    expect(a.epoch).toBe(1);
    await appendRequestedIntent(store, ctx, a.epoch);
    await stepSaga(store, ctx, actions, effects, policy, a.epoch); // completes alpha
    expect(counters.alpha.count).toBe(1);

    // Instance B takes over — acquires a strictly higher epoch (fencing token).
    const b = await acquireCancelOwnership(store, {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      phaseAttemptId: ctx.phaseAttemptId,
      instanceId: 'instance-B',
      operationId: `${ctx.featureId}:acquire:B`,
    });
    expect(b.epoch).toBe(2);

    // B folds the log: alpha is already satisfied, so B does not re-run it.
    await driveSaga(store, ctx, actions, effects, policy, b.epoch);
    expect(counters.alpha.count).toBe(1); // NOT repeated by the takeover
    expect(counters.beta.count).toBe(1);
    expect(counters.gamma.count).toBe(1);

    // The fenced-out instance A (epoch 1) cannot write anymore: a stale-epoch
    // write is rejected atomically with a typed error, and nothing lands.
    const before = (await store.query(ctx.featureId)).length;
    await expect(
      appendFencedCancelEvent(store, {
        featureId: ctx.featureId,
        cancelId: ctx.cancelId,
        writerEpoch: a.epoch, // stale
        type: 'cancel.compensation-failed',
        data: {
          eventVersion: '1.0',
          cancelId: ctx.cancelId,
          featureId: ctx.featureId,
          phaseAttemptId: ctx.phaseAttemptId,
          actionId: 'beta',
          reason: 'effect-failed',
          message: 'stale instance A tries to clobber beta',
          failedAt: iso(),
        },
        idempotencyKey: `cancel:${ctx.featureId}:beta:stale-A`,
        operationId: `${ctx.featureId}:stale-A-write`,
      }),
    ).rejects.toBeInstanceOf(StaleEpochError);

    // No stray event landed, and beta remains a single successful outcome.
    const after = await store.query(ctx.featureId);
    expect(after).toHaveLength(before);
    const betaOutcomes = after.filter(
      (e) =>
        (e.type === 'cancel.compensation-completed' || e.type === 'cancel.compensation-failed') &&
        (e.data as Record<string, unknown>).actionId === 'beta',
    );
    expect(betaOutcomes).toHaveLength(1);
    expect(betaOutcomes[0]?.type).toBe('cancel.compensation-completed');

    const saga = await queryCancelSaga(store, ctx.featureId, ctx.cancelId);
    expect(planCancelCompletion(saga, [...actions]).kind).toBe('ready');
  });

  it('ExitProof_C_CannotReportCompleteBeforeAllOutcomesRecorded', async () => {
    const ctx = makeContext();
    const counters = { alpha: { count: 0 }, beta: { count: 0 }, gamma: { count: 0 } };
    const effects = new Map<string, () => CompensationOutcome>([
      ['alpha', countingEffect(counters.alpha, 'executed')],
      ['beta', countingEffect(counters.beta, 'executed')],
      ['gamma', countingEffect(counters.gamma, 'executed')],
    ]);
    const { epoch } = await acquireCancelOwnership(store, {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      phaseAttemptId: ctx.phaseAttemptId,
      instanceId: 'instance-A',
      operationId: `${ctx.featureId}:acquire:A`,
    });
    await appendRequestedIntent(store, ctx, epoch);

    const params = {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      phaseAttemptId: ctx.phaseAttemptId,
      evidenceId: `cancel-ready:${ctx.phaseAttemptId}`,
      caller: CALLER as unknown as Record<string, unknown>,
    };

    // Only alpha completed so far — readiness MUST be refused.
    await stepSaga(store, ctx, actions, effects, policy, epoch);
    const partialSaga = await queryCancelSaga(store, ctx.featureId, ctx.cancelId);
    expect(planCancelCompletion(partialSaga, [...actions]).kind).toBe('blocked');
    const premature = buildCancelReadiness(partialSaga, [...actions], params);
    expect(premature.ok).toBe(false);
    if (!premature.ok) {
      expect(premature.plan.kind).toBe('blocked');
    }
    // No cancel.ready in the durable log yet.
    expect((await store.query(ctx.featureId)).some((e) => e.type === 'cancel.ready')).toBe(false);

    // Finish every compensation, THEN readiness is granted and durably recorded.
    await driveSaga(store, ctx, actions, effects, policy, epoch);
    const fullSaga = await queryCancelSaga(store, ctx.featureId, ctx.cancelId);
    const ready = buildCancelReadiness(fullSaga, [...actions], params);
    expect(ready.ok).toBe(true);
    if (ready.ok) {
      await appendFencedCancelEvent(store, {
        featureId: ctx.featureId,
        cancelId: ctx.cancelId,
        writerEpoch: epoch,
        type: 'cancel.ready',
        data: ready.data,
        idempotencyKey: `cancel:${ctx.featureId}:ready`,
        operationId: `${ctx.featureId}:${ctx.cancelId}:ready`,
      });
    }
    const readyEvents = (await store.query(ctx.featureId)).filter((e) => e.type === 'cancel.ready');
    expect(readyEvents).toHaveLength(1);
  });

  it('ExitProof_D_RetryExhaustion_LandsInManualInterventionRequired', async () => {
    const ctx = makeContext();
    const flaky = { count: 0 };
    const effects = new Map<string, () => CompensationOutcome>([
      ['flaky', countingEffect(flaky, 'failed')],
    ]);
    const { epoch } = await acquireCancelOwnership(store, {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      phaseAttemptId: ctx.phaseAttemptId,
      instanceId: 'instance-A',
      operationId: `${ctx.featureId}:acquire:A`,
    });
    await appendRequestedIntent(store, ctx, epoch);

    await driveSaga(store, ctx, ['flaky'], effects, policy, epoch);

    // Bounded: exactly maxAttempts effect invocations, then escalation.
    expect(flaky.count).toBe(policy.maxAttempts);

    const events = await store.query(ctx.featureId);
    const retries = events.filter((e) => e.type === 'cancel.compensation-retry-scheduled');
    expect(retries).toHaveLength(policy.maxAttempts - 1);
    const manual = events.filter((e) => e.type === 'cancel.manual-intervention-required');
    expect(manual).toHaveLength(1);
    expect((manual[0]?.data as Record<string, unknown>).reason).toBe('retries-exhausted');

    // The terminal state is real and queryable, and blocks completion.
    const saga = await queryCancelSaga(store, ctx.featureId, ctx.cancelId);
    expect(saga.actions.get('flaky')?.status).toBe('manual-intervention');
    const manualActions: readonly CompensationActionState[] = manualInterventionActions(saga);
    expect(manualActions.map((a) => a.actionId)).toEqual(['flaky']);
    const completion = planCancelCompletion(saga, ['flaky']);
    expect(completion).toMatchObject({ kind: 'blocked', reason: 'manual-intervention-required' });
    const readiness = buildCancelReadiness(saga, ['flaky'], {
      featureId: ctx.featureId,
      cancelId: ctx.cancelId,
      phaseAttemptId: ctx.phaseAttemptId,
      evidenceId: `cancel-ready:${ctx.phaseAttemptId}`,
      caller: CALLER as unknown as Record<string, unknown>,
    });
    expect(readiness.ok).toBe(false);
  });
});

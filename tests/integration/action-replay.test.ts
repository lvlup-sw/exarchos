// @oracle-sources: ../../src/dispatch/caller-identity.js, the request payloads and clock readings this file fixes by hand — chosen to differ in exactly the fields a replay identity must ignore
//
// A replay identity is stable iff two DIFFERENT requests that mean the same
// thing digest the same. One side is the identity the dispatch layer snapshots
// off a live authenticated caller; the other is the varied input the test
// author fixes. Deriving both from `request-context` would compare the digest
// function against itself.

import { describe, expect, it, vi } from 'vitest';
import {
  applyReplayPolicy,
  contextSubjectId,
  deriveReplayIdentity,
  deriveRequestContext,
  requestDigest,
  ReplayLedger,
  type AuthenticatedRequestContext,
} from '../../src/contract/request-context.js';
import {
  deriveLocalOperatorIdentity,
  snapshotCallerAuthorization,
} from '../../src/dispatch/caller-identity.js';
import {
  effectIdempotencyKey,
  effectPlanFromContract,
  idempotentFromReplay,
  recordsNothing,
  replayIdentityFromEffectKey,
  type EffectPlanInput,
} from '../../src/dispatch/core/effect-carrier.js';

function ctxFor(stateDir: string): AuthenticatedRequestContext {
  const identity = deriveLocalOperatorIdentity(stateDir);
  return deriveRequestContext(
    snapshotCallerAuthorization(identity, undefined, () => '2026-01-01T00:00:00.000Z'),
  );
}

const PLAN_FIELDS: EffectPlanInput = {
  effectClass: 'filesystem',
  owner: 'replay-binding',
  description: 'write a marker',
  emits: recordsNothing('scratch marker; nothing durable follows'),
};

describe('action replay binding', () => {
  it('Replay_ClaimRequired_UsesExistingIdentity', () => {
    const ctx = ctxFor('C:/state-claim');
    const payload = { action: 'write', path: '/tmp/marker' };
    const effectKey = effectIdempotencyKey('workflow-stream', 'write-marker');
    const identity = replayIdentityFromEffectKey(ctx, effectKey, payload);
    const existing = deriveReplayIdentity(ctx, effectKey.value, payload);

    expect(Object.keys(identity).sort()).toEqual(['idempotencyKey', 'requestDigest', 'subjectId']);
    expect(identity).toEqual(existing);
    expect(identity.idempotencyKey).toBe(effectKey.value);
    expect(identity.subjectId).toBe(contextSubjectId(ctx));
    expect(identity.requestDigest).toBe(requestDigest(payload));
    expect(effectKey.stream).toBe('workflow-stream');
    expect(effectKey.value).toBe('workflow-stream:write-marker');

    const ledger = new ReplayLedger<string>();
    const exec = vi.fn(() => 'first');
    const replay = { kind: 'claim-required' as const, scope: 'stream-subject-request' as const };
    const first = applyReplayPolicy(replay, identity, ledger, exec);
    const second = applyReplayPolicy(replay, identity, ledger, vi.fn(() => 'second'));

    expect(first).toEqual({ status: 'executed', result: 'first' });
    expect(second).toEqual({ status: 'replayed', result: 'first' });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(ledger.has(effectKey.value)).toBe(true);
    expect(ledger.has(identity.idempotencyKey)).toBe(true);
  });

  it('Replay_EffectPlanIdempotent_DerivesFromContract', () => {
    expect(idempotentFromReplay({ kind: 'safe-repeat' })).toBe(true);
    expect(
      idempotentFromReplay({ kind: 'claim-required', scope: 'stream-subject-request' }),
    ).toBe(false);
    expect(
      idempotentFromReplay({ kind: 'reject-replay', because: 'external side effect' }),
    ).toBe(false);

    expect(
      effectPlanFromContract(PLAN_FIELDS, { replay: { kind: 'safe-repeat' } }).idempotent,
    ).toBe(true);
    expect(
      effectPlanFromContract(PLAN_FIELDS, {
        replay: { kind: 'claim-required', scope: 'stream-subject-request' },
      }).idempotent,
    ).toBe(false);
    expect(
      effectPlanFromContract(PLAN_FIELDS, {
        replay: { kind: 'reject-replay', because: 'external side effect' },
      }).idempotent,
    ).toBe(false);

    const siblingAttempt = { ...PLAN_FIELDS, idempotent: true };
    expect(
      effectPlanFromContract(siblingAttempt, {
        replay: { kind: 'reject-replay', because: 'must not disagree' },
      }).idempotent,
    ).toBe(false);
  });

  it('Replay_RejectPolicy_NeverExecutesTwice', () => {
    const ctx = ctxFor('C:/state-reject');
    const payload = { action: 'merge' };
    const effectKey = effectIdempotencyKey('merge-stream', 'execute-merge');
    const identity = replayIdentityFromEffectKey(ctx, effectKey, payload);
    const ledger = new ReplayLedger<string>();
    const replay = { kind: 'reject-replay' as const, because: 'merge is not safe to repeat' };
    const firstExec = vi.fn(() => 'merged');
    const secondExec = vi.fn(() => 'merged-again');

    const first = applyReplayPolicy(replay, identity, ledger, firstExec);
    const second = applyReplayPolicy(replay, identity, ledger, secondExec);

    expect(first).toEqual({ status: 'executed', result: 'merged' });
    expect(firstExec).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('conflict');
    if (second.status === 'conflict') {
      expect(second.error.layer).toBe('task');
      expect(second.error.message).toBe('merge is not safe to repeat');
    }
    expect(secondExec).not.toHaveBeenCalled();
  });

  it('Replay_ExistingInv8Tests_RemainGreen', () => {
    const ledger = new ReplayLedger<number>();
    const ctx = ctxFor('C:/state-a');
    const id = deriveReplayIdentity(ctx, 'k', { n: 1 });
    const exec = vi.fn(() => 7);

    expect(deriveReplayIdentity(ctx, 'key-1', { action: 'x' }).subjectId).toBe(
      contextSubjectId(ctx),
    );
    expect(() => deriveReplayIdentity(ctx, '', {})).toThrow(/non-empty/);

    const first = ledger.claim(id, exec);
    expect(first.status).toBe('executed');
    expect(first).toMatchObject({ result: 7 });
    expect(exec).toHaveBeenCalledTimes(1);

    const second = ledger.claim(id, vi.fn(() => 999));
    expect(second.status).toBe('replayed');
    expect(second).toMatchObject({ result: 7 });
    expect(exec).toHaveBeenCalledTimes(1);

    const other = deriveReplayIdentity(ctxFor('C:/state-B-different'), 'shared-key', { n: 1 });
    const shared = deriveReplayIdentity(ctx, 'shared-key', { n: 1 });
    expect(shared.subjectId).not.toBe(other.subjectId);
    const subjectLedger = new ReplayLedger<number>();
    subjectLedger.claim(shared, () => 7);
    const attackerExec = vi.fn(() => 13);
    const subjectConflict = subjectLedger.claim(other, attackerExec);
    expect(subjectConflict.status).toBe('conflict');
    if (subjectConflict.status === 'conflict') {
      expect(subjectConflict.error.code).toBe('IDEMPOTENCY_SUBJECT_CONFLICT');
    }
    expect(attackerExec).not.toHaveBeenCalled();

    const changed = deriveReplayIdentity(ctx, 'k', { n: 2 });
    expect(id.requestDigest).not.toBe(changed.requestDigest);
    const payloadExec = vi.fn(() => 42);
    const payloadConflict = ledger.claim(changed, payloadExec);
    expect(payloadConflict.status).toBe('conflict');
    if (payloadConflict.status === 'conflict') {
      expect(payloadConflict.error.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
    }
    expect(payloadExec).not.toHaveBeenCalled();
  });
});

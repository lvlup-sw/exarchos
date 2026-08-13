import { describe, it, expect, vi } from 'vitest';
import {
  PROTECTED_CONTEXT_FIELDS,
  isProtectedContextField,
  sanitizeUntrustedHints,
  deriveRequestContext,
  contextSubjectId,
  canonicalJson,
  requestDigest,
  deriveReplayIdentity,
  ReplayLedger,
  type AuthenticatedRequestContext,
} from '../../../src/contract/request-context.js';
import {
  deriveLocalOperatorIdentity,
  snapshotCallerAuthorization,
  type CallerAuthorizationSnapshot,
} from '../../../src/dispatch/caller-identity.js';

function snapshot(stateDir = 'C:/state', clock = () => '2026-01-01T00:00:00.000Z'): CallerAuthorizationSnapshot {
  const identity = deriveLocalOperatorIdentity(stateDir);
  return snapshotCallerAuthorization(identity, undefined, clock);
}

describe('request-context — untrusted hint sanitisation', () => {
  it('ProtectedFields_AreStripped', () => {
    const cleaned = sanitizeUntrustedHints({
      role: 'operator',
      issuer: 'evil-issuer',
      subjectId: 'spoofed',
      timestamp: 'yesterday',
      capabilities: ['mutate-everything'],
      harmless: 'ok',
      correlationHint: 42,
    });
    expect('role' in cleaned).toBe(false);
    expect('issuer' in cleaned).toBe(false);
    expect('subjectId' in cleaned).toBe(false);
    expect('timestamp' in cleaned).toBe(false);
    expect('capabilities' in cleaned).toBe(false);
    // Harmless hints survive.
    expect(cleaned.harmless).toBe('ok');
    expect(cleaned.correlationHint).toBe(42);
  });

  it('EveryProtectedFieldIsRecognised', () => {
    for (const field of PROTECTED_CONTEXT_FIELDS) {
      expect(isProtectedContextField(field)).toBe(true);
    }
    expect(isProtectedContextField('harmless')).toBe(false);
  });

  it('SanitizedHints_AreFrozen', () => {
    const cleaned = sanitizeUntrustedHints({ a: 1 });
    expect(Object.isFrozen(cleaned)).toBe(true);
  });

  it('HandlesUndefinedMeta', () => {
    expect(sanitizeUntrustedHints(undefined)).toEqual({});
  });
});

describe('request-context — callers cannot self-assert identity', () => {
  it('Context_IdentityComesFromSnapshotNotCallerMeta', () => {
    const snap = snapshot();
    const ctx = deriveRequestContext(snap, {
      role: 'operator',
      subjectId: 'attacker-controlled',
      timestamp: 'forged',
      note: 'legit-hint',
    });
    // Identity is the frozen snapshot's — the caller's claims are ignored.
    expect(ctx.authorization).toBe(snap);
    expect(contextSubjectId(ctx)).toBe(snap.identity.subjectId);
    expect(contextSubjectId(ctx)).not.toBe('attacker-controlled');
    // The role/timestamp reflect the derived snapshot, never the caller.
    expect(ctx.authorization.identity.role).toBe('operator'); // local-operator derivation
    expect(ctx.authorization.resolvedAt).toBe('2026-01-01T00:00:00.000Z');
    // Only the harmless hint survives.
    expect(ctx.hints).toEqual({ note: 'legit-hint' });
  });

  it('Context_IsFrozen', () => {
    const ctx = deriveRequestContext(snapshot());
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe('request-context — canonical request digest', () => {
  it('CanonicalJson_IsKeyOrderIndependent', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: { y: 1, x: 2 } })).toBe(canonicalJson({ a: { x: 2, y: 1 } }));
  });

  it('CanonicalJson_PreservesArrayOrder', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('RequestDigest_IsDeterministicAndOrderIndependent', () => {
    expect(requestDigest({ a: 1, b: 2 })).toBe(requestDigest({ b: 2, a: 1 }));
    expect(requestDigest({ a: 1 })).not.toBe(requestDigest({ a: 2 }));
    expect(requestDigest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('request-context — replay identity / idempotency', () => {
  function ctxFor(stateDir: string): AuthenticatedRequestContext {
    return deriveRequestContext(snapshot(stateDir));
  }

  it('ReplayIdentity_BindsSubjectFromContext', () => {
    const ctx = ctxFor('C:/state-a');
    const id = deriveReplayIdentity(ctx, 'key-1', { action: 'x' });
    expect(id.subjectId).toBe(contextSubjectId(ctx));
    expect(id.idempotencyKey).toBe('key-1');
    expect(id.requestDigest).toMatch(/^sha256:/);
  });

  it('ReplayIdentity_RejectsEmptyKey', () => {
    expect(() => deriveReplayIdentity(ctxFor('C:/state-a'), '', {})).toThrow(/non-empty/);
  });

  it('FirstClaim_Executes', () => {
    const ledger = new ReplayLedger<number>();
    const id = deriveReplayIdentity(ctxFor('C:/state-a'), 'k', { n: 1 });
    const exec = vi.fn(() => 7);
    const out = ledger.claim(id, exec);
    expect(out.status).toBe('executed');
    expect(out).toMatchObject({ result: 7 });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('Replay_ReturnsStoredResult_WithoutReExecuting', () => {
    // The one real guarantee: a replay NEVER runs a silently-different second
    // execution — it returns the canonical stored result.
    const ledger = new ReplayLedger<number>();
    const ctx = ctxFor('C:/state-a');
    const id = deriveReplayIdentity(ctx, 'k', { n: 1 });
    const exec = vi.fn(() => 7);
    ledger.claim(id, exec);
    const second = ledger.claim(id, vi.fn(() => 999)); // would differ if it ran
    expect(second.status).toBe('replayed');
    expect(second).toMatchObject({ result: 7 });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('SubjectConflict_WithheldResult_NoExecution', () => {
    const ledger = new ReplayLedger<number>();
    const first = deriveReplayIdentity(ctxFor('C:/state-a'), 'shared-key', { n: 1 });
    const other = deriveReplayIdentity(ctxFor('C:/state-B-different'), 'shared-key', { n: 1 });
    expect(first.subjectId).not.toBe(other.subjectId);
    ledger.claim(first, () => 7);
    const attackerExec = vi.fn(() => 13);
    const out = ledger.claim(other, attackerExec);
    expect(out.status).toBe('conflict');
    if (out.status === 'conflict') {
      expect(out.error.code).toBe('IDEMPOTENCY_SUBJECT_CONFLICT');
      expect(out.error.layer).toBe('task');
    }
    // Nothing runs, and the stored result is not disclosed.
    expect(attackerExec).not.toHaveBeenCalled();
  });

  it('PayloadConflict_SameSubjectDifferentPayload_NoExecution', () => {
    const ledger = new ReplayLedger<number>();
    const ctx = ctxFor('C:/state-a');
    const first = deriveReplayIdentity(ctx, 'k', { n: 1 });
    const changed = deriveReplayIdentity(ctx, 'k', { n: 2 });
    expect(first.requestDigest).not.toBe(changed.requestDigest);
    ledger.claim(first, () => 7);
    const exec2 = vi.fn(() => 42);
    const out = ledger.claim(changed, exec2);
    expect(out.status).toBe('conflict');
    if (out.status === 'conflict') {
      expect(out.error.code).toBe('IDEMPOTENCY_PAYLOAD_CONFLICT');
    }
    expect(exec2).not.toHaveBeenCalled();
  });
});

// @oracle-sources: canonical framed messages, actual SQLite original claims, and Ed25519 verification
/** Closed protocol and durable claims refuse ambiguity before any execution authority. */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';
import { isProtectedVerifierFile } from '../../src/runtime/verification-host/provisioning.js';
import * as authorization from '../../src/runtime/verification-host/authorization.js';
import { createVerificationDispositions } from '../../src/runtime/verification-host/dispositions.js';
import { VerificationClaims } from '../../src/runtime/verification-host/claims.js';
import { verificationKey, verificationDigest, verificationFrameReader, encodeVerificationFrame, VERIFIER_FRAME_LIMIT, signVerification, signVerificationReply, authenticateVerificationReply, verifierSignerId, VERIFIER_VERSION, type VerificationRequest } from '../../src/contract/verification/harness-verification.js';

/** Construct complete immutable terms without providing executable input. */
function request(): VerificationRequest {
  const original = { version: 1 as const, operation: 'probe' as const, resourceId: 'tree', profileId: 'probe', subject: {
    streamId: 'stream', phaseAttemptId: 'phase', taskId: 'task', leafId: 'leaf', operationId: 'original-operation',
    preparedDigest: 'a'.repeat(64), callerDigest: 'b'.repeat(64), segmentDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64), profileDigest: 'e'.repeat(64), testSelectionDigest: 'f'.repeat(64),
    baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), blockerHeads: [],
  } };
  return { ...original, key: verificationKey(original) };
}

describe('private verifier protocol', () => {
  it('Framing_ExactBoundAndMalformedBytesRefuseBeforeDecode', () => {
    const file = { isFile: () => true, nlink: 1, uid: 1001, mode: 0o600, size: 32 };
    expect(isProtectedVerifierFile(file, 1001)).toBe(true);
    expect(isProtectedVerifierFile(file, 1002)).toBe(false);
    const exact = encodeVerificationFrame('x'.repeat(VERIFIER_FRAME_LIMIT - 2));
    expect(exact.length).toBe(VERIFIER_FRAME_LIMIT + 4);
    const split = verificationFrameReader();
    for (const byte of exact) split.push(Uint8Array.of(byte));
    expect(split.finish()).toBe('x'.repeat(VERIFIER_FRAME_LIMIT - 2));
    expect(() => encodeVerificationFrame('x'.repeat(VERIFIER_FRAME_LIMIT - 1))).toThrow();
    for (const bytes of [Buffer.from([0, 1, 0, 1]), Buffer.concat([exact, Buffer.from([0])]), Buffer.from([0, 0, 0, 2, 0xc0, 0xaf])]) {
      const reader = verificationFrameReader();
      expect(() => { reader.push(bytes); reader.finish(); }).toThrow();
    }
    const truncated = verificationFrameReader(); truncated.push(exact.subarray(0, -1));
    expect(() => truncated.finish()).toThrow();
  });

  it('Claims_StableOperationAliasesAndUnknownLeasesSurviveRestart', async () => {
    const root = makeTempDir('1928-claims-');
    let claims = new VerificationClaims(root);
    try {
      const original = request();
      const digest = verificationDigest(original);
      expect(claims.acquire(original, digest, ['device:inode'])).toBeUndefined();
      expect(claims.acquire(original, digest, ['device:inode'])).toEqual({ kind: 'incomplete', key: original.key, digest });
      const changed = { ...original, resourceId: 'alias', subject: { ...original.subject, segmentDigest: '9'.repeat(64) } };
      changed.key = verificationKey(changed);
      expect(changed.key).not.toBe(original.key);
      expect(claims.acquire(changed, verificationDigest(changed), ['device:inode'])).toEqual({ kind: 'conflict' });
      const different = { ...original, subject: { ...original.subject, operationId: 'different-operation' } };
      different.key = verificationKey(different);
      expect(claims.acquire(different, verificationDigest(different), ['device:inode'])).toEqual({ kind: 'busy' });
      claims.close(); claims = new VerificationClaims(root);
      expect(claims.lookup(original.key, digest)).toEqual({ kind: 'incomplete', key: original.key, digest });
      expect(claims.acquire(different, verificationDigest(different), ['device:inode'])).toEqual({ kind: 'busy' });
      claims.close();
      const sqlite = new Database(join(root, 'verifier.sqlite'));
      try {
        sqlite.query('UPDATE claims SET terminal=? WHERE key=?').run(JSON.stringify({ kind: 'absent' }), original.key);
      } finally { sqlite.close(); }
      claims = new VerificationClaims(root);
      expect(() => claims.lookup(original.key, digest)).toThrow();
      expect(claims.acquire(different, verificationDigest(different), ['device:inode'])).toEqual({ kind: 'busy' });
    } finally { claims.close(); await rmrfAsync(root); }
  });

  it('AuthorizationFailure_RereadsAConcurrentOriginalClaim', async () => {
    const root = makeTempDir('1928-auth-race-');
    const signer = generateKeyPairSync('ed25519');
    const publicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signerId = verifierSignerId(publicKey);
    const token = 'disposable-race-fixture-credential';
    const service = createVerificationDispositions({
      token, privateKey: signer.privateKey, signerId, provisioningPath: join(root, 'host.json'),
      policy: { version: 1, socketPath: join(root, 'socket'), stateDir: root, publicKey,
        tokenPath: join(root, 'token'), privateKeyPath: join(root, 'key'), bwrapPath: '/usr/bin/bwrap',
        gitPath: '/usr/bin/git', runtimePaths: ['/usr'], profiles: [], resources: [] },
    });
    const winner = new VerificationClaims(root);
    let failAuthorization: (reason: Error) => void = () => { throw new Error('Authorization did not pause'); };
    const authorizationGate = new Promise<never>((_, reject) => { failAuthorization = reject; });
    const paused = vi.spyOn(authorization, 'authorizeVerification').mockReturnValueOnce(authorizationGate);
    try {
      const original = request();
      const digest = verificationDigest(original);
      const delayed = service.handle({ version: 1, action: 'submit', token, request: original });
      expect(paused).toHaveBeenCalledTimes(1);
      expect(winner.acquire(original, digest, ['device:inode'])).toBeUndefined();
      const signed = signVerification({
        version: 1, hostVersion: VERIFIER_VERSION, signerId, request: original, requestDigest: digest,
        hostPolicyDigest: '1'.repeat(64), resources: [{ path: root, device: 'device', inode: 'inode' }],
        completedAt: '2026-11-14T00:00:00.000Z',
        outcome: { status: 'passed', exitCode: 0, reason: 'Fixture original', stdoutBase64: '', stderrBase64: '' },
      }, signer.privateKey);
      winner.complete(original.key, digest, { kind: 'evidence', signed });
      failAuthorization(new Error('Fixture checkout moved during authorization'));
      expect(authenticateVerificationReply(await delayed, publicKey, original.key, digest).response)
        .toEqual({ kind: 'evidence', signed });
    } finally {
      paused.mockRestore();
      winner.close();
      await service.close();
      await rmrfAsync(root);
    }
  });

  it('SignedStatuses_ExactSubjectAndSignerCannotBeSubstituted', () => {
    const signer = generateKeyPairSync('ed25519');
    const publicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const original = request(); const digest = verificationDigest(original);
    for (const response of [{ kind: 'absent' as const }, { kind: 'conflict' as const }, { kind: 'busy' as const }, { kind: 'incomplete' as const, key: original.key, digest }]) {
      const signed = signVerificationReply(original.key, digest, response, signer.privateKey);
      expect(authenticateVerificationReply(signed, publicKey, original.key, digest)).toEqual(signed);
      expect(() => authenticateVerificationReply(signed, publicKey, original.key, '9'.repeat(64))).toThrow();
      expect(() => authenticateVerificationReply({ ...signed, response: { kind: 'refused', reason: 'forged' } }, publicKey, original.key, digest)).toThrow();
      const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
      expect(() => authenticateVerificationReply(signed, other, original.key, digest)).toThrow();
    }
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  SIGNATURE_ALGORITHM,
  TrustRootSet,
  signDetached,
  type DetachedSignature,
} from '../../../../src/runtime/extensions/trust-root.js';

function makeKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

describe('TrustRootSet.verify (P03-08 trust chaining)', () => {
  const payload = Buffer.from('signed body bytes');

  it('TrustRoot_ValidSignature_ChainsToRoot', () => {
    const keys = makeKeyPair();
    const roots = new TrustRootSet([
      { keyId: 'root.a', algorithm: SIGNATURE_ALGORITHM, publicKeyPem: keys.publicKeyPem },
    ]);
    const signature: DetachedSignature = {
      keyId: 'root.a',
      algorithm: SIGNATURE_ALGORITHM,
      value: signDetached(keys.privateKeyPem, payload),
    };
    const result = roots.verify(signature, payload);
    expect(result.trusted).toBe(true);
  });

  it('TrustRoot_TamperedBytes_FailsClosed', () => {
    const keys = makeKeyPair();
    const roots = new TrustRootSet([
      { keyId: 'root.a', algorithm: SIGNATURE_ALGORITHM, publicKeyPem: keys.publicKeyPem },
    ]);
    const signature: DetachedSignature = {
      keyId: 'root.a',
      algorithm: SIGNATURE_ALGORITHM,
      value: signDetached(keys.privateKeyPem, payload),
    };
    const result = roots.verify(signature, Buffer.from('tampered body bytes'));
    expect(result.trusted).toBe(false);
  });

  it('TrustRoot_UnknownKeyId_FailsClosed', () => {
    const keys = makeKeyPair();
    const roots = new TrustRootSet([
      { keyId: 'root.a', algorithm: SIGNATURE_ALGORITHM, publicKeyPem: keys.publicKeyPem },
    ]);
    const signature: DetachedSignature = {
      keyId: 'root.unknown',
      algorithm: SIGNATURE_ALGORITHM,
      value: signDetached(keys.privateKeyPem, payload),
    };
    const result = roots.verify(signature, payload);
    expect(result.trusted).toBe(false);
    if (!result.trusted) expect(result.detail).toContain('no configured trust root');
  });

  it('TrustRoot_SignedByDifferentKey_FailsClosed', () => {
    const configured = makeKeyPair();
    const attacker = makeKeyPair();
    const roots = new TrustRootSet([
      {
        keyId: 'root.a',
        algorithm: SIGNATURE_ALGORITHM,
        publicKeyPem: configured.publicKeyPem,
      },
    ]);
    // Attacker signs with their own key but claims the configured root's id.
    const signature: DetachedSignature = {
      keyId: 'root.a',
      algorithm: SIGNATURE_ALGORITHM,
      value: signDetached(attacker.privateKeyPem, payload),
    };
    const result = roots.verify(signature, payload);
    expect(result.trusted).toBe(false);
  });

  it('TrustRoot_MalformedSignature_FailsClosedWithoutThrowing', () => {
    const keys = makeKeyPair();
    const roots = new TrustRootSet([
      { keyId: 'root.a', algorithm: SIGNATURE_ALGORITHM, publicKeyPem: keys.publicKeyPem },
    ]);
    const signature: DetachedSignature = {
      keyId: 'root.a',
      algorithm: SIGNATURE_ALGORITHM,
      value: 'not-a-real-signature',
    };
    const result = roots.verify(signature, payload);
    expect(result.trusted).toBe(false);
  });

  it('TrustRoot_DuplicateKeyId_RejectedAtConstruction', () => {
    const keys = makeKeyPair();
    expect(
      () =>
        new TrustRootSet([
          { keyId: 'root.a', algorithm: SIGNATURE_ALGORITHM, publicKeyPem: keys.publicKeyPem },
          { keyId: 'root.a', algorithm: SIGNATURE_ALGORITHM, publicKeyPem: keys.publicKeyPem },
        ]),
    ).toThrow(/duplicate trust root/);
  });
});

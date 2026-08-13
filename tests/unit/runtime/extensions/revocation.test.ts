import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { ExtensionIdSchema } from '../../../../src/runtime/extensions/manifest.js';
import {
  RevocationListBodyV1Schema,
  buildSignedRevocationList,
  evaluateRevocation,
  type RevocationContext,
} from '../../../../src/runtime/extensions/revocation.js';
import { SIGNATURE_ALGORITHM, TrustRootSet } from '../../../../src/runtime/extensions/trust-root.js';

const NOW = 1_700_000_000_000;
const HORIZON = 60_000;

function makeSigner(keyId: string): {
  keyId: string;
  privateKeyPem: string;
  publicKeyPem: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { keyId, privateKeyPem: privateKey, publicKeyPem: publicKey };
}

const signer = makeSigner('root.rev');
const trustRoots = new TrustRootSet([
  { keyId: signer.keyId, algorithm: SIGNATURE_ALGORITHM, publicKeyPem: signer.publicKeyPem },
]);

const EXT = ExtensionIdSchema.parse('ext.demo');

function signedList(overrides: {
  issuedAt?: number;
  expiresAt?: number;
  revoked?: ReadonlyArray<{ extensionId: string; version?: number }>;
}) {
  const body = RevocationListBodyV1Schema.parse({
    schemaVersion: '1',
    issuedAt: overrides.issuedAt ?? NOW - 1_000,
    expiresAt: overrides.expiresAt ?? NOW + 3_600_000,
    revoked: overrides.revoked ?? [],
  });
  return buildSignedRevocationList(body, signer);
}

function context(overrides: Partial<RevocationContext>): RevocationContext {
  return {
    list: signedList({}),
    trustRoots,
    nowMillis: NOW,
    freshnessHorizonMillis: HORIZON,
    ...overrides,
  };
}

describe('evaluateRevocation (P03-08 revocation + freshness)', () => {
  it('Revocation_FreshListNotListed_Clear', () => {
    expect(evaluateRevocation(context({}), EXT, 3).status).toBe('clear');
  });

  it('Revocation_ListedAllVersions_Revoked', () => {
    const list = signedList({ revoked: [{ extensionId: EXT }] });
    expect(evaluateRevocation(context({ list }), EXT, 3).status).toBe('revoked');
  });

  it('Revocation_ListedSpecificVersion_RevokedOnlyThatVersion', () => {
    const list = signedList({ revoked: [{ extensionId: EXT, version: 3 }] });
    expect(evaluateRevocation(context({ list }), EXT, 3).status).toBe('revoked');
    expect(evaluateRevocation(context({ list }), EXT, 4).status).toBe('clear');
  });

  it('Revocation_MissingList_Unavailable', () => {
    expect(evaluateRevocation(context({ list: undefined }), EXT, 3).status).toBe(
      'unavailable',
    );
  });

  it('Revocation_StalePastHorizon_Unavailable', () => {
    // Validly signed and unexpired, but older than the freshness horizon.
    const list = signedList({ issuedAt: NOW - (HORIZON + 1), expiresAt: NOW + 3_600_000 });
    const result = evaluateRevocation(context({ list }), EXT, 3);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.detail).toContain('stale');
  });

  it('Revocation_Expired_Unavailable', () => {
    const list = signedList({ issuedAt: NOW - 10, expiresAt: NOW - 1 });
    expect(evaluateRevocation(context({ list }), EXT, 3).status).toBe('unavailable');
  });

  it('Revocation_FutureDated_Unavailable', () => {
    const list = signedList({ issuedAt: NOW + 10_000, expiresAt: NOW + 3_600_000 });
    expect(evaluateRevocation(context({ list }), EXT, 3).status).toBe('unavailable');
  });

  it('Revocation_ForgedSignature_Unavailable', () => {
    // Signed by a key that is NOT a configured trust root: a forged "fresh"
    // list must not be trusted to clear (or mask) revocations.
    const attacker = makeSigner('root.attacker');
    const body = RevocationListBodyV1Schema.parse({
      schemaVersion: '1',
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 3_600_000,
      revoked: [],
    });
    const forged = buildSignedRevocationList(body, attacker);
    const result = evaluateRevocation(context({ list: forged }), EXT, 3);
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') expect(result.detail).toContain('signature');
  });
});

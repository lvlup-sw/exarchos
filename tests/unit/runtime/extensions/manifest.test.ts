import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  ExtensionManifestBodyV1Schema,
  buildSignedManifest,
  canonicalBodyBytes,
  canonicalManifestBytes,
  parseManifest,
  verifyContentDigest,
  type ExtensionManifestBodyV1,
} from '../../../../src/runtime/extensions/manifest.js';

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeSigner(keyId: string): { keyId: string; privateKeyPem: string } {
  const { privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { keyId, privateKeyPem: privateKey };
}

const CONTENT = Buffer.from('extension code');

const BODY: ExtensionManifestBodyV1 = ExtensionManifestBodyV1Schema.parse({
  schemaVersion: '1',
  extensionId: 'ext.demo',
  version: 2,
  contentDigest: { algorithm: 'sha256', value: sha256Hex(CONTENT) },
  quota: {
    maxContentBytes: 1_000,
    maxMemoryBytes: 10_000,
    maxRuntimeMillis: 5_000,
    maxConcurrency: 2,
  },
  isolation: { allowedCapabilities: ['fs:read'], filesystem: 'worktree', network: false },
});

describe('manifest schema + helpers (P03-08)', () => {
  it('Manifest_BuildSigned_ParsesRoundTrip', () => {
    const manifest = buildSignedManifest(BODY, makeSigner('root.a'));
    const parsed = parseManifest(manifest);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifest.extensionId).toBe('ext.demo');
      expect(parsed.manifest.signature.algorithm).toBe('ed25519');
    }
  });

  it('Manifest_MissingField_FailsToParse', () => {
    const manifest = buildSignedManifest(BODY, makeSigner('root.a'));
    const { version, ...withoutVersion } = manifest;
    void version;
    expect(parseManifest(withoutVersion).ok).toBe(false);
  });

  it('Manifest_UnknownField_FailsToParse', () => {
    const manifest = buildSignedManifest(BODY, makeSigner('root.a'));
    expect(parseManifest({ ...manifest, extra: 'nope' }).ok).toBe(false);
  });

  it('Manifest_CanonicalBytesMatchBodyBytes', () => {
    const manifest = buildSignedManifest(BODY, makeSigner('root.a'));
    // The bytes signed and the bytes re-derived for verification must match.
    expect(canonicalManifestBytes(manifest).equals(canonicalBodyBytes(BODY))).toBe(true);
  });

  it('VerifyContentDigest_MatchingBytes_True', () => {
    expect(verifyContentDigest(CONTENT, BODY.contentDigest)).toBe(true);
  });

  it('VerifyContentDigest_MutatedBytes_False', () => {
    expect(verifyContentDigest(Buffer.from('mutated'), BODY.contentDigest)).toBe(false);
  });
});

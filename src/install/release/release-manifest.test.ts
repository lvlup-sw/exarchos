import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  SIGNATURE_ALGORITHM,
  TrustRootSet,
} from '../../runtime/extensions/trust-root.js';
import { buildInstallIdentity, digestText } from '../install-identity.js';
import {
  digestAssetBytes,
  manifestSigningBytes,
  manifestToCanonical,
  parseSignedManifest,
  serializeSignedManifest,
  signReleaseManifest,
  ReleaseManifestSchema,
  type ReleaseManifest,
} from './release-manifest.js';
import { canonicalBytes } from '../../runtime/extensions/canonical.js';

const COMMIT = 'b'.repeat(40);
const CONTRACT_DIGEST = `sha256:${'c'.repeat(64)}`;

function makeKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

const ASSET_BYTES = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x0d, 0x0a, 0x00, 0x0a]);

function makeManifest(): ReleaseManifest {
  const install = buildInstallIdentity({
    binaryVersion: '2.12.0-preview.3',
    binaryEntries: [{ path: 'bin/exarchos', content: 'binary-content' }],
    pluginManifest: '{"name":"exarchos"}',
    skillEntries: [{ path: 'skills/a/SKILL.md', content: '# skill' }],
    schemaVersion: 7,
    cacheLocation: '/home/u/.cache/exarchos',
    cacheEntries: [{ path: 'cache/x', content: 'y' }],
  });
  return ReleaseManifestSchema.parse({
    manifestVersion: 1,
    version: '2.12.0-preview.3',
    source: { commit: COMMIT, treeDigest: digestText('tree') },
    contract: { digest: CONTRACT_DIGEST, approvedBy: 'P03-01', authorityCount: 6 },
    install,
    assets: [
      {
        name: 'exarchos-linux-x64',
        os: 'linux',
        arch: 'x64',
        size: ASSET_BYTES.length,
        digest: digestAssetBytes(ASSET_BYTES),
      },
    ],
  });
}

describe('digestAssetBytes (raw-byte asset digest)', () => {
  it('AssetDigest_IsDeterministic', () => {
    expect(digestAssetBytes(ASSET_BYTES)).toBe(digestAssetBytes(ASSET_BYTES));
    expect(digestAssetBytes(ASSET_BYTES)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('AssetDigest_DoesNotNormalizeLineEndings_UnlikeTextDigest', () => {
    // Raw byte digest MUST treat CRLF and LF as different (binaries are not text).
    const crlf = digestAssetBytes(new Uint8Array([0x41, 0x0d, 0x0a, 0x42]));
    const lf = digestAssetBytes(new Uint8Array([0x41, 0x0a, 0x42]));
    expect(crlf).not.toBe(lf);
    // Sanity: the P05-04 TEXT digest DOES normalize them (opposite behavior).
    expect(digestText('A\r\nB')).toBe(digestText('A\nB'));
  });
});

describe('signReleaseManifest / verify round-trip', () => {
  it('SignedManifest_VerifiesAgainstConfiguredRoot', () => {
    const keys = makeKeyPair();
    const signed = signReleaseManifest(makeManifest(), 'publisher.a', keys.privateKeyPem);
    const roots = new TrustRootSet([
      { keyId: 'publisher.a', algorithm: SIGNATURE_ALGORITHM, publicKeyPem: keys.publicKeyPem },
    ]);
    const result = roots.verify(signed.signature, manifestSigningBytes(signed.manifest));
    expect(result.trusted).toBe(true);
  });

  it('SigningBytes_ExcludeSignature_AndSurviveSerializeParse', () => {
    const keys = makeKeyPair();
    const signed = signReleaseManifest(makeManifest(), 'publisher.a', keys.privateKeyPem);
    const roundTripped = parseSignedManifest(serializeSignedManifest(signed));
    // Bytes derived from the parsed manifest equal bytes from the original —
    // transport/formatting is irrelevant, only the manifest body is signed.
    expect(manifestSigningBytes(roundTripped.manifest).equals(manifestSigningBytes(signed.manifest))).toBe(true);
    expect(roundTripped.signature.value).toBe(signed.signature.value);
  });

  it('Canonicalization_IsKeyOrderIndependent', () => {
    const a = manifestSigningBytes(makeManifest());
    // Rebuild the same manifest with keys inserted in a different order.
    const m = makeManifest();
    const reordered: ReleaseManifest = ReleaseManifestSchema.parse({
      assets: m.assets,
      install: m.install,
      contract: m.contract,
      source: m.source,
      version: m.version,
      manifestVersion: m.manifestVersion,
    });
    expect(manifestSigningBytes(reordered).equals(a)).toBe(true);
    // toCanonical returns a stable serialization too.
    expect(canonicalBytes(manifestToCanonical(reordered)).equals(a)).toBe(true);
  });
});

describe('reproducibility exit-proof (a): two independent builds match', () => {
  it('IndependentManifestBuilds_ProduceByteIdenticalDigests', () => {
    // Two independent "builds" from identical source inputs must be byte-identical:
    // deterministic canonical JSON + deterministic (Ed25519) signature.
    const keys = makeKeyPair();
    const buildOne = signReleaseManifest(makeManifest(), 'publisher.a', keys.privateKeyPem);
    const buildTwo = signReleaseManifest(makeManifest(), 'publisher.a', keys.privateKeyPem);

    expect(serializeSignedManifest(buildOne)).toBe(serializeSignedManifest(buildTwo));
    expect(manifestSigningBytes(buildOne.manifest).equals(manifestSigningBytes(buildTwo.manifest))).toBe(true);
    expect(buildOne.signature.value).toBe(buildTwo.signature.value);
  });
});

describe('parseSignedManifest fails closed', () => {
  it('ParseSignedManifest_RejectsNonJson', () => {
    expect(() => parseSignedManifest('not json {')).toThrow(/not valid JSON/);
  });

  it('ParseSignedManifest_RejectsMalformedShape', () => {
    // Well-formed JSON but missing the signature / wrong manifest shape.
    expect(() => parseSignedManifest(JSON.stringify({ manifest: { manifestVersion: 1 } }))).toThrow();
  });

  it('ParseSignedManifest_RejectsWrongSignatureAlgorithm', () => {
    const keys = makeKeyPair();
    const signed = signReleaseManifest(makeManifest(), 'publisher.a', keys.privateKeyPem);
    const tampered = JSON.parse(serializeSignedManifest(signed)) as Record<string, unknown>;
    (tampered.signature as Record<string, unknown>).algorithm = 'rsa';
    expect(() => parseSignedManifest(JSON.stringify(tampered))).toThrow();
  });
});

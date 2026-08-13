import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { SIGNATURE_ALGORITHM, TrustRootSet } from '../../runtime/extensions/trust-root.js';
import { buildInstallIdentity, digestText } from '../install-identity.js';
import type { SourceIdentity, ContractIdentity } from './build-identity.js';
import {
  digestAssetBytes,
  signReleaseManifest,
  ReleaseManifestSchema,
  type ReleaseManifest,
  type SignedReleaseManifest,
} from './release-manifest.js';
import { verifyReleaseInstall, type VerifyReleaseInputs, type ObservedAsset } from './installer-verify.js';

function makeKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

const SOURCE: SourceIdentity = { commit: 'd'.repeat(40), treeDigest: digestText('tree-content') };
const CONTRACT: ContractIdentity = {
  digest: `sha256:${'e'.repeat(64)}`,
  approvedBy: 'P03-01',
  authorityCount: 6,
};
const ASSET_NAME = 'exarchos-linux-x64';
const ASSET_BYTES = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x0d, 0x0a]);
const ASSET_DIGEST = digestAssetBytes(ASSET_BYTES);

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
    source: SOURCE,
    contract: CONTRACT,
    install,
    assets: [
      { name: ASSET_NAME, os: 'linux', arch: 'x64', size: ASSET_BYTES.length, digest: ASSET_DIGEST },
    ],
  });
}

interface Fixture {
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly trustRoots: TrustRootSet;
  readonly signed: SignedReleaseManifest;
}

/** A fully valid, trusted, signed fixture. Each test perturbs exactly one seam. */
function makeFixture(): Fixture {
  const keyId = 'publisher.a';
  const keys = makeKeyPair();
  const signed = signReleaseManifest(makeManifest(), keyId, keys.privateKeyPem);
  const trustRoots = new TrustRootSet([
    { keyId, algorithm: SIGNATURE_ALGORITHM, publicKeyPem: keys.publicKeyPem },
  ]);
  return { keyId, privateKeyPem: keys.privateKeyPem, trustRoots, signed };
}

function validInputs(f: Fixture): VerifyReleaseInputs {
  const observedAssets = new Map<string, ObservedAsset>([[ASSET_NAME, { digest: ASSET_DIGEST }]]);
  return {
    signed: f.signed,
    trustRoots: f.trustRoots,
    expectedSource: SOURCE,
    expectedContract: CONTRACT,
    observedAssets,
  };
}

describe('verifyReleaseInstall — exit-proof (f): a valid manifest verifies', () => {
  it('ValidManifest_Verifies', () => {
    const f = makeFixture();
    const result = verifyReleaseInstall(validInputs(f));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.keyId).toBe('publisher.a');
  });
});

describe('verifyReleaseInstall — exit-proof (b): source mismatch rejected', () => {
  it('SourceMismatch_RejectedEvenWhenValidlySigned', () => {
    const f = makeFixture();
    // Manifest is untouched & validly signed; the installer expects a DIFFERENT source.
    const inputs: VerifyReleaseInputs = {
      ...validInputs(f),
      expectedSource: { commit: 'f'.repeat(40), treeDigest: digestText('other-tree') },
    };
    const result = verifyReleaseInstall(inputs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('source-mismatch');
  });

  it('SourceMismatch_OnTreeDigestAlone_Rejected', () => {
    const f = makeFixture();
    const inputs: VerifyReleaseInputs = {
      ...validInputs(f),
      expectedSource: { commit: SOURCE.commit, treeDigest: digestText('drifted-tree') },
    };
    const result = verifyReleaseInstall(inputs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('source-mismatch');
  });
});

describe('verifyReleaseInstall — exit-proof (c): contract mismatch rejected', () => {
  it('ContractMismatch_RejectedEvenWhenValidlySigned', () => {
    const f = makeFixture();
    const inputs: VerifyReleaseInputs = {
      ...validInputs(f),
      expectedContract: { digest: `sha256:${'9'.repeat(64)}`, approvedBy: 'P03-01', authorityCount: 6 },
    };
    const result = verifyReleaseInstall(inputs);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('contract-mismatch');
  });
});

describe('verifyReleaseInstall — exit-proof (d): manifest tamper / bad signature rejected', () => {
  it('TamperedManifestBody_FailsSignature', () => {
    const f = makeFixture();
    // Mutate the manifest AFTER signing — the signature no longer covers these bytes.
    const tamperedManifest = ReleaseManifestSchema.parse({
      ...f.signed.manifest,
      version: '9.9.9-evil',
    });
    const tampered: SignedReleaseManifest = { manifest: tamperedManifest, signature: f.signed.signature };
    const result = verifyReleaseInstall({ ...validInputs(f), signed: tampered });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('manifest-signature');
  });

  it('SignedByUntrustedKey_FailsSignature', () => {
    const f = makeFixture();
    const attacker = makeKeyPair();
    // Attacker re-signs the (unchanged) manifest with their own key, claiming the publisher id.
    const rogue = signReleaseManifest(f.signed.manifest, 'publisher.a', attacker.privateKeyPem);
    const result = verifyReleaseInstall({ ...validInputs(f), signed: rogue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('manifest-signature');
  });

  it('UnknownSigningKeyId_FailsSignature', () => {
    const f = makeFixture();
    const other = makeKeyPair();
    const signed = signReleaseManifest(f.signed.manifest, 'publisher.unknown', other.privateKeyPem);
    const result = verifyReleaseInstall({ ...validInputs(f), signed });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('manifest-signature');
  });
});

describe('verifyReleaseInstall — exit-proof (e): asset digest mismatch rejected', () => {
  it('AssetDigestMismatch_Rejected', () => {
    const f = makeFixture();
    const observedAssets = new Map<string, ObservedAsset>([
      [ASSET_NAME, { digest: digestAssetBytes(new Uint8Array([0x00, 0x01, 0x02])) }],
    ]);
    const result = verifyReleaseInstall({ ...validInputs(f), observedAssets });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('asset-digest');
  });

  it('DownloadedAssetNotInManifest_Rejected', () => {
    const f = makeFixture();
    const observedAssets = new Map<string, ObservedAsset>([
      ['exarchos-darwin-arm64', { digest: ASSET_DIGEST }],
    ]);
    const result = verifyReleaseInstall({ ...validInputs(f), observedAssets });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('asset-digest');
  });

  it('NoAssetsPresented_Rejected', () => {
    const f = makeFixture();
    const result = verifyReleaseInstall({ ...validInputs(f), observedAssets: new Map() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('asset-digest');
  });
});

describe('verifyReleaseInstall — rejection priority is stable', () => {
  it('SignatureCheckedBeforeIdentity', () => {
    // Both a bad signature AND a source mismatch present → signature wins (checked first).
    const f = makeFixture();
    const attacker = makeKeyPair();
    const rogue = signReleaseManifest(f.signed.manifest, 'publisher.a', attacker.privateKeyPem);
    const result = verifyReleaseInstall({
      ...validInputs(f),
      signed: rogue,
      expectedSource: { commit: 'f'.repeat(40), treeDigest: digestText('other') },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('manifest-signature');
  });
});

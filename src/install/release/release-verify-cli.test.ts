import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildInstallIdentity, digestText } from '../install-identity.js';
import {
  buildReleaseManifest,
  releaseAssetFromBytes,
  serializeSignedManifest,
  signReleaseManifest,
  type SignedReleaseManifest,
} from './release-manifest.js';
import type { SourceIdentity, ContractIdentity } from './build-identity.js';
import { runReleaseVerify, type ReleaseVerifyIo } from './release-verify-cli.js';

const SOURCE: SourceIdentity = { commit: '1'.repeat(40), treeDigest: digestText('tree') };
const CONTRACT: ContractIdentity = {
  digest: `sha256:${'a'.repeat(64)}`,
  approvedBy: 'P03-01',
  authorityCount: 6,
};
const ASSET_BYTES = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x0d, 0x0a]);

function makeKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

function makeSigned(privateKeyPem: string): SignedReleaseManifest {
  const install = buildInstallIdentity({
    binaryVersion: '2.12.0',
    binaryEntries: [{ path: 'bin/exarchos', content: 'x' }],
    pluginManifest: '{}',
    skillEntries: [{ path: 'skills/a', content: 'a' }],
    schemaVersion: 7,
    cacheLocation: '/c',
    cacheEntries: [{ path: 'c', content: 'c' }],
  });
  const manifest = buildReleaseManifest({
    version: '2.12.0',
    source: SOURCE,
    contract: CONTRACT,
    install,
    assets: [releaseAssetFromBytes('exarchos-linux-x64', 'linux', 'x64', ASSET_BYTES)],
  });
  return signReleaseManifest(manifest, 'publisher.a', privateKeyPem);
}

/** In-memory IO backed by a path→content map. */
function makeIo(files: {
  text?: Record<string, string>;
  bytes?: Record<string, Uint8Array>;
}): ReleaseVerifyIo {
  return {
    readText: (p: string): string => {
      const v = files.text?.[p];
      if (v === undefined) throw new Error(`no such text file: ${p}`);
      return v;
    },
    readBytes: (p: string): Uint8Array => {
      const v = files.bytes?.[p];
      if (v === undefined) throw new Error(`no such binary file: ${p}`);
      return v;
    },
  };
}

function baseArgs(): string[] {
  return [
    '--manifest', 'manifest.json',
    '--trust-root', 'publisher.a=pub.pem',
    '--expect-source', `${SOURCE.commit}#${SOURCE.treeDigest}`,
    '--expect-contract', CONTRACT.digest,
    '--asset', 'exarchos-linux-x64=asset.bin',
  ];
}

describe('runReleaseVerify (installer delegation CLI)', () => {
  it('CLI_ValidRelease_Exits0', () => {
    const keys = makeKeyPair();
    const io = makeIo({
      text: { 'manifest.json': serializeSignedManifest(makeSigned(keys.privateKeyPem)), 'pub.pem': keys.publicKeyPem },
      bytes: { 'asset.bin': ASSET_BYTES },
    });
    const outcome = runReleaseVerify(baseArgs(), io);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.message).toMatch(/verified/);
  });

  it('CLI_BadSignature_Exits2', () => {
    const keys = makeKeyPair();
    const attacker = makeKeyPair();
    const io = makeIo({
      text: {
        'manifest.json': serializeSignedManifest(makeSigned(keys.privateKeyPem)),
        // Trust root is the ATTACKER's key — the publisher signature won't chain.
        'pub.pem': attacker.publicKeyPem,
      },
      bytes: { 'asset.bin': ASSET_BYTES },
    });
    const outcome = runReleaseVerify(baseArgs(), io);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toMatch(/manifest-signature/);
  });

  it('CLI_AssetDigestMismatch_Exits2', () => {
    const keys = makeKeyPair();
    const io = makeIo({
      text: { 'manifest.json': serializeSignedManifest(makeSigned(keys.privateKeyPem)), 'pub.pem': keys.publicKeyPem },
      bytes: { 'asset.bin': new Uint8Array([0x00, 0x01]) }, // wrong bytes
    });
    const outcome = runReleaseVerify(baseArgs(), io);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toMatch(/asset-digest/);
  });

  it('CLI_ContractMismatch_Exits2', () => {
    const keys = makeKeyPair();
    const io = makeIo({
      text: { 'manifest.json': serializeSignedManifest(makeSigned(keys.privateKeyPem)), 'pub.pem': keys.publicKeyPem },
      bytes: { 'asset.bin': ASSET_BYTES },
    });
    const args = baseArgs();
    args[args.indexOf('--expect-contract') + 1] = `sha256:${'0'.repeat(64)}`;
    const outcome = runReleaseVerify(args, io);
    expect(outcome.exitCode).toBe(2);
    expect(outcome.message).toMatch(/contract-mismatch/);
  });

  it('CLI_MissingRequiredArg_Exits3', () => {
    const io = makeIo({});
    const outcome = runReleaseVerify(['--manifest', 'm.json'], io);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.message).toMatch(/usage error/);
  });

  it('CLI_MalformedManifest_Exits2_FailClosed', () => {
    const keys = makeKeyPair();
    const io = makeIo({
      text: { 'manifest.json': 'not json {', 'pub.pem': keys.publicKeyPem },
      bytes: { 'asset.bin': ASSET_BYTES },
    });
    const outcome = runReleaseVerify(baseArgs(), io);
    expect(outcome.exitCode).toBe(2);
  });
});

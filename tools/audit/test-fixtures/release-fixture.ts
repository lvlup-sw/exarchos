// ─── Local "release" fixture builder for the installer acceptance suite ──────
//
// DR-20 / T-28. The installers (`tools/release/get-exarchos.sh`, `get-exarchos.ps1`)
// must reject a release on FOUR independent dimensions (manifest signature,
// source identity, contract identity, asset digest) plus the release binding
// and the artifact's own `sourceState`. Proving that requires driving the real
// scripts against a real, signed, source-linked release — not a mock.
//
// This module materializes exactly that: a directory laid out like the GitHub
// Releases URL space (`download/<tag>/<asset>`) containing
//
//   - artifact bytes carrying a REAL `bun build --banner` build-identity stamp
//     (produced by `tools/release/build-release-manifest.ts:buildIdentityBanner`),
//   - a matching `.sha512` sidecar (so the pre-existing checksum gate passes
//     and cannot be what a fault is attributed to),
//   - a REAL Ed25519-signed `exarchos-release-manifest.json` built by the
//     production producer primitives, and
//   - the publisher public key plus an unrelated "wrong" key, so a test can
//     substitute the pinned trust root.
//
// Every fault is seeded ONE DIMENSION AT A TIME (`ReleaseFixtureOptions`), so a
// rejection can be attributed to exactly the check under test — the
// discriminating-probe pattern T-27 established.
//
// It lives under `tools/audit/test-fixtures/` deliberately: root `package.json`
// `files[]` carries `"!**/test-fixtures"`, so none of this ships to consumers.
//
// It is also directly invokable (`tsx tools/audit/test-fixtures/release-fixture.ts
// --out <dir>`) so the shell-native harnesses can build the same fixture
// without reimplementing signing.

import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILD_IDENTITY_MARKER,
  RELEASE_MANIFEST_FILENAME,
  buildIdentityBanner,
  collectContractIdentity,
  collectInstallIdentity,
  collectReleaseAssets,
  collectSourceIdentity,
  readPackageVersion,
  type EmbeddedBuildIdentity,
} from '../../release/build-release-manifest.js';
import {
  buildReleaseManifest,
  serializeSignedManifest,
  signReleaseManifest,
} from '../../../src/install/release/release-manifest.js';
import type {
  ContractIdentity,
  SourceIdentity,
} from '../../../src/install/release/build-identity.js';

/** Repo root, derived from this file's location (`tools/audit/test-fixtures/..`). */
export function fixtureRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** Key id the fixture signs with; mirrors the `EXARCHOS_RELEASE_KEY_ID` default. */
export const FIXTURE_KEY_ID = 'exarchos.release.v1';

/**
 * `collectSourceIdentity` digests every committed blob under
 * `SOURCE_TREE_ROOTS` (~1s). The acceptance suite builds a dozen fixtures that
 * all describe the same HEAD, so the collection is memoized per repo root.
 * Correctness is unaffected: both are pure functions of the committed tree,
 * which cannot change inside one test process.
 */
const identityCache = new Map<string, { source: SourceIdentity; contract: ContractIdentity }>();

function collectIdentitiesCached(repoRoot: string): {
  source: SourceIdentity;
  contract: ContractIdentity;
} {
  const hit = identityCache.get(repoRoot);
  if (hit !== undefined) return hit;
  const fresh = {
    source: collectSourceIdentity(repoRoot),
    contract: collectContractIdentity(repoRoot),
  };
  identityCache.set(repoRoot, fresh);
  return fresh;
}

/** Seeded, single-dimension faults. Every field defaults to "no fault". */
export interface ReleaseFixtureOptions {
  readonly outDir: string;
  /** Release asset filenames, e.g. `exarchos-linux-x64`. */
  readonly assets: readonly string[];
  /** Release tag the fixture is published under (default `v<pkg version>`). */
  readonly tag?: string;

  // ── faults seeded INTO THE ARTIFACT ──────────────────────────────────────
  /** `sourceState` stamped into the artifact (default `clean`). */
  readonly sourceState?: 'clean' | 'modified';
  /** Build-identity marker (default v2). Set to a v1 marker to test downgrade. */
  readonly marker?: string;
  /** Version stamped into the artifact (default root package.json version). */
  readonly embeddedVersion?: string;
  /** Emit an artifact with NO build-identity banner at all. */
  readonly omitIdentity?: boolean;

  // ── faults seeded INTO THE SIGNED MANIFEST (still validly signed) ────────
  readonly manifestCommit?: string;
  readonly manifestTreeDigest?: string;
  readonly manifestContractDigest?: string;
  readonly manifestVersion?: string;

  // ── faults seeded INTO THE SIGNATURE / BYTES ────────────────────────────
  /** Sign with a key the installer does not pin. */
  readonly signWithWrongKey?: boolean;
  /** Corrupt the base64 signature value after signing. */
  readonly corruptSignature?: boolean;
  /**
   * Corrupt this asset's bytes AFTER the manifest was signed, and regenerate
   * its `.sha512` sidecar so the legacy checksum gate still passes. This is
   * the "not merely a corrupted download" case: only the signed manifest's
   * asset digest can catch it.
   */
  readonly corruptAssetAfterSigning?: string;
}

export interface ReleaseFixture {
  readonly dir: string;
  /** `<outDir>/download/<tag>` — what the release URL space maps onto. */
  readonly releaseDir: string;
  readonly tag: string;
  readonly keyId: string;
  /** Path to the publisher public key the installer should pin. */
  readonly trustRootPem: string;
  /** Path to an unrelated public key, for the wrong-trust-root probe. */
  readonly wrongTrustRootPem: string;
  readonly manifestPath: string;
  readonly assets: readonly string[];
  readonly commit: string;
  readonly treeDigest: string;
  readonly contractDigest: string;
}

function ed25519Pair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/**
 * Deterministic pseudo-binary padding. Deliberately contains NUL and other
 * non-printable bytes so the installers' identity scanners are exercised
 * against something shaped like a real compiled artifact rather than text.
 */
function padding(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = state & 0xff;
  }
  return out;
}

function sha512Hex(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('hex');
}

function writeAsset(path: string, bytes: Buffer): void {
  writeFileSync(path, bytes);
  writeFileSync(`${path}.sha512`, `${sha512Hex(bytes)}\n`, 'utf8');
}

/** Flip one character of a base64 signature so it decodes but does not verify. */
function flipBase64(value: string): string {
  const head = value.slice(0, 1) === 'A' ? 'B' : 'A';
  return head + value.slice(1);
}

/**
 * Build a complete local release: artifacts + sidecars + signed manifest +
 * trust-root keys. Returns everything a test (or shell harness) needs to point
 * an installer at it.
 */
export function buildReleaseFixture(options: ReleaseFixtureOptions): ReleaseFixture {
  const repoRoot = fixtureRepoRoot();
  const version = readPackageVersion(repoRoot);
  const tag = options.tag ?? `v${version}`;

  const outDir = resolve(options.outDir);
  const releaseDir = join(outDir, 'download', tag);
  const keyDir = join(outDir, 'keys');
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(keyDir, { recursive: true });

  // One collection of the REAL source/contract identity, shared by the
  // artifact banner and the manifest, so they agree unless a fault is seeded.
  const { source, contract } = collectIdentitiesCached(repoRoot);

  const identity: EmbeddedBuildIdentity = {
    marker: options.marker ?? BUILD_IDENTITY_MARKER,
    version: options.embeddedVersion ?? version,
    source,
    sourceState: options.sourceState ?? 'clean',
    modifiedPaths: options.sourceState === 'modified' ? ['src/example.ts'] : [],
    modifiedCount: options.sourceState === 'modified' ? 1 : 0,
    contract,
  };
  const banner =
    options.omitIdentity === true
      ? ''
      : buildIdentityBanner(
          // A REAL v1 banner carries no `sourceState`/`modifiedPaths` fields at
          // all (they were introduced by the v2 marker). Modelling v1 as
          // "v2-with-a-different-marker" would let the installer pass on the
          // sourceState check by accident, so the downgrade-by-omission case is
          // reproduced faithfully here.
          identity.marker === BUILD_IDENTITY_MARKER
            ? identity
            : ({
                marker: identity.marker,
                version: identity.version,
                source,
                contract,
              } as unknown as EmbeddedBuildIdentity),
        );

  for (let i = 0; i < options.assets.length; i++) {
    const name = options.assets[i] as string;
    const bytes = Buffer.concat([
      padding(0x5eed0001 + i, 512),
      Buffer.from(banner, 'latin1'),
      padding(0x5eed1001 + i, 512),
    ]);
    writeAsset(join(releaseDir, name), bytes);
  }

  // Producer path: the real `collectReleaseAssets` digests the bytes on disk.
  const assets = collectReleaseAssets(releaseDir);
  const manifest = buildReleaseManifest({
    version: options.manifestVersion ?? version,
    source: {
      commit: options.manifestCommit ?? source.commit,
      treeDigest: options.manifestTreeDigest ?? source.treeDigest,
    },
    contract:
      options.manifestContractDigest === undefined
        ? contract
        : { ...contract, digest: options.manifestContractDigest },
    install: collectInstallIdentity(repoRoot, assets),
    assets,
  });

  const publisher = ed25519Pair();
  const impostor = ed25519Pair();
  const signed = signReleaseManifest(
    manifest,
    FIXTURE_KEY_ID,
    options.signWithWrongKey === true ? impostor.privatePem : publisher.privatePem,
  );

  const emitted =
    options.corruptSignature === true
      ? {
          ...signed,
          signature: { ...signed.signature, value: flipBase64(signed.signature.value) },
        }
      : signed;

  const manifestPath = join(releaseDir, RELEASE_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${serializeSignedManifest(emitted)}\n`, 'utf8');

  // Post-signature byte corruption: the sidecar is REGENERATED so the SHA-512
  // gate still passes and only the signed manifest can catch the swap.
  if (options.corruptAssetAfterSigning !== undefined) {
    const target = join(releaseDir, options.corruptAssetAfterSigning);
    const bytes = readFileSync(target);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeAsset(target, bytes);
  }

  const trustRootPem = join(keyDir, 'trust-root.pem');
  const wrongTrustRootPem = join(keyDir, 'wrong-trust-root.pem');
  writeFileSync(trustRootPem, publisher.publicPem, 'utf8');
  writeFileSync(wrongTrustRootPem, impostor.publicPem, 'utf8');

  return {
    dir: outDir,
    releaseDir,
    tag,
    keyId: FIXTURE_KEY_ID,
    trustRootPem,
    wrongTrustRootPem,
    manifestPath,
    assets: [...options.assets],
    commit: source.commit,
    treeDigest: source.treeDigest,
    contractDigest: contract.digest,
  };
}

// ─── Direct invocation (used by the shell-native harnesses) ──────────────────

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (invokedDirectly()) {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  const assets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--asset') assets.push(argv[++i] as string);
  }
  if (out === undefined) {
    process.stderr.write('usage: release-fixture.ts --out <dir> [--asset <name> ...]\n');
    process.exit(3);
  }
  const fixture = buildReleaseFixture({
    outDir: out,
    assets: assets.length > 0 ? assets : ['exarchos-linux-x64'],
  });
  process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
}

// Builds a local release fixture for the installer acceptance suite.
//
// The installers (`tools/release/get-exarchos.sh`, `get-exarchos.ps1`) must reject a
// release on four independent dimensions: manifest signature, source identity,
// contract identity and asset digest. They also check the release binding and the
// `sourceState` of the artifact. The proof drives the real scripts against a real,
// signed, source-linked release.
//
// The fixture uses the layout of the GitHub Releases URL space (`download/<tag>/<asset>`).
// It holds artifacts with a real build-identity banner, `.sha512` sidecars, an
// Ed25519-signed `exarchos-release-manifest.json`, and the publisher key plus a wrong key.
// Each option seeds one fault, so a rejection names exactly the check under test.
//
// The `files` list of the root `package.json` does not include `tools/`, so none of this ships.
// Shell harnesses run `tsx tools/audit/test-fixtures/release-fixture.ts --out <dir>`.

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

/** Key id that the fixture signs with. It matches the `EXARCHOS_RELEASE_KEY_ID` default. */
export const FIXTURE_KEY_ID = 'exarchos.release.v1';

/**
 * Identities memoized per repo root. `collectSourceIdentity` digests each committed
 * blob under `SOURCE_TREE_ROOTS`, which takes about 1s. The committed tree cannot
 * change inside one test process.
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

/**
 * Seeded, single-dimension faults. Each fault field defaults to no fault.
 * Artifact faults change the stamped bytes. Manifest faults change a field of a
 * manifest that stays validly signed. The other faults change the key, the
 * signature, or the asset bytes after signing.
 */
export interface ReleaseFixtureOptions {
  readonly outDir: string;
  /** Release asset filenames, such as `exarchos-linux-x64`. */
  readonly assets: readonly string[];
  /** Release tag the fixture is published under (default `v<pkg version>`). */
  readonly tag?: string;

  /** `sourceState` stamped into the artifact (default `clean`). */
  readonly sourceState?: 'clean' | 'modified';
  /** Build-identity marker (default v2). Set to a v1 marker to test downgrade. */
  readonly marker?: string;
  /** Version stamped into the artifact (default root package.json version). */
  readonly embeddedVersion?: string;
  /** Emit an artifact with NO build-identity banner at all. */
  readonly omitIdentity?: boolean;

  readonly manifestCommit?: string;
  readonly manifestTreeDigest?: string;
  readonly manifestContractDigest?: string;
  readonly manifestVersion?: string;

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
  /** Path to the publisher public key, which the installer pins. */
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
 * Builds a complete local release: artifacts, sidecars, a signed manifest and trust-root keys.
 * The artifact banner and the manifest share one collection of the real identities,
 * so they agree unless an option seeds a fault.
 * A v1 marker gets a real v1 banner with no `sourceState` or `modifiedPaths` fields.
 * A v2 shape with a v1 marker passes the `sourceState` check by accident.
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

/** True when a process runs this file directly, as the shell harnesses do. */
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

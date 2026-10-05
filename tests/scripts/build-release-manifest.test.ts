/**
 * Producer-side acceptance tests for the signed release manifest and the embedded build identity.
 * `beforeAll` compiles the host binary into a scratch directory with `--outdir`, so the build
 * does not write to `dist/bin`, which other suites read. Then it runs the real
 * `tools/release/build-release-manifest.ts` CLI on that binary.
 * A manifest over a hand-written asset list proves nothing about the release pipeline.
 *
 * The tests compare producer values with values that this file derives by a different route.
 * The routes are its own git calls, a raw sha256, its own contract roll-up, the public key, and a scan of the artifact bytes.
 * The contract roll-up is a separate implementation, because an installer pins `ContractIdentity.digest`.
 * A layout change in the producer fails here.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import {
  BUILD_IDENTITY_GLOBAL,
  BUILD_IDENTITY_MARKER,
  CONTRACT_LOCK_PATH,
  GENERATED_AT_BUILD_PATHS,
  MAX_REPORTED_MODIFIED_PATHS,
  RELEASE_MANIFEST_FILENAME,
  SOURCE_TREE_ROOTS,
  buildIdentityBanner,
  collectSourceState,
  extractEmbeddedBuildIdentity,
  renderSourceStateReport,
  type EmbeddedBuildIdentity,
} from '../../tools/release/build-release-manifest.js';
import { AUTHORITY_IDS } from '../../src/contract/authority-pin.js';
import { digestTree } from '../../src/install/install-identity.js';
import {
  parseSignedManifest,
  type SignedReleaseManifest,
} from '../../src/install/release/release-manifest.js';
import { verifyReleaseInstall } from '../../src/install/release/installer-verify.js';
import {
  SIGNATURE_ALGORITHM,
  TrustRootSet,
} from '../../src/runtime/extensions/trust-root.js';
import { spawnAsync, spawnAsyncBuffer } from '../../tools/test-helpers/spawn.js';
import { makeRepoSandbox, type RepoSandbox } from '../../tools/test-helpers/repo-sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const RELEASE_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

const TEST_KEY_ID = 'test.publisher';

/**
 * A tracked file in `SOURCE_TREE_ROOTS` that is not in `GENERATED_AT_BUILD_PATHS`.
 * The source-state tests edit a sandbox git copy of it, because other tests read the live checkout at the same time.
 */
const PLANT_TARGET = 'tools/release/build-binary-targets.ts';

/** A tracked file that IS on the allowlist — the build regenerates it. */
const GENERATED_TARGET = GENERATED_AT_BUILD_PATHS[0];

/** A sandbox git repository whose one commit holds both probe targets. */
function plantSandbox(): Promise<RepoSandbox> {
  return makeRepoSandbox({ prefix: 'source-state', copy: [PLANT_TARGET, GENERATED_TARGET], git: true });
}

/**
 * Append an inert marker to each `relPaths` entry under `root`, run `fn`, then
 * restore the original bytes. Restoration is byte-exact (`Buffer` in, `Buffer`
 * out), so the clean arm that follows a plant still holds.
 */
async function withPlantedEdits<T>(
  root: string,
  relPaths: readonly string[],
  fn: () => T | Promise<T>,
): Promise<T> {
  const targets = relPaths.map((p) => ({ abs: join(root, p), original: readFileSync(join(root, p)) }));
  try {
    for (const t of targets) {
      writeFileSync(t.abs, Buffer.concat([t.original, Buffer.from('\n// t27 sourceState probe\n', 'utf8')]));
    }
    return await fn();
  } finally {
    for (const t of targets) writeFileSync(t.abs, t.original);
  }
}

/**
 * An independent working-tree verdict: this file's own `git status` call, record parser and allowlist filter.
 * It shares only `GENERATED_AT_BUILD_PATHS` with the producer.
 * Thus a producer that stops detecting changes, or widens its allowlist, disagrees with this verdict.
 * Without `-z`, git quotes unusual paths and writes a rename as `old -> new`. The parser keeps the destination path.
 */
async function independentWorkingTreeVerdict(root: string, pathspecs: readonly string[]): Promise<{
  state: 'clean' | 'modified';
  paths: string[];
}> {
  const r = await spawnAsync(
    'git',
    ['-C', root, 'status', '--porcelain', '--untracked-files=all', '--', ...pathspecs],
  );
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  const generated = new Set<string>(GENERATED_AT_BUILD_PATHS);
  const paths = r.stdout
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).split(' -> ').pop() as string)
    .map((p) => p.replace(/^"|"$/g, '').replace(/\\/g, '/'))
    .filter((p) => !generated.has(p))
    .sort();
  return { state: paths.length === 0 ? 'clean' : 'modified', paths };
}

/** `git rev-parse HEAD`, spawned here — not read back from the producer. */
async function gitHeadCommit(): Promise<string> {
  const r = await spawnAsync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD']);
  if (r.status !== 0) throw new Error(`git rev-parse failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * This file's own digest of the committed source tree at `commit`.
 * It shares only `SOURCE_TREE_ROOTS` and the `digestTree` primitive with the producer.
 * The `git ls-tree` and `git cat-file --batch` calls and their parsers are a separate implementation.
 * Thus a producer that drops blobs from its inventory fails the comparison.
 */
async function independentSourceTreeDigest(commit: string): Promise<string> {
  const ls = await spawnAsync('git', ['-C', REPO_ROOT, 'ls-tree', '-r', commit, '--', ...SOURCE_TREE_ROOTS]);
  if (ls.status !== 0) throw new Error(`git ls-tree failed: ${ls.stderr}`);

  const paths: string[] = [];
  const oids: string[] = [];
  for (const line of ls.stdout.split('\n')) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    const meta = line.slice(0, tab).split(/\s+/);
    if (meta[1] !== 'blob') continue;
    oids.push(meta[2] as string);
    paths.push(line.slice(tab + 1));
  }
  if (paths.length === 0) throw new Error('independent enumeration found no source blobs');

  const cat = await spawnAsyncBuffer('git', ['-C', REPO_ROOT, 'cat-file', '--batch'], {
    input: `${oids.join('\n')}\n`,
  });
  if (cat.status !== 0) throw new Error(`git cat-file failed: ${String(cat.stderr)}`);
  const out = cat.stdout;

  const entries: Array<{ path: string; content: string }> = [];
  let pos = 0;
  for (let i = 0; i < oids.length; i++) {
    const nl = out.indexOf(0x0a, pos);
    const size = Number.parseInt(out.subarray(pos, nl).toString('ascii').split(' ')[2] as string, 10);
    entries.push({
      path: paths[i] as string,
      content: out.subarray(nl + 1, nl + 1 + size).toString('utf8'),
    });
    pos = nl + 1 + size + 1;
  }
  return digestTree(entries);
}

/** Raw sha256 over a file's exact bytes — no `digestAssetBytes` involved. */
function independentRawDigest(path: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

/**
 * A separate implementation of the contract-authority roll-up from the lockfile JSON, with only `createHash`.
 * It mirrors `digestParts`. Canonical text has LF line ends and no trailing newlines.
 * Each part is the canonical text of `id\0kind\0version\0versionSpec\0digest`, and the parts join with `\n`.
 * The digest is the sha256 of the canonical joined text as UTF-8.
 */
function independentContractDigest(): string {
  const lock = JSON.parse(readFileSync(join(REPO_ROOT, CONTRACT_LOCK_PATH), 'utf8')) as {
    authorities: Record<
      string,
      { kind: string; version: string | null; versionSpec: string | null; digest: string | null }
    >;
  };
  const canon = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '');
  const parts = AUTHORITY_IDS.map((id) => {
    const pin = lock.authorities[id];
    if (!pin) throw new Error(`lock is missing authority '${id}'`);
    return canon([id, pin.kind, pin.version ?? '', pin.versionSpec ?? '', pin.digest ?? ''].join('\u0000'));
  });
  const joined = canon(parts.join('\n'));
  return `sha256:${createHash('sha256').update(joined, 'utf8').digest('hex')}`;
}

function hostOs(): 'linux' | 'darwin' | 'windows' {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}
function hostArch(): 'x64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}
/** The host asset name. It must match the file name that `tools/release/build-binary.ts` writes. */
function hostAssetName(): string {
  return `exarchos-${hostOs()}-${hostArch()}${hostOs() === 'windows' ? '.exe' : ''}`;
}

/**
 * Returns the path of the real `bun` executable, or the bare name `bun` when the search finds none.
 * On Windows, npm installs bun as a `bun.cmd` shim, and a spawn of `bun` without a shell fails with ENOENT.
 * There, the function looks in each `PATH` directory for `bun.exe`, and then for `node_modules/bun/bin/bun.exe` below it.
 * With the real `.exe`, the suite runs on Windows too.
 */
function resolveBunExecutable(): string {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0);
  const direct = process.platform === 'win32' ? 'bun.exe' : 'bun';
  for (const dir of dirs) {
    const p = join(dir, direct);
    if (existsSync(p)) return p;
  }
  if (process.platform === 'win32') {
    for (const dir of dirs) {
      const p = join(dir, 'node_modules', 'bun', 'bin', 'bun.exe');
      if (existsSync(p)) return p;
    }
  }
  return 'bun';
}

describe('DR-20 release manifest producer', () => {
  let scratch: string;
  let builtBinary: string;
  let assetName: string;
  let manifestPath: string;
  let signed: SignedReleaseManifest;
  let trustRoots: TrustRootSet;
  let embedded: EmbeddedBuildIdentity | undefined;
  let artifactBytes: Buffer;

  let expectedCommit: string;
  let expectedTreeDigest: string;
  let expectedContractDigest: string;
  let expectedAssetDigest: string;

  /**
   * Compiles the host target, copies the binary into an assets directory, and signs a manifest over it.
   * The independent `expected*` values come after the build, so they describe the tree state that both producers saw.
   */
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'exarchos-dr20-'));
    const binDir = join(scratch, 'bin');
    const assetsDir = join(scratch, 'assets');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });

    const bun = resolveBunExecutable();
    const build = await spawnAsync(
      bun,
      ['run', join(REPO_ROOT, 'tools', 'release', 'build-binary.ts'), '--outdir', binDir],
      { cwd: REPO_ROOT, env: process.env, timeout: 300_000 },
    );
    if (build.status !== 0) {
      throw new Error(
        `build-binary.ts exited status=${build.status} (${build.error?.message ?? 'no spawn error'})\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`,
      );
    }

    assetName = hostAssetName();
    builtBinary = join(binDir, assetName);
    if (!existsSync(builtBinary)) {
      throw new Error(`expected artifact ${builtBinary} was not produced`);
    }
    artifactBytes = readFileSync(builtBinary);
    embedded = extractEmbeddedBuildIdentity(artifactBytes);

    copyFileSync(builtBinary, join(assetsDir, assetName));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyPath = join(scratch, 'signing-key.pem');
    writeFileSync(keyPath, privatePem, 'utf8');
    manifestPath = join(scratch, RELEASE_MANIFEST_FILENAME);
    const gen = await spawnAsync(
      bun,
      [
        'run',
        join(REPO_ROOT, 'tools', 'release', 'build-release-manifest.ts'),
        '--assets-dir',
        assetsDir,
        '--out',
        manifestPath,
        '--key-id',
        TEST_KEY_ID,
        '--private-key-file',
        keyPath,
      ],
      { cwd: REPO_ROOT, env: process.env, timeout: 300_000 },
    );
    if (gen.status !== 0) {
      throw new Error(
        `build-release-manifest.ts exited status=${gen.status} (${gen.error?.message ?? 'no spawn error'})\nstdout:\n${gen.stdout}\nstderr:\n${gen.stderr}`,
      );
    }

    signed = parseSignedManifest(readFileSync(manifestPath, 'utf8'));
    trustRoots = new TrustRootSet([
      { keyId: TEST_KEY_ID, algorithm: SIGNATURE_ALGORITHM, publicKeyPem: publicPem },
    ]);

    expectedCommit = await gitHeadCommit();
    expectedTreeDigest = await independentSourceTreeDigest(expectedCommit);
    expectedContractDigest = independentContractDigest();
    expectedAssetDigest = independentRawDigest(join(assetsDir, assetName));
  }, 400_000);

  /**
   * The manifest describes the built artifact, and the size floor of 1 MB rejects a stub file.
   * The last check sends the manifest through the installer gate, `verifyReleaseInstall`.
   */
  it('ReleaseManifest_RealBuildOutput_ProducesSignedManifest', () => {
    const asset = signed.manifest.assets.find((a) => a.name === assetName);
    expect(asset, `manifest has no entry for ${assetName}`).toBeDefined();
    expect(asset?.digest).toBe(expectedAssetDigest);
    expect(asset?.size).toBe(statSync(builtBinary).size);
    expect(asset?.size).toBeGreaterThan(1_000_000);

    expect(signed.manifest.source.commit).toBe(expectedCommit);
    expect(signed.manifest.source.treeDigest).toBe(expectedTreeDigest);
    expect(signed.manifest.contract.digest).toBe(expectedContractDigest);
    expect(signed.manifest.contract.authorityCount).toBe(AUTHORITY_IDS.length);

    expect(signed.signature.keyId).toBe(TEST_KEY_ID);
    expect(signed.signature.algorithm).toBe(SIGNATURE_ALGORITHM);

    const verdict = verifyReleaseInstall({
      signed,
      trustRoots,
      expectedSource: { commit: expectedCommit, treeDigest: expectedTreeDigest },
      expectedContract: {
        digest: expectedContractDigest,
        approvedBy: '(pinned by installer)',
        authorityCount: AUTHORITY_IDS.length,
      },
      observedAssets: new Map([[assetName, { digest: expectedAssetDigest }]]),
    });
    expect(verdict).toEqual({ ok: true, keyId: TEST_KEY_ID });
  });

  /** Three cases fail on the signature: a changed body, a corrupted signature, and a different key with the same key id. */
  it('ReleaseManifest_SignatureIsLoadBearing_TamperedManifestRejected', () => {
    const baseline = {
      signed,
      trustRoots,
      expectedSource: { commit: expectedCommit, treeDigest: expectedTreeDigest },
      expectedContract: {
        digest: expectedContractDigest,
        approvedBy: '(pinned by installer)',
        authorityCount: AUTHORITY_IDS.length,
      },
      observedAssets: new Map([[assetName, { digest: expectedAssetDigest }]]),
    };

    const tamperedBody: SignedReleaseManifest = {
      ...signed,
      manifest: { ...signed.manifest, version: `${signed.manifest.version}-evil` },
    };
    const bodyVerdict = verifyReleaseInstall({ ...baseline, signed: tamperedBody });
    expect(bodyVerdict.ok).toBe(false);
    expect(bodyVerdict.ok === false && bodyVerdict.reason).toBe('manifest-signature');

    const flipped = Buffer.from(signed.signature.value, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tamperedSig: SignedReleaseManifest = {
      ...signed,
      signature: { ...signed.signature, value: flipped.toString('base64') },
    };
    const sigVerdict = verifyReleaseInstall({ ...baseline, signed: tamperedSig });
    expect(sigVerdict.ok).toBe(false);
    expect(sigVerdict.ok === false && sigVerdict.reason).toBe('manifest-signature');

    const { publicKey: otherPub } = generateKeyPairSync('ed25519');
    const otherRoots = new TrustRootSet([
      {
        keyId: TEST_KEY_ID,
        algorithm: SIGNATURE_ALGORITHM,
        publicKeyPem: otherPub.export({ type: 'spki', format: 'pem' }).toString(),
      },
    ]);
    const foreignVerdict = verifyReleaseInstall({ ...baseline, trustRoots: otherRoots });
    expect(foreignVerdict.ok).toBe(false);
    expect(foreignVerdict.ok === false && foreignVerdict.reason).toBe('manifest-signature');
  });

  /**
   * An installer can reject a wrong source, contract or asset only when the produced manifest carries a field for each.
   * The test changes one installer input at a time: the commit, the tree digest, the contract digest, then the observed asset digest.
   * Against the real signed manifest, `verifyReleaseInstall` must reject each change with the matching reason.
   */
  it('ReleaseManifest_CarriesFieldsThatDiscriminateSourceContractAndAsset', () => {
    const baseline = {
      signed,
      trustRoots,
      expectedSource: { commit: expectedCommit, treeDigest: expectedTreeDigest },
      expectedContract: {
        digest: expectedContractDigest,
        approvedBy: '(pinned by installer)',
        authorityCount: AUTHORITY_IDS.length,
      },
      observedAssets: new Map([[assetName, { digest: expectedAssetDigest }]]),
    };

    const wrongSource = verifyReleaseInstall({
      ...baseline,
      expectedSource: { commit: 'f'.repeat(40), treeDigest: expectedTreeDigest },
    });
    expect(wrongSource.ok === false && wrongSource.reason).toBe('source-mismatch');

    const wrongTree = verifyReleaseInstall({
      ...baseline,
      expectedSource: { commit: expectedCommit, treeDigest: `sha256:${'0'.repeat(64)}` },
    });
    expect(wrongTree.ok === false && wrongTree.reason).toBe('source-mismatch');

    const wrongContract = verifyReleaseInstall({
      ...baseline,
      expectedContract: {
        digest: `sha256:${'1'.repeat(64)}`,
        approvedBy: '(pinned by installer)',
        authorityCount: AUTHORITY_IDS.length,
      },
    });
    expect(wrongContract.ok === false && wrongContract.reason).toBe('contract-mismatch');

    const wrongAsset = verifyReleaseInstall({
      ...baseline,
      observedAssets: new Map([[assetName, { digest: `sha256:${'2'.repeat(64)}` }]]),
    });
    expect(wrongAsset.ok === false && wrongAsset.reason).toBe('asset-digest');
  });

  /**
   * The identity comes from the bytes of the artifact, not from a value that the test gave the builder.
   * The raw-byte checks show that an installer or an auditor can read it from the shipped file.
   * The binary and the manifest must agree, so an installer can reject a signed manifest for a different source or contract.
   */
  it('BuildBinary_EmbedsSourceAndContractIdentity', () => {
    expect(embedded, 'built artifact carries no embedded build identity').toBeDefined();
    const id = embedded as EmbeddedBuildIdentity;

    expect(id.marker).toBe(BUILD_IDENTITY_MARKER);

    expect(id.source.commit).toBe(expectedCommit);
    expect(id.source.treeDigest).toBe(expectedTreeDigest);

    expect(id.contract.digest).toBe(expectedContractDigest);
    expect(id.contract.authorityCount).toBe(AUTHORITY_IDS.length);

    const raw = artifactBytes.toString('latin1');
    expect(raw).toContain(`globalThis.${BUILD_IDENTITY_GLOBAL}=`);
    expect(raw).toContain(expectedCommit);
    expect(raw).toContain(expectedContractDigest);
    expect(raw).toContain(expectedTreeDigest);

    expect(id.source).toEqual(signed.manifest.source);
    expect(id.contract).toEqual(signed.manifest.contract);
  });

  /**
   * An edit to a tracked file reads as `modified`, and the report names the file.
   * The clean check before the edit is necessary: with a file that is already dirty, the modified check proves nothing.
   * The scope is one file of a sandbox git repository, so the verdict does not depend on the live checkout.
   */
  it('BuildIdentity_ModifiedWorkingTree_ReportsModifiedAndNamesPath', async () => {
    const scope = [PLANT_TARGET];
    const sandbox = await plantSandbox();
    try {
      const before = collectSourceState(sandbox.root, scope);
      expect(before.state, `${PLANT_TARGET} was already dirty — the modified arm would be vacuous`).toBe('clean');
      expect(before.modifiedPaths).toEqual([]);
      expect(before.modifiedCount).toBe(0);
      expect((await independentWorkingTreeVerdict(sandbox.root, scope)).state).toBe('clean');

      const during = await withPlantedEdits(sandbox.root, scope, async () => ({
        producer: collectSourceState(sandbox.root, scope),
        independent: await independentWorkingTreeVerdict(sandbox.root, scope),
      }));

      expect(during.independent.state, 'the plant did not actually dirty the working tree').toBe('modified');
      expect(during.producer.state).toBe('modified');
      expect(during.producer.modifiedPaths).toContain(PLANT_TARGET);
      expect(during.producer.modifiedCount).toBe(1);
      expect([...during.producer.modifiedPaths]).toEqual(during.independent.paths);

      const after = collectSourceState(sandbox.root, scope);
      expect(after.state, `${PLANT_TARGET} was not restored byte-for-byte`).toBe('clean');
    } finally {
      sandbox.remove();
    }
  });

  /**
   * The allowlist excludes the file that the build regenerates, and only that file.
   * An edit to that file alone reads `clean`, although `git status` shows it.
   * A second edit to a file outside the allowlist reads `modified`. The test runs on a sandbox git repository.
   */
  it('BuildIdentity_GeneratedPathAllowlist_IsNotABlanketEscape', async () => {
    const scope = [GENERATED_TARGET, PLANT_TARGET];
    const sandbox = await plantSandbox();
    try {
      expect(collectSourceState(sandbox.root, scope).state, 'probe scope was already dirty').toBe('clean');

      const generatedOnly = await withPlantedEdits(sandbox.root, [GENERATED_TARGET], () =>
        collectSourceState(sandbox.root, scope),
      );
      expect(generatedOnly.state).toBe('clean');
      expect(generatedOnly.modifiedCount).toBe(0);
      const generatedOnlyRaw = await withPlantedEdits(sandbox.root, [GENERATED_TARGET], async () =>
        (await spawnAsync('git', ['-C', sandbox.root, 'status', '--porcelain', '--', GENERATED_TARGET])).stdout.trim(),
      );
      expect(generatedOnlyRaw).toContain(GENERATED_TARGET);

      const both = await withPlantedEdits(sandbox.root, [GENERATED_TARGET, PLANT_TARGET], () =>
        collectSourceState(sandbox.root, scope),
      );
      expect(both.state).toBe('modified');
      expect(both.modifiedPaths).toContain(PLANT_TARGET);
      expect(both.modifiedPaths).not.toContain(GENERATED_TARGET);
      expect(both.modifiedCount).toBe(1);

      expect(collectSourceState(sandbox.root, scope).state, 'probe files were not restored').toBe('clean');
    } finally {
      sandbox.remove();
    }
  });

  /**
   * Compares the source state in the artifact bytes with this file's own `git status` verdict.
   * The test hardcodes neither state: a clean CI checkout reads `clean` and a dirty working copy reads `modified`.
   * The cap bounds the path list in the banner, and `modifiedCount` still gives the full number.
   * A build-generated path never makes a release read as modified.
   */
  it('BuildBinary_EmbedsSourceState_AgreeingWithIndependentGitVerdict', async () => {
    const id = embedded as EmbeddedBuildIdentity;
    expect(id, 'built artifact carries no embedded build identity').toBeDefined();

    const independent = await independentWorkingTreeVerdict(REPO_ROOT, SOURCE_TREE_ROOTS);
    expect(id.sourceState).toBe(independent.state);

    if (id.sourceState === 'clean') {
      expect(id.modifiedPaths).toEqual([]);
      expect(id.modifiedCount).toBe(0);
    } else {
      expect(id.modifiedCount).toBeGreaterThan(0);
      expect(id.modifiedPaths.length).toBeLessThanOrEqual(MAX_REPORTED_MODIFIED_PATHS);
      expect(id.modifiedPaths.length).toBe(Math.min(id.modifiedCount, MAX_REPORTED_MODIFIED_PATHS));
      for (const p of id.modifiedPaths) expect(p).not.toContain('\\');
      for (const p of GENERATED_AT_BUILD_PATHS) expect(id.modifiedPaths).not.toContain(p);
    }

    expect(artifactBytes.toString('latin1')).toContain(`"sourceState":"${id.sourceState}"`);
  });

  /**
   * `BuildBinary_EmbedsSourceAndContractIdentity` detects a latin1 parse only while the real `approvedBy` text holds non-ASCII characters.
   * This test gives the extractor non-ASCII text directly: an em dash and an arrow (3 UTF-8 bytes each),
   * an accented letter (2 bytes) and a non-BMP character (4 bytes). A decode that handles only 2-byte sequences fails.
   * Raw bytes that are not valid UTF-8 surround the banner, because the latin1 scan exists for such bytes.
   * The whole identity must round-trip, not only `approvedBy`.
   */
  it('ExtractEmbeddedBuildIdentity_NonAsciiPayload_RoundTripsThroughRealBinaryBytes', () => {
    const identity: EmbeddedBuildIdentity = {
      marker: BUILD_IDENTITY_MARKER,
      version: '9.9.9',
      source: {
        commit: 'f'.repeat(40),
        treeDigest: `sha256:${'a'.repeat(64)}`,
      },
      sourceState: 'clean',
      modifiedPaths: [],
      modifiedCount: 0,
      contract: {
        digest: `sha256:${'b'.repeat(64)}`,
        authorityCount: AUTHORITY_IDS.length,
        approvedBy: 'v1→v2 — café — 🧪',
      },
    } as EmbeddedBuildIdentity;

    const binaryNoise = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81, 0xc0, 0xc1]);
    const artifact = Buffer.concat([
      binaryNoise,
      Buffer.from(buildIdentityBanner(identity), 'utf8'),
      binaryNoise,
    ]);

    const recovered = extractEmbeddedBuildIdentity(artifact);
    expect(recovered, 'identity must survive extraction from binary-flanked bytes').toBeDefined();
    expect(recovered).toEqual(identity);
    expect(recovered?.contract.approvedBy).toBe('v1→v2 — café — 🧪');
  });

  /** The warning shows in the Actions log, gives the total, names the paths, and states how many paths it omits. */
  it('SourceStateReport_ModifiedTree_RendersNamedActionableWarning', () => {
    const clean = renderSourceStateReport({ state: 'clean', modifiedPaths: [], modifiedCount: 0 });
    expect(clean.join('\n')).not.toContain('::warning::');
    expect(clean.join('\n')).toContain('clean');

    const many = Array.from({ length: MAX_REPORTED_MODIFIED_PATHS + 3 }, (_, i) => `src/f${i}.ts`);
    const modified = renderSourceStateReport({
      state: 'modified',
      modifiedPaths: many.slice(0, MAX_REPORTED_MODIFIED_PATHS),
      modifiedCount: many.length,
    }).join('\n');

    expect(modified).toContain('::warning::');
    expect(modified).toContain(String(many.length));
    expect(modified).toContain('src/f0.ts');
    expect(modified).toContain('+3 more');
  });

  /** The release workflow builds the manifest, signs it with a repository secret, and publishes it as a release asset. */
  it('ReleaseWorkflow_PublishesSignedManifestAsset', () => {
    const raw = readFileSync(RELEASE_WORKFLOW_PATH, 'utf-8');
    const wf = yaml.load(raw) as {
      jobs?: Record<
        string,
        { steps?: Array<{ run?: string; env?: Record<string, unknown>; uses?: string; with?: Record<string, unknown> }> }
      >;
    };
    const publish = wf.jobs?.['publish-release'];
    expect(publish, 'release.yml has no publish-release job').toBeDefined();

    const steps = publish?.steps ?? [];

    const buildStep = steps.find((s) => (s.run ?? '').includes('tools/release/build-release-manifest.ts'));
    expect(buildStep, 'publish-release does not invoke tools/release/build-release-manifest.ts').toBeDefined();

    const stepText = `${buildStep?.run ?? ''}\n${JSON.stringify(buildStep?.env ?? {})}`;
    expect(stepText).toContain('--private-key-env');
    expect(stepText).toMatch(/secrets\.[A-Z0-9_]*SIGNING_KEY/);

    const ghStep = steps.find((s) => (s.uses ?? '').startsWith('softprops/action-gh-release@'));
    expect(ghStep, 'publish-release has no gh-release step').toBeDefined();
    const files = ghStep?.with?.['files'];
    const fileList =
      typeof files === 'string'
        ? files.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
        : Array.isArray(files)
          ? files.map((f) => String(f).trim())
          : [];
    expect(fileList).toContain(`dist/release/${RELEASE_MANIFEST_FILENAME}`);
  });
});

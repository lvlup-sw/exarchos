/**
 * DR-20 producer-side acceptance tests: the release manifest is produced from
 * REAL build output and signed, and the built artifact carries source +
 * contract identity in its own bytes.
 *
 * ── Why this suite runs a real `bun build --compile` ────────────────────
 * A manifest assembled over a hand-written `{path, digest}` array proves
 * nothing about the release pipeline. `beforeAll` therefore performs an actual
 * host-target compile into a scratch directory (~3-5s on a warm bun cache; the
 * `--outdir` flag exists so this never races `dist/bin`, which
 * `scripts/build-binary.test.ts` and the compiled-binary process tests read),
 * copies the artifact into a scratch "release assets" directory and drives the
 * real `scripts/build-release-manifest.ts` CLI over it.
 *
 * ── Two independent authorities everywhere (DR-30 Class-B avoidance) ────
 * Nothing here compares a value to itself or to a sibling read of the same
 * call. Every assertion pits the PRODUCER's output against a value this test
 * derived by a different route:
 *
 *   | claim                | producer                        | independent authority in this file |
 *   |----------------------|---------------------------------|------------------------------------|
 *   | source commit        | `collectSourceIdentity` (git)   | `git rev-parse HEAD` spawned here   |
 *   | source tree digest   | producer's own enumeration      | this file's own `git ls-files` walk |
 *   | asset digest         | `digestAssetBytes`              | raw `createHash('sha256')` on file  |
 *   | contract digest      | `contractIdentityFromLock`      | hand-rolled roll-up from lock JSON  |
 *   | signature            | `signReleaseManifest`           | `TrustRootSet.verify` w/ pubkey     |
 *   | embedded identity    | `--banner` at compile time      | scan of the ARTIFACT's raw bytes    |
 *
 * The contract roll-up is deliberately re-implemented rather than imported:
 * `ContractIdentity.digest` is a WIRE value an installer pins, so its layout
 * is pinned here by an independent implementation. If the producer's layout
 * changes, this goes red — which is the point.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
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
  collectSourceState,
  extractEmbeddedBuildIdentity,
  renderSourceStateReport,
  type EmbeddedBuildIdentity,
} from './build-release-manifest.js';
import { AUTHORITY_IDS } from '../servers/exarchos-mcp/src/contract/authority-pin.js';
import { digestTree } from '../servers/exarchos-mcp/src/install/install-identity.js';
import {
  parseSignedManifest,
  type SignedReleaseManifest,
} from '../servers/exarchos-mcp/src/release/release-manifest.js';
import { verifyReleaseInstall } from '../servers/exarchos-mcp/src/release/installer-verify.js';
import {
  SIGNATURE_ALGORITHM,
  TrustRootSet,
} from '../servers/exarchos-mcp/src/extensions/trust-root.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RELEASE_WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

const TEST_KEY_ID = 'test.publisher';

// ─── Working-tree planting (for the sourceState arms) ────────────────────────

/**
 * A tracked file inside `SOURCE_TREE_ROOTS` that is NOT on the build-generated
 * allowlist, is not owned by any concurrently-running agent, and whose content
 * is inert at test time (appending a trailing comment cannot change behaviour).
 * Planting here is what makes the "modified" arm a genuine working-tree edit
 * rather than a simulated one.
 */
const PLANT_TARGET = 'scripts/build-binary-targets.ts';

/** A tracked file that IS on the allowlist — the build regenerates it. */
const GENERATED_TARGET = GENERATED_AT_BUILD_PATHS[0];

/**
 * Append an inert marker to each `relPaths` entry, run `fn`, then restore the
 * ORIGINAL BYTES unconditionally. Restoration is byte-exact (`Buffer` in,
 * `Buffer` out) so no encoding or line-ending normalization can leak an edit
 * back into the repository.
 */
function withPlantedEdits<T>(relPaths: readonly string[], fn: () => T): T {
  const targets = relPaths.map((p) => ({ abs: join(REPO_ROOT, p), original: readFileSync(join(REPO_ROOT, p)) }));
  try {
    for (const t of targets) {
      writeFileSync(t.abs, Buffer.concat([t.original, Buffer.from('\n// t27 sourceState probe\n', 'utf8')]));
    }
    return fn();
  } finally {
    for (const t of targets) writeFileSync(t.abs, t.original);
  }
}

/**
 * INDEPENDENT working-tree verdict: this file's own `git status` call, its own
 * record parsing and its own copy of the allowlist filter. Shares only the
 * `GENERATED_AT_BUILD_PATHS` wire constant with the producer, so a producer
 * that stopped detecting dirtiness (or that widened its allowlist) disagrees
 * with this and goes red.
 */
function independentWorkingTreeVerdict(pathspecs: readonly string[]): {
  state: 'clean' | 'modified';
  paths: string[];
} {
  const r = spawnSync(
    'git',
    ['-C', REPO_ROOT, 'status', '--porcelain', '--untracked-files=all', '--', ...pathspecs],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(`git status failed: ${r.stderr}`);
  const generated = new Set<string>(GENERATED_AT_BUILD_PATHS);
  const paths = r.stdout
    .split('\n')
    .filter((l) => l.length > 3)
    // Non-`-z` output quotes exotic paths and uses ` -> ` for renames; take the
    // destination side, which is enough for the assertions below.
    .map((l) => l.slice(3).split(' -> ').pop() as string)
    .map((p) => p.replace(/^"|"$/g, '').replace(/\\/g, '/'))
    .filter((p) => !generated.has(p))
    .sort();
  return { state: paths.length === 0 ? 'clean' : 'modified', paths };
}

// ─── Independent authorities (deliberately NOT the producer's code) ──────────

/** `git rev-parse HEAD`, spawned here — not read back from the producer. */
function gitHeadCommit(): string {
  const r = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git rev-parse failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * This file's OWN enumeration of the committed source tree. Shares only the
 * `SOURCE_TREE_ROOTS` wire constant and the `digestTree` primitive with the
 * producer; the git plumbing, the record parsing and the blob reads are
 * re-implemented here (one `git show` per blob via a single `git archive`-free
 * batch is unnecessary — `git ls-tree` + per-blob `git cat-file` through a
 * different call shape is enough of an independent route), so a producer that
 * silently narrowed its inventory goes red.
 */
function independentSourceTreeDigest(commit: string): string {
  const ls = spawnSync('git', ['-C', REPO_ROOT, 'ls-tree', '-r', commit, '--', ...SOURCE_TREE_ROOTS], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
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

  // Read the blobs through `git cat-file --batch` driven from a Buffer stdin
  // and parsed independently of the producer's parser.
  const cat = spawnSync('git', ['-C', REPO_ROOT, 'cat-file', '--batch'], {
    input: `${oids.join('\n')}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (cat.status !== 0) throw new Error(`git cat-file failed: ${String(cat.stderr)}`);
  const out = cat.stdout as unknown as Buffer;

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
 * Re-implementation of the P03-01 authority roll-up from the lockfile JSON,
 * using only `createHash`. Mirrors `digestParts`: canonicalize (CRLF/CR → LF,
 * strip trailing newlines) each `id\0kind\0version\0versionSpec\0digest` part,
 * join with `\n`, canonicalize again, sha256 as utf8.
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

// ─── Host target naming (mirrors scripts/build-binary.ts) ────────────────────

function hostOs(): 'linux' | 'darwin' | 'windows' {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}
function hostArch(): 'x64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}
function hostAssetName(): string {
  return `exarchos-${hostOs()}-${hostArch()}${hostOs() === 'windows' ? '.exe' : ''}`;
}

/**
 * Absolute path to the real `bun` executable.
 *
 * On Windows, npm installs bun as a `bun.cmd` / `bun.ps1` shim next to
 * `node_modules/bun/bin/bun.exe`; `spawnSync('bun', …)` without a shell then
 * fails ENOENT (which is exactly why `scripts/build-binary.test.ts` cannot run
 * locally on Windows today). Resolving the real `.exe` keeps this suite
 * genuinely executable on both platforms rather than silently skipped — a
 * suite that never runs proves nothing.
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

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('DR-20 release manifest producer', () => {
  let scratch: string;
  let builtBinary: string;
  let assetName: string;
  let manifestPath: string;
  let signed: SignedReleaseManifest;
  let trustRoots: TrustRootSet;
  let embedded: EmbeddedBuildIdentity | undefined;
  let artifactBytes: Buffer;

  // Independent expectations, captured once against the same tree state.
  let expectedCommit: string;
  let expectedTreeDigest: string;
  let expectedContractDigest: string;
  let expectedAssetDigest: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'exarchos-dr20-'));
    const binDir = join(scratch, 'bin');
    const assetsDir = join(scratch, 'assets');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(assetsDir, { recursive: true });

    // 1. REAL compile of the host target into a scratch dir.
    const bun = resolveBunExecutable();
    const build = spawnSync(
      bun,
      ['run', join(REPO_ROOT, 'scripts', 'build-binary.ts'), '--outdir', binDir],
      { cwd: REPO_ROOT, encoding: 'utf8', env: process.env, timeout: 300_000 },
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

    // 2. Stage it as a published release asset and sign a manifest over it.
    copyFileSync(builtBinary, join(assetsDir, assetName));

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyPath = join(scratch, 'signing-key.pem');
    writeFileSync(keyPath, privatePem, 'utf8');
    manifestPath = join(scratch, RELEASE_MANIFEST_FILENAME);
    const gen = spawnSync(
      bun,
      [
        'run',
        join(REPO_ROOT, 'scripts', 'build-release-manifest.ts'),
        '--assets-dir',
        assetsDir,
        '--out',
        manifestPath,
        '--key-id',
        TEST_KEY_ID,
        '--private-key-file',
        keyPath,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env: process.env, timeout: 300_000 },
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

    // 3. Independent expectations, derived after the build so they describe the
    //    same tree state the two producers saw.
    expectedCommit = gitHeadCommit();
    expectedTreeDigest = independentSourceTreeDigest(expectedCommit);
    expectedContractDigest = independentContractDigest();
    expectedAssetDigest = independentRawDigest(join(assetsDir, assetName));
  }, 400_000);

  it('ReleaseManifest_RealBuildOutput_ProducesSignedManifest', () => {
    // ── The manifest describes the artifact that was actually built ─────
    const asset = signed.manifest.assets.find((a) => a.name === assetName);
    expect(asset, `manifest has no entry for ${assetName}`).toBeDefined();
    // Producer digest vs. an independent raw sha256 of the file on disk.
    expect(asset?.digest).toBe(expectedAssetDigest);
    expect(asset?.size).toBe(statSync(builtBinary).size);
    // A real compiled binary, not a stub someone dropped in the assets dir.
    expect(asset?.size).toBeGreaterThan(1_000_000);

    // ── Source + contract identity, each against an independent authority ──
    expect(signed.manifest.source.commit).toBe(expectedCommit);
    expect(signed.manifest.source.treeDigest).toBe(expectedTreeDigest);
    expect(signed.manifest.contract.digest).toBe(expectedContractDigest);
    expect(signed.manifest.contract.authorityCount).toBe(AUTHORITY_IDS.length);

    // ── It is SIGNED: the detached signature chains to the publisher key ──
    expect(signed.signature.keyId).toBe(TEST_KEY_ID);
    expect(signed.signature.algorithm).toBe(SIGNATURE_ALGORITHM);

    // ── Full producer→consumer round trip through the installer gate ──────
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

    // Body tampered, signature untouched → the signature must catch it.
    const tamperedBody: SignedReleaseManifest = {
      ...signed,
      manifest: { ...signed.manifest, version: `${signed.manifest.version}-evil` },
    };
    const bodyVerdict = verifyReleaseInstall({ ...baseline, signed: tamperedBody });
    expect(bodyVerdict.ok).toBe(false);
    expect(bodyVerdict.ok === false && bodyVerdict.reason).toBe('manifest-signature');

    // Signature bytes corrupted → rejected.
    const flipped = Buffer.from(signed.signature.value, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tamperedSig: SignedReleaseManifest = {
      ...signed,
      signature: { ...signed.signature, value: flipped.toString('base64') },
    };
    const sigVerdict = verifyReleaseInstall({ ...baseline, signed: tamperedSig });
    expect(sigVerdict.ok).toBe(false);
    expect(sigVerdict.ok === false && sigVerdict.reason).toBe('manifest-signature');

    // An unrelated trust root must not accept it.
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

  it('ReleaseManifest_CarriesFieldsThatDiscriminateSourceContractAndAsset', () => {
    // DR-20 criterion 1 is an installer behaviour (T-28 owns the shell side),
    // but it is only reachable if the PRODUCED manifest carries fields that
    // actually discriminate. Prove each dimension independently against the
    // real signed manifest.
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

  it('BuildBinary_EmbedsSourceAndContractIdentity', () => {
    // Recovered from the ARTIFACT'S OWN BYTES — never from a variable handed
    // to the builder.
    expect(embedded, 'built artifact carries no embedded build identity').toBeDefined();
    const id = embedded as EmbeddedBuildIdentity;

    expect(id.marker).toBe(BUILD_IDENTITY_MARKER);

    // Source identity vs. independent authorities.
    expect(id.source.commit).toBe(expectedCommit);
    expect(id.source.treeDigest).toBe(expectedTreeDigest);

    // Contract identity vs. an independently recomputed roll-up.
    expect(id.contract.digest).toBe(expectedContractDigest);
    expect(id.contract.authorityCount).toBe(AUTHORITY_IDS.length);

    // Raw-byte presence: the identity is literally in the shipped file, so an
    // installer (or an auditor with `strings`) can recover it.
    const raw = artifactBytes.toString('latin1');
    expect(raw).toContain(`globalThis.${BUILD_IDENTITY_GLOBAL}=`);
    expect(raw).toContain(expectedCommit);
    expect(raw).toContain(expectedContractDigest);
    expect(raw).toContain(expectedTreeDigest);

    // The binary and the signed manifest must agree — that agreement is what
    // lets an installer reject a validly-signed manifest for a different
    // source/contract than the binary it is about to trust.
    expect(id.source).toEqual(signed.manifest.source);
    expect(id.contract).toEqual(signed.manifest.contract);
  });

  it('BuildIdentity_ModifiedWorkingTree_ReportsModifiedAndNamesPath', () => {
    // Scoped to a single file so the verdict is deterministic regardless of
    // what else is dirty in this checkout.
    const scope = [PLANT_TARGET];

    // CLEAN ARM — precondition and assertion in one. If this file were already
    // dirty the "modified" arm below would prove nothing, so the clean arm is
    // load-bearing rather than decorative.
    const before = collectSourceState(REPO_ROOT, scope);
    expect(before.state, `${PLANT_TARGET} was already dirty — the modified arm would be vacuous`).toBe('clean');
    expect(before.modifiedPaths).toEqual([]);
    expect(before.modifiedCount).toBe(0);
    expect(independentWorkingTreeVerdict(scope).state).toBe('clean');

    // MODIFIED ARM — a genuine edit to a real tracked file on disk.
    const during = withPlantedEdits(scope, () => ({
      producer: collectSourceState(REPO_ROOT, scope),
      independent: independentWorkingTreeVerdict(scope),
    }));

    expect(during.independent.state, 'the plant did not actually dirty the working tree').toBe('modified');
    expect(during.producer.state).toBe('modified');
    // The path must be NAMED, not merely counted.
    expect(during.producer.modifiedPaths).toContain(PLANT_TARGET);
    expect(during.producer.modifiedCount).toBe(1);
    expect([...during.producer.modifiedPaths]).toEqual(during.independent.paths);

    // Restoration is byte-exact, so the verdict returns to clean.
    const after = collectSourceState(REPO_ROOT, scope);
    expect(after.state, `${PLANT_TARGET} was not restored byte-for-byte`).toBe('clean');
  });

  it('BuildIdentity_GeneratedPathAllowlist_IsNotABlanketEscape', () => {
    const scope = [GENERATED_TARGET, PLANT_TARGET];
    expect(collectSourceState(REPO_ROOT, scope).state, 'probe scope was already dirty').toBe('clean');

    // ARM A — the allowlist does its job: the build regenerates this file on
    // every compile, so dirtying it alone must NOT flag the source.
    const generatedOnly = withPlantedEdits([GENERATED_TARGET], () =>
      collectSourceState(REPO_ROOT, scope),
    );
    expect(generatedOnly.state).toBe('clean');
    expect(generatedOnly.modifiedCount).toBe(0);
    // …and it really was dirty on disk — the exclusion is the reason it reads
    // clean, not an absence of change.
    const generatedOnlyRaw = withPlantedEdits([GENERATED_TARGET], () =>
      spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain', '--', GENERATED_TARGET], {
        encoding: 'utf8',
      }).stdout.trim(),
    );
    expect(generatedOnlyRaw).toContain(GENERATED_TARGET);

    // ARM B — the allowlist is NOT a blanket escape: a non-allowlisted edit
    // still reddens even while an allowlisted file is simultaneously dirty.
    const both = withPlantedEdits([GENERATED_TARGET, PLANT_TARGET], () =>
      collectSourceState(REPO_ROOT, scope),
    );
    expect(both.state).toBe('modified');
    expect(both.modifiedPaths).toContain(PLANT_TARGET);
    expect(both.modifiedPaths).not.toContain(GENERATED_TARGET);
    expect(both.modifiedCount).toBe(1);

    expect(collectSourceState(REPO_ROOT, scope).state, 'probe files were not restored').toBe('clean');
  });

  it('BuildBinary_EmbedsSourceState_AgreeingWithIndependentGitVerdict', () => {
    const id = embedded as EmbeddedBuildIdentity;
    expect(id, 'built artifact carries no embedded build identity').toBeDefined();

    // The artifact's own claim about the tree it was compiled from, recovered
    // from its BYTES, versus this file's independent `git status` verdict.
    // Environment-agnostic on purpose: a clean CI checkout must come out
    // 'clean' and this (permanently dirty) working copy must come out
    // 'modified' — the assertion never hardcodes either.
    const independent = independentWorkingTreeVerdict(SOURCE_TREE_ROOTS);
    expect(id.sourceState).toBe(independent.state);

    if (id.sourceState === 'clean') {
      expect(id.modifiedPaths).toEqual([]);
      expect(id.modifiedCount).toBe(0);
    } else {
      expect(id.modifiedCount).toBeGreaterThan(0);
      // The cap bounds the banner baked into every artifact…
      expect(id.modifiedPaths.length).toBeLessThanOrEqual(MAX_REPORTED_MODIFIED_PATHS);
      // …but never hides the magnitude.
      expect(id.modifiedPaths.length).toBe(Math.min(id.modifiedCount, MAX_REPORTED_MODIFIED_PATHS));
      for (const p of id.modifiedPaths) expect(p).not.toContain('\\');
      // A build-generated path is never what makes a release look modified.
      for (const p of GENERATED_AT_BUILD_PATHS) expect(id.modifiedPaths).not.toContain(p);
    }

    // The state travels in the artifact's raw bytes, not just in our parse.
    expect(artifactBytes.toString('latin1')).toContain(`"sourceState":"${id.sourceState}"`);
  });

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

    // Visible in the Actions log…
    expect(modified).toContain('::warning::');
    // …states the magnitude…
    expect(modified).toContain(String(many.length));
    // …names the offenders…
    expect(modified).toContain('src/f0.ts');
    // …and admits what it elided rather than silently truncating.
    expect(modified).toContain('+3 more');
  });

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

    // The manifest is BUILT in the release pipeline (not a library with zero
    // call sites) …
    const buildStep = steps.find((s) => (s.run ?? '').includes('scripts/build-release-manifest.ts'));
    expect(buildStep, 'publish-release does not invoke scripts/build-release-manifest.ts').toBeDefined();

    // … SIGNED with a repository secret, never a literal or a default …
    const stepText = `${buildStep?.run ?? ''}\n${JSON.stringify(buildStep?.env ?? {})}`;
    expect(stepText).toContain('--private-key-env');
    expect(stepText).toMatch(/secrets\.[A-Z0-9_]*SIGNING_KEY/);

    // … and PUBLISHED as a release asset.
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

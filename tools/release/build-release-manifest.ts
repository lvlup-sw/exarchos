#!/usr/bin/env bun
/**
 * Build-time collector and CLI that turns real release build output into a signed release
 * manifest. It reuses the primitives of `src/install/release/` (`buildSourceIdentity`,
 * `contractIdentityFromLock`, `buildInstallIdentity`, `releaseAssetFromBytes`,
 * `buildReleaseManifest`, `signReleaseManifest`) and derives no rival digest.
 *
 * The `src` release layer is pure, so this module holds the impure acts. It runs
 * `git rev-parse HEAD` and reads the committed blobs under {@link SOURCE_TREE_ROOTS}. It also reads
 * the asset bytes, the contract lockfile and the Ed25519 private key. {@link buildIdentityBanner}
 * renders the identity banner that `build-binary.ts` embeds in each compiled binary.
 *
 * CLI: `bun run tools/release/build-release-manifest.ts --assets-dir dist/release --out <file>
 * --key-id <id> --private-key-env <VAR>`. A missing asset, a bad lock or a missing key aborts.
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthorityLockSchema } from '../../src/contract/authority-pin.js';
import {
  buildInstallIdentity,
  type DigestEntry,
  type InstallIdentity,
} from '../../src/install/install-identity.js';
import {
  buildSourceIdentity,
  contractIdentityFromLock,
  type ContractIdentity,
  type SourceIdentity,
} from '../../src/install/release/build-identity.js';
import {
  buildReleaseManifest,
  releaseAssetFromBytes,
  serializeSignedManifest,
  signReleaseManifest,
  type ReleaseAsset,
  type SignedReleaseManifest,
} from '../../src/install/release/release-manifest.js';

/** Absolute path of the repository root, derived from this file's location. */
export function repoRootFromHere(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The pathspecs of "the source that produced this artifact": the bundled module graph, the build
 * tooling and the dependency pins. This list is a wire contract. The `--expect-source` treeDigest
 * of the installer has meaning only when producer and verifier digest the same paths.
 * `tests/scripts/build-release-manifest.test.ts` recomputes the digest with its own `git ls-tree`.
 */
export const SOURCE_TREE_ROOTS = [
  'src',
  'src',
  'tools/audit',
  'tools/release',
  'runtimes',
  'package.json',
  'package-lock.json',
  'package.json',
  'package-lock.json',
] as const;

/**
 * Tracked paths in {@link SOURCE_TREE_ROOTS} that the build regenerates, so they do not count as a
 * source change in {@link collectSourceState}. Each entry is a hole in the provenance claim, so add
 * one only after an audit of every write on the binary build path.
 * `generateEmbeddedRuntimesModule` rewrites `src/install/runtimes/embedded.ts` before each
 * `bun build --compile`, so it is dirty in the `binary-matrix` jobs. `runtimes:guard` checks that
 * the checked-in copy matches the runtime YAML.
 */
export const GENERATED_AT_BUILD_PATHS = ['src/install/runtimes/embedded.ts'] as const;

/**
 * Cap on how many modified paths are NAMED in the identity. A pathological
 * working tree (thousands of edits) must not bloat the `--banner` payload
 * baked into every compiled artifact. The uncapped total is still carried
 * separately as `modifiedCount`, so the cap can never hide the magnitude.
 */
export const MAX_REPORTED_MODIFIED_PATHS = 16;

/** Pathspec for the rendered skill tree, the `skill` dimension of the install identity. */
export const SKILL_TREE_ROOTS = ['rendered/skills'] as const;

/** Path of the approved contract-authority lockfile, repo-relative. */
export const CONTRACT_LOCK_PATH = 'src/contract/contract-authority.lock.json';

/** Path of the plugin manifest, digested into the `plugin` dimension of the install identity. */
export const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

/**
 * The module that declares `SCHEMA_VERSION`. A regex reads it, because the backend imports
 * `bun:sqlite`, which the Node-hosted root test project cannot resolve. The path must name the
 * declaring module, because the regex matches only a declaration, not a re-export. The read fails
 * closed when the declaration moves or changes shape.
 */
export const SCHEMA_VERSION_SOURCE = 'src/storage/sqlite/schema.ts';

/** Filename shape of a published binary asset. `.sha512` sidecars are skipped. */
export const RELEASE_ASSET_NAME_RE = /^exarchos-(linux|darwin|windows)-(x64|arm64)(\.exe)?$/;

/** The release filename the workflow publishes the signed manifest under. */
export const RELEASE_MANIFEST_FILENAME = 'exarchos-release-manifest.json';

/** The global the compiled binary carries its build identity on. */
export const BUILD_IDENTITY_GLOBAL = '__EXARCHOS_BUILD_IDENTITY__';

/**
 * Format marker, so a shape change is detectable. The v2 shape carries `sourceState`,
 * `modifiedPaths` and `modifiedCount`.
 */
export const BUILD_IDENTITY_MARKER = 'exarchos-build-identity/v2';

/**
 * Whether the WORKING TREE the artifact was compiled from actually matched the
 * commit named in {@link EmbeddedBuildIdentity.source}.
 */
export type SourceState = 'clean' | 'modified';

/** The record embedded verbatim in the compiled artifact's bytes. */
export interface EmbeddedBuildIdentity {
  readonly marker: string;
  readonly version: string;
  readonly source: SourceIdentity;
  /**
   * `source.treeDigest` covers the committed tree at `source.commit`, so independent CI checkouts
   * agree, and a verifier with only the tag can recompute it. So the digest cannot tell a clean
   * build from an edited working tree. `sourceState` states if the compiled bytes came from the
   * named commit. A dirty tree does not stop the build, because `codegenEmbeddedRuntimes()`
   * rewrites a tracked file on each binary build. See {@link GENERATED_AT_BUILD_PATHS}.
   */
  readonly sourceState: SourceState;
  /**
   * The offending paths when `sourceState === 'modified'`, sorted and capped
   * at {@link MAX_REPORTED_MODIFIED_PATHS}. Empty when clean.
   */
  readonly modifiedPaths: readonly string[];
  /** UNCAPPED count of modified paths, so the cap cannot hide the magnitude. */
  readonly modifiedCount: number;
  readonly contract: ContractIdentity;
}

/**
 * Render an {@link EmbeddedBuildIdentity} as the `bun build --banner` payload.
 * A real assignment statement (not a comment) so no minifier or bundler pass
 * can drop it, and so the running binary can also introspect its own identity.
 */
export function buildIdentityBanner(identity: EmbeddedBuildIdentity): string {
  return `globalThis.${BUILD_IDENTITY_GLOBAL}=${JSON.stringify(identity)};`;
}

const BANNER_PREFIX = `globalThis.${BUILD_IDENTITY_GLOBAL}=`;

/**
 * Recovers the embedded identity from the raw bytes of a built artifact. Returns `undefined` when
 * the artifact carries no identity, and callers treat that as a hard failure.
 *
 * The scan decodes latin1, which maps each byte to one char, so binary regions cannot shift the
 * offsets of the brace matcher. The banner payload is UTF-8, so the parse re-encodes the
 * byte-exact latin1 slice and decodes it as UTF-8. A latin1 parse corrupts each character above
 * U+007F.
 */
export function extractEmbeddedBuildIdentity(bytes: Uint8Array): EmbeddedBuildIdentity | undefined {
  const text = Buffer.from(bytes).toString('latin1');
  const at = text.indexOf(BANNER_PREFIX);
  if (at < 0) return undefined;
  const start = text.indexOf('{', at + BANNER_PREFIX.length);
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const literal = text.slice(start, i + 1);
        const decoded = Buffer.from(literal, 'latin1').toString('utf8');
        return JSON.parse(decoded) as EmbeddedBuildIdentity;
      }
    }
  }
  return undefined;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Normalize a repo-relative path to POSIX separators so it compares equal to
 * the entries in {@link GENERATED_AT_BUILD_PATHS} on Windows too. `git`
 * already emits `/`, so this is belt-and-braces against a future caller.
 */
function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** One entry of a committed tree listing: the blob id and its repo path. */
export interface TreeBlob {
  readonly oid: string;
  readonly path: string;
}

/**
 * `git ls-tree -r` over `commit`, restricted to `pathspecs`. Each record is
 * `<mode> SP <type> SP <object> TAB <path>`.
 */
export function listCommittedBlobs(
  repoRoot: string,
  commit: string,
  pathspecs: readonly string[],
): TreeBlob[] {
  const raw = git(repoRoot, ['ls-tree', '-r', '-z', commit, '--', ...pathspecs]);
  const blobs: TreeBlob[] = [];
  for (const record of raw.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const meta = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (meta[1] !== 'blob' || meta[2] === undefined) continue;
    blobs.push({ oid: meta[2], path });
  }
  return blobs;
}

/**
 * Streams the contents of `blobs` from the object database in one `git cat-file --batch` call.
 * Each object ends with a trailing LF. The digest goes into each cross-compiled binary and into
 * the manifest, from separate CI checkouts. A working-tree digest splits when a job regenerates a
 * checked-in file. A digest of the committed blobs is the same for one tag on each runner.
 * Blob contents are the canonical stored bytes, so `core.autocrlf` cannot change them.
 */
export function readCommittedBlobEntries(repoRoot: string, blobs: readonly TreeBlob[]): DigestEntry[] {
  if (blobs.length === 0) return [];
  const stdin = `${blobs.map((b) => b.oid).join('\n')}\n`;
  const out = execFileSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input: stdin,
    maxBuffer: 1024 * 1024 * 1024,
  });

  const entries: DigestEntry[] = [];
  let pos = 0;
  for (const blob of blobs) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) throw new Error(`git cat-file --batch output truncated at ${blob.path}`);
    const header = out.subarray(pos, nl).toString('ascii').split(' ');
    if (header[0] !== blob.oid || header[2] === undefined) {
      throw new Error(
        `git cat-file --batch returned '${header.join(' ')}' for expected object ${blob.oid} (${blob.path})`,
      );
    }
    const size = Number.parseInt(header[2], 10);
    const start = nl + 1;
    entries.push({ path: blob.path, content: out.subarray(start, start + size).toString('utf8') });
    pos = start + size + 1;
  }
  return entries;
}

/**
 * Content entries for the files `commit` records under `pathspecs`, read from
 * the object database (see {@link readCommittedBlobEntries} for why).
 */
export function collectTreeEntries(
  repoRoot: string,
  commit: string,
  pathspecs: readonly string[],
): DigestEntry[] {
  const blobs = listCommittedBlobs(repoRoot, commit, pathspecs);
  if (blobs.length === 0) {
    throw new Error(`no committed files found at ${commit} under: ${pathspecs.join(', ')}`);
  }
  return readCommittedBlobEntries(repoRoot, blobs);
}

/** The exact commit + source-tree digest the artifacts were built from. */
export function collectSourceIdentity(repoRoot: string): SourceIdentity {
  const commit = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  return buildSourceIdentity({
    commit,
    treeEntries: collectTreeEntries(repoRoot, commit, SOURCE_TREE_ROOTS),
  });
}

/** Verdict on whether the working tree matches the commit being stamped. */
export interface SourceStateReport {
  readonly state: SourceState;
  /** Sorted, capped at {@link MAX_REPORTED_MODIFIED_PATHS}. */
  readonly modifiedPaths: readonly string[];
  /** Uncapped total. */
  readonly modifiedCount: number;
}

/**
 * Classifies the working tree against HEAD, scoped to `pathspecs`. `git status --porcelain -z
 * --untracked-files=all` reports staged, unstaged and untracked changes. `-z` stops path quoting,
 * and `--untracked-files=all` names each untracked file. A rename or copy record has a second
 * record with the origin path, and both paths count. The filter excludes exactly the paths in
 * {@link GENERATED_AT_BUILD_PATHS}, by set membership, never by prefix or glob.
 */
export function collectSourceState(
  repoRoot: string,
  pathspecs: readonly string[] = SOURCE_TREE_ROOTS,
): SourceStateReport {
  const raw = git(repoRoot, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    '--',
    ...pathspecs,
  ]);

  const records = raw.split('\0');
  const touched = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined || record.length < 4) continue;
    if (record[0] === 'R' || record[0] === 'C') {
      const origin = records[i + 1];
      i++;
      if (origin !== undefined && origin.length > 0) touched.add(toPosixPath(origin));
    }
    touched.add(toPosixPath(record.slice(3)));
  }

  const generated = new Set<string>(GENERATED_AT_BUILD_PATHS);
  const modified = [...touched].filter((p) => !generated.has(p)).sort();

  return {
    state: modified.length === 0 ? 'clean' : 'modified',
    modifiedPaths: modified.slice(0, MAX_REPORTED_MODIFIED_PATHS),
    modifiedCount: modified.length,
  };
}

/** The frozen contract-authority identity, read from the approved lock. */
export function collectContractIdentity(repoRoot: string): ContractIdentity {
  const lockText = readFileSync(join(repoRoot, CONTRACT_LOCK_PATH), 'utf8');
  const lock = AuthorityLockSchema.parse(JSON.parse(lockText));
  if (!lock.approved) {
    throw new Error(
      `contract-authority lock is not approved (${CONTRACT_LOCK_PATH}) — refusing to stamp an unapproved contract into a release`,
    );
  }
  return contractIdentityFromLock(lock);
}

/** Root `package.json` version — the release version string. */
export function readPackageVersion(repoRoot: string): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error('root package.json is missing a non-empty string `version` field');
  }
  return pkg.version;
}

/** Event-store schema version, read from its single source of truth. */
export function readSchemaVersion(repoRoot: string): number {
  const src = readFileSync(join(repoRoot, SCHEMA_VERSION_SOURCE), 'utf8');
  const m = /export const SCHEMA_VERSION\s*=\s*(\d+)/.exec(src);
  if (!m || m[1] === undefined) {
    throw new Error(`could not read SCHEMA_VERSION from ${SCHEMA_VERSION_SOURCE}`);
  }
  return Number.parseInt(m[1], 10);
}

/**
 * Lists the published binaries in `assetsDir` and digests their raw bytes. It skips `.sha512`
 * sidecars and each name that does not match {@link RELEASE_ASSET_NAME_RE}. An empty result is a
 * hard failure, because a manifest over zero assets verifies nothing.
 */
export function collectReleaseAssets(assetsDir: string): ReleaseAsset[] {
  const assets: ReleaseAsset[] = [];
  for (const name of readdirSync(assetsDir).sort()) {
    const m = RELEASE_ASSET_NAME_RE.exec(name);
    if (!m) continue;
    const abs = join(assetsDir, name);
    if (!statSync(abs).isFile()) continue;
    const os = m[1] as ReleaseAsset['os'];
    const arch = m[2] as ReleaseAsset['arch'];
    assets.push(releaseAssetFromBytes(name, os, arch, readFileSync(abs)));
  }
  if (assets.length === 0) {
    throw new Error(
      `no release assets matching ${RELEASE_ASSET_NAME_RE} found in ${assetsDir} — refusing to sign an empty manifest`,
    );
  }
  return assets;
}

/**
 * The install-identity record in the manifest. The `binary` dimension addresses the raw-byte
 * digests of the assets, not their bytes, because `digestTree` normalizes line endings and that
 * corrupts an executable. The install cache does not exist at build time. So the cache fields carry
 * an explicit placeholder, and the freshness gate fills them at install time.
 */
export function collectInstallIdentity(
  repoRoot: string,
  assets: readonly ReleaseAsset[],
): InstallIdentity {
  const commit = git(repoRoot, ['rev-parse', 'HEAD']).trim();
  return buildInstallIdentity({
    binaryVersion: readPackageVersion(repoRoot),
    binaryEntries: assets.map((a) => ({ path: a.name, content: a.digest })),
    pluginManifest: readFileSync(join(repoRoot, PLUGIN_MANIFEST_PATH), 'utf8'),
    skillEntries: collectTreeEntries(repoRoot, commit, SKILL_TREE_ROOTS),
    schemaVersion: readSchemaVersion(repoRoot),
    cacheLocation: '(unresolved-at-build-time)',
    cacheEntries: [],
  });
}

/** The identity stamped into the compiled binary by `tools/release/build-binary.ts`. */
export function collectEmbeddedBuildIdentity(repoRoot: string): EmbeddedBuildIdentity {
  const sourceState = collectSourceState(repoRoot);
  return {
    marker: BUILD_IDENTITY_MARKER,
    version: readPackageVersion(repoRoot),
    source: collectSourceIdentity(repoRoot),
    sourceState: sourceState.state,
    modifiedPaths: sourceState.modifiedPaths,
    modifiedCount: sourceState.modifiedCount,
    contract: collectContractIdentity(repoRoot),
  };
}

export interface BuildSignedManifestOptions {
  readonly repoRoot: string;
  readonly assetsDir: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
}

/**
 * Collect every identity from disk/git, assemble the manifest and sign it.
 * The private key is validated as a real Ed25519 key BEFORE signing so a
 * truncated secret fails loudly instead of producing a garbage signature.
 */
export function buildSignedReleaseManifest(
  options: BuildSignedManifestOptions,
): SignedReleaseManifest {
  const { repoRoot, assetsDir, keyId, privateKeyPem } = options;

  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `release signing key must be ed25519, got '${String(key.asymmetricKeyType)}'`,
    );
  }

  const assets = collectReleaseAssets(assetsDir);
  const manifest = buildReleaseManifest({
    version: readPackageVersion(repoRoot),
    source: collectSourceIdentity(repoRoot),
    contract: collectContractIdentity(repoRoot),
    install: collectInstallIdentity(repoRoot, assets),
    assets,
  });
  return signReleaseManifest(manifest, keyId, privateKeyPem);
}

interface CliArgs {
  readonly assetsDir: string;
  readonly out: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly repoRoot: string;
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new Error(`missing value for ${flag}`);
  return value;
}

export function parseCliArgs(argv: readonly string[], repoRootDefault: string): CliArgs {
  let assetsDir: string | undefined;
  let out: string | undefined;
  let keyId: string | undefined;
  let privateKeyFile: string | undefined;
  let privateKeyEnv: string | undefined;
  let repoRoot = repoRootDefault;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--assets-dir':
        assetsDir = requireValue(flag, argv[++i]);
        break;
      case '--out':
        out = requireValue(flag, argv[++i]);
        break;
      case '--key-id':
        keyId = requireValue(flag, argv[++i]);
        break;
      case '--private-key-file':
        privateKeyFile = requireValue(flag, argv[++i]);
        break;
      case '--private-key-env':
        privateKeyEnv = requireValue(flag, argv[++i]);
        break;
      case '--repo-root':
        repoRoot = resolve(requireValue(flag, argv[++i]));
        break;
      default:
        throw new Error(`unknown argument '${String(flag)}'`);
    }
  }

  if (assetsDir === undefined) throw new Error('--assets-dir is required');
  if (out === undefined) throw new Error('--out is required');
  if (keyId === undefined) throw new Error('--key-id is required');
  if (privateKeyFile === undefined && privateKeyEnv === undefined) {
    throw new Error('one of --private-key-file or --private-key-env is required');
  }
  if (privateKeyFile !== undefined && privateKeyEnv !== undefined) {
    throw new Error('--private-key-file and --private-key-env are mutually exclusive');
  }

  let privateKeyPem: string;
  if (privateKeyFile !== undefined) {
    privateKeyPem = readFileSync(privateKeyFile, 'utf8');
  } else {
    const fromEnv = process.env[privateKeyEnv as string];
    if (fromEnv === undefined || fromEnv.trim().length === 0) {
      throw new Error(
        `environment variable '${String(privateKeyEnv)}' is empty or unset — refusing to publish an unsigned release`,
      );
    }
    privateKeyPem = fromEnv;
  }

  return { assetsDir: resolve(assetsDir), out: resolve(out), keyId, privateKeyPem, repoRoot };
}

/**
 * Renders the lines that describe a {@link SourceStateReport}. It is separate from
 * {@link runBuildReleaseManifest}, so a test can assert the lines without stdout capture. A
 * modified state uses the GitHub `::warning::` annotation, so a dirty-checkout release is visible
 * in the Actions log. The manifest step still succeeds. See {@link GENERATED_AT_BUILD_PATHS}.
 */
export function renderSourceStateReport(report: SourceStateReport): string[] {
  if (report.state === 'clean') {
    return ['Source state: clean (working tree matches HEAD under SOURCE_TREE_ROOTS)'];
  }
  const shown = report.modifiedPaths.join(', ');
  const elided = report.modifiedCount - report.modifiedPaths.length;
  const suffix = elided > 0 ? ` (+${elided} more)` : '';
  return [
    `::warning::Source state: modified — ${report.modifiedCount} path(s) under SOURCE_TREE_ROOTS differ from HEAD. The published artifacts were NOT built from a clean checkout.`,
    `Modified paths: ${shown}${suffix}`,
  ];
}

/**
 * Collects, assembles, signs and writes the manifest, and returns the path written. The module
 * calls it only when bun runs this file as the entry point (`import.meta.main`). So an import from
 * `build-binary.ts` or a test never shells out to git.
 */
export function runBuildReleaseManifest(argv: readonly string[], repoRootDefault: string): string {
  const args = parseCliArgs(argv, repoRootDefault);
  for (const line of renderSourceStateReport(collectSourceState(args.repoRoot))) {
    console.log(line);
  }
  const signed = buildSignedReleaseManifest({
    repoRoot: args.repoRoot,
    assetsDir: args.assetsDir,
    keyId: args.keyId,
    privateKeyPem: args.privateKeyPem,
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${serializeSignedManifest(signed)}\n`, 'utf8');
  return args.out;
}

if ((import.meta as ImportMeta & { readonly main?: boolean }).main === true) {
  const written = runBuildReleaseManifest(process.argv.slice(2), repoRootFromHere());
  console.log(`Wrote signed release manifest ${written}`);
}

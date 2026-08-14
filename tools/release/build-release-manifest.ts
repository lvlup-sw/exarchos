#!/usr/bin/env bun
/**
 * Build-time collector + CLI that turns REAL release build output into a
 * signed release manifest (DR-20, P05-01 step 1 + 2).
 *
 * `src/install/release/**` already ships the manifest wire
 * contract, the identity derivations, the signer and the installer-side
 * verifier — but it had ZERO production call sites: its own README names the
 * missing pieces ("a build-time collector shells out to git … the release
 * workflow publishes `serializeSignedManifest(...)`"). This module IS that
 * collector. It deliberately reuses the existing primitives
 * (`buildSourceIdentity`, `contractIdentityFromLock`, `buildInstallIdentity`,
 * `releaseAssetFromBytes`, `buildReleaseManifest`, `signReleaseManifest`)
 * rather than re-deriving rival digests.
 *
 * ── What is impure here (and why it lives in scripts/, not src/) ─────────
 * The `src/release` layer is pure by design: no fs, no git, no clock. Every
 * impure act a real release needs is concentrated here:
 *
 *   - `git rev-parse HEAD`  → the exact commit the artifacts were built from.
 *   - `git ls-tree` +
 *     `git cat-file --batch`→ the COMMITTED contents under SOURCE_TREE_ROOTS.
 *                             Committed, not working-tree, because the same
 *                             digest is stamped into five cross-compiled
 *                             binaries built on five separate runners and into
 *                             the manifest built on a sixth — see
 *                             `readCommittedBlobEntries` for the full rationale.
 *   - reading `dist/release/exarchos-<os>-<arch>[.exe]` → raw asset bytes.
 *   - reading the P03-01 contract-authority lockfile.
 *   - reading the Ed25519 publisher private key (file or env var).
 *
 * ── Embedded build identity (the second half of DR-20) ──────────────────
 * `buildIdentityBanner` renders the source + contract identity as a single
 * JavaScript statement that `tools/release/build-binary.ts` passes to
 * `bun build --banner`. The banner is prepended to the bundled JS *after*
 * minification, so the bytes survive verbatim into the compiled executable
 * and can be recovered from the artifact with
 * `extractEmbeddedBuildIdentity(<raw bytes>)`. That is what makes "source and
 * contract identity are embedded in the built artifact" checkable against the
 * artifact's own bytes rather than against a build-time variable.
 *
 * ── CLI ─────────────────────────────────────────────────────────────────
 *   bun run tools/release/build-release-manifest.ts \
 *     --assets-dir dist/release \
 *     --out dist/release/exarchos-release-manifest.json \
 *     --key-id publisher.a \
 *     --private-key-env EXARCHOS_RELEASE_SIGNING_KEY
 *
 * Fail-closed everywhere: no assets, an unparseable/incomplete contract lock,
 * a missing signing key, or a dirty-but-unreadable source file all abort the
 * release rather than emitting a weaker manifest.
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

// ─── Repo layout constants ───────────────────────────────────────────────────

/** Absolute path of the repository root, derived from this file's location. */
export function repoRootFromHere(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The pathspecs whose files constitute "the source that produced this
 * artifact". Kept deliberately narrow and explicit: the bundled module graph
 * (`src`, `src`, `runtimes`), the build tooling that
 * produced it (`scripts`), and the dependency pins that fix the third-party
 * half (`package.json` / `package-lock.json` at both levels).
 *
 * This list is a WIRE CONTRACT: the installer's `--expect-source` treeDigest is
 * only meaningful if producer and verifier agree on what is being digested.
 * Narrowing it silently would weaken every downstream source check, so
 * `scripts/build-release-manifest.test.ts` recomputes the digest from its own
 * independent enumeration of this same list.
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
 * Tracked paths inside {@link SOURCE_TREE_ROOTS} that the build itself
 * REGENERATES, and which therefore must not count as "the developer modified
 * the source" when {@link collectSourceState} classifies the working tree.
 *
 * This list is deliberately tiny, explicit and VERIFIED rather than guessed —
 * it was derived by enumerating every filesystem write on the binary build
 * path (`tools/release/build-binary.ts` → `codegenEmbeddedRuntimes()`):
 *
 * - `src/install/runtimes/embedded.ts` — rewritten by `generateEmbeddedRuntimesModule`
 *   (`tools/release/codegen-runtimes.ts:153`) before EVERY `bun build --compile`, so
 *   it is dirty in the five `binary-matrix` jobs and clean in `publish-release`
 *   (which never runs codegen). Excluding it is what keeps a legitimate release
 *   from reporting itself as modified. `runtimes:guard` separately enforces
 *   that the checked-in copy has not drifted, so this exclusion cannot be used
 *   to smuggle an edit: a real edit to `content/harness/runtimes/*.yaml` still lands in
 *   `SOURCE_TREE_ROOTS` and still reddens the state.
 *
 * The only other write on that path is `mkdirSync(outdir)` for `dist/bin`,
 * which is untracked and outside {@link SOURCE_TREE_ROOTS}.
 *
 * NOTHING ELSE MAY BE ADDED HERE without an equivalent audit — every entry is
 * a hole in the provenance claim.
 */
export const GENERATED_AT_BUILD_PATHS = ['src/install/runtimes/embedded.ts'] as const;

/**
 * Cap on how many modified paths are NAMED in the identity. A pathological
 * working tree (thousands of edits) must not bloat the `--banner` payload
 * baked into every compiled artifact. The uncapped total is still carried
 * separately as `modifiedCount`, so the cap can never hide the magnitude.
 */
export const MAX_REPORTED_MODIFIED_PATHS = 16;

/** Pathspec for the rendered skill tree (P05-04 `skill` dimension). */
export const SKILL_TREE_ROOTS = ['rendered/skills'] as const;

/** Path of the P03-01 approved contract-authority lockfile, repo-relative. */
export const CONTRACT_LOCK_PATH = 'src/contract/contract-authority.lock.json';

/** Path of the plugin manifest digested into the P05-04 `plugin` dimension. */
export const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

/**
 * Where `SCHEMA_VERSION` is DECLARED. It is read by REGEX rather than imported
 * because the backend imports `bun:sqlite`, which is not resolvable from the
 * root (Node-hosted) test project. Fails closed if the declaration ever moves
 * or changes shape — which is exactly what happened when the backend's
 * declarations were split out of `sqlite-backend.ts`: the barrel still
 * re-exports the name, but a re-export is not a declaration and the regex
 * stopped matching. Naming the DECLARING module keeps the read honest, since a
 * regex pointed at a re-export would match nothing while looking fine.
 */
export const SCHEMA_VERSION_SOURCE = 'src/storage/sqlite/schema.ts';

/** Filename shape of a published binary asset. `.sha512` sidecars are skipped. */
export const RELEASE_ASSET_NAME_RE = /^exarchos-(linux|darwin|windows)-(x64|arm64)(\.exe)?$/;

/** The release filename the workflow publishes the signed manifest under. */
export const RELEASE_MANIFEST_FILENAME = 'exarchos-release-manifest.json';

// ─── Embedded build identity (banner in / bytes out) ─────────────────────────

/** The global the compiled binary carries its build identity on. */
export const BUILD_IDENTITY_GLOBAL = '__EXARCHOS_BUILD_IDENTITY__';

/**
 * Format marker, so a future shape change is detectable rather than silent.
 * Bumped to v2 when `sourceState`/`modifiedPaths`/`modifiedCount` were added.
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
   * `source.treeDigest` is computed over the COMMITTED tree at `source.commit`,
   * not over the working tree — that is deliberate (it is the only way six
   * independent CI checkouts can agree on one digest, and the only way a
   * verifier holding just the tag can recompute it).
   *
   * The cost of that choice is that the digest alone cannot distinguish a
   * build from clean HEAD from a build whose working tree had been edited.
   * `sourceState` closes exactly that gap: it is the artifact's own, explicit
   * statement about whether the bytes it is made of came from the commit it
   * names. A `'modified'` artifact still carries a truthful commit + tree
   * digest — it simply no longer CLAIMS those describe what was compiled.
   *
   * Deliberately NOT fail-closed: `codegenEmbeddedRuntimes()` rewrites a
   * tracked file on every binary build, so refusing to build on a dirty tree
   * would abort every real release. See {@link GENERATED_AT_BUILD_PATHS}.
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
 * Recover the embedded identity from the RAW BYTES of a built artifact.
 *
 * Decodes latin1 (a lossless byte↔char mapping, so binary regions cannot
 * corrupt the scan), locates the banner assignment, brace-matches the object
 * literal and JSON-parses it. Returns `undefined` when the artifact carries no
 * identity at all — callers treat that as a hard failure.
 *
 * ── TWO ENCODINGS, DELIBERATELY ─────────────────────────────────────────────
 * The SCAN must be latin1 and the PARSE must be UTF-8, and conflating them is
 * a real bug this code shipped with. latin1 is right for scanning precisely
 * because it is total: every byte maps to exactly one char, so arbitrary
 * binary in a compiled artifact can neither raise nor produce replacement
 * characters that would desynchronise the brace matcher's offsets. But the
 * banner payload is UTF-8, so a latin1 char-run is that text's BYTES wearing
 * the wrong type. `JSON.parse` on the latin1 string therefore yields mojibake
 * for anything above U+007F — an em dash (`E2 80 94`) comes back as three
 * characters.
 *
 * It stayed invisible while every embedded value happened to be ASCII (hex
 * digests, commit shas, semver). The first non-ASCII value — task 049's
 * `approvedBy`, which carries an em dash and an arrow — turned a
 * round-trip-identity assertion red, and the failure named the encoding rather
 * than the field, so it read as a manifest mismatch.
 *
 * The slice is taken in latin1 space where one char is exactly one byte, so
 * re-encoding it as latin1 recovers the ORIGINAL bytes exactly; decoding those
 * as UTF-8 is then the payload's true text. The scan keeps its totality and
 * the parse gets its real encoding.
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
        // latin1 → bytes → UTF-8. See the encoding note above: the slice is
        // byte-exact, so this recovers the payload's real text rather than its
        // bytes reinterpreted as characters.
        const decoded = Buffer.from(literal, 'latin1').toString('utf8');
        return JSON.parse(decoded) as EmbeddedBuildIdentity;
      }
    }
  }
  return undefined;
}

// ─── Impure collectors ───────────────────────────────────────────────────────

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

/** `git ls-tree -r` over `commit`, restricted to `pathspecs`. */
export function listCommittedBlobs(
  repoRoot: string,
  commit: string,
  pathspecs: readonly string[],
): TreeBlob[] {
  const raw = git(repoRoot, ['ls-tree', '-r', '-z', commit, '--', ...pathspecs]);
  const blobs: TreeBlob[] = [];
  for (const record of raw.split('\0')) {
    if (record.length === 0) continue;
    // `<mode> SP <type> SP <object> TAB <path>`
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
 * Stream the contents of `blobs` out of the object database in ONE
 * `git cat-file --batch` call and pair them with their paths.
 *
 * ── Why the COMMITTED tree and not the working tree ─────────────────────
 * The source-tree digest is stamped into five cross-compiled binaries (five
 * separate `binary-matrix` runners) AND into the signed manifest built in a
 * sixth job. Those are six independent checkouts. A working-tree digest would
 * only coincide across all six by luck — any job that regenerates a checked-in
 * artifact (e.g. `codegenEmbeddedRuntimes()` rewriting `src/install/runtimes/embedded.ts`)
 * or any concurrent edit would silently split the identity in two and make the
 * installer's source check unsatisfiable. Digesting the commit's own blobs is
 * reproducible by construction: same tag ⇒ same digest, on every runner, on
 * every platform, at any later date.
 *
 * Blob contents are git's canonical stored bytes, so they are already immune to
 * `core.autocrlf` differences; `digestTree` normalizes on top of that.
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
    pos = start + size + 1; // trailing LF after each object
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
 * Classify the WORKING TREE against HEAD, scoped to `pathspecs`.
 *
 * `git status --porcelain -z --untracked-files=all` is the authority: it
 * reports staged changes, unstaged changes, and untracked files alike, all of
 * which mean "the bytes on disk are not the bytes at HEAD". `-z` disables path
 * quoting/truncation; `--untracked-files=all` stops git collapsing an
 * untracked directory into a single entry, so every offending path is nameable.
 *
 * Paths in {@link GENERATED_AT_BUILD_PATHS} are excluded — and ONLY those. The
 * filter is an exact set-membership test on the normalized path, never a
 * prefix or glob match, so it cannot silently widen into a blanket escape.
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
    // `XY<space><path>` — anything shorter is the trailing empty record.
    if (record === undefined || record.length < 4) continue;
    // Rename/copy entries are followed by a SECOND NUL-terminated record
    // holding the ORIGIN path. Both sides are working-tree deviations, and
    // failing to consume the origin here would misparse it as a status code.
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

/** The P03-01 frozen contract-authority identity, read from the approved lock. */
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
 * Enumerate the published binaries in `assetsDir` and digest their RAW bytes.
 * `.sha512` sidecars and anything not matching {@link RELEASE_ASSET_NAME_RE}
 * are skipped; an empty result is a hard failure (a manifest over zero assets
 * verifies nothing).
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
 * The P05-04 install-identity record embedded in the manifest. The `binary`
 * dimension is content-addressed over the assets' RAW-byte digests (not their
 * bytes — `digestTree` normalizes line endings, which would corrupt an
 * executable), so it still tracks the real artifacts.
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
    // The install cache does not exist at build time; the freshness gate fills
    // this in at install time. Recorded explicitly rather than faked.
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

// ─── Assemble + sign ─────────────────────────────────────────────────────────

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

// ─── CLI ─────────────────────────────────────────────────────────────────────

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

/** Collect → assemble → sign → write. Returns the path written. */
/**
 * Render the human/CI-facing lines describing a {@link SourceStateReport}.
 *
 * Split out from {@link runBuildReleaseManifest} so it is assertable without
 * capturing stdout. Uses GitHub's `::warning::` annotation syntax so a release
 * built from a dirty checkout is impossible to miss in the Actions log — the
 * manifest step still succeeds (see {@link GENERATED_AT_BUILD_PATHS} for why
 * this is not fail-closed), but it does not pass silently.
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

// Side-effecting entrypoint only when invoked directly, so importing this
// module (from `tools/release/build-binary.ts` or a test) never shells out to git.
// `import.meta.main` is bun's "is this module the entry point" signal; it is
// `undefined` under non-bun runners, which is exactly the behaviour we want.
if ((import.meta as ImportMeta & { readonly main?: boolean }).main === true) {
  const written = runBuildReleaseManifest(process.argv.slice(2), repoRootFromHere());
  console.log(`Wrote signed release manifest ${written}`);
}

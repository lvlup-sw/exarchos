/**
 * Read the {@link InstallIdentity} from the live filesystem. This module also
 * detects the install posture, and reads and writes the recorded lock for the
 * freshness gate.
 *
 *   - installed: a plugin-root env var is set, or the Claude plugin cache
 *     exists. A mismatch between the recorded identity and the disk is a stale
 *     install that must block.
 *   - dev-checkout: Exarchos runs from source. The freshness gate skips, because
 *     there is no installed content to compare.
 *
 * Each filesystem and environment seam is injectable for hermetic tests.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SCHEMA_VERSION } from '../storage/sqlite-backend.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { resolveCacheDir, resolveInstallIdentityDir, toPosix } from '../utils/paths.js';
import {
  buildInstallIdentity,
  InstallIdentitySchema,
  UNKNOWN_VERSION_SENTINEL,
  type DigestEntry,
  type InstallIdentity,
} from './install-identity.js';

/**
 * The stable cache descriptor file. The freshness gate digests this file, not
 * the cache payload, so normal cache writes do not block the next run. A cache
 * is stale when its descriptor diverges, for example after a binary upgrade.
 */
export const CACHE_DESCRIPTOR_FILENAME = 'cache-manifest.json';

/**
 * The stem and extension of the recorded identity lock, written at install or
 * first run (TOFU). {@link installIdentityLockPath} adds a per-install key.
 */
export const INSTALL_IDENTITY_LOCK_FILENAME = 'install-identity.json';

/** Injectable filesystem / environment seams. All default to live process state. */
export interface IdentityDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homedir?: string;
  /** Read a UTF-8 file. It must return `undefined` when the file is absent or unreadable. */
  readonly readFileText?: (filePath: string) => string | undefined;
  /** Read a directory tree into digest entries with relative POSIX paths, or `[]` when absent. */
  readonly readTree?: (dir: string) => DigestEntry[];
  /** Existence probe. */
  readonly pathExists?: (target: string) => boolean;
  /** Write a UTF-8 file (creating parents). */
  readonly writeFileText?: (filePath: string, content: string) => void;
  /** Recursively create a directory. */
  readonly mkdirp?: (dir: string) => void;
  /** Event-store schema version (defaults to {@link SCHEMA_VERSION}). */
  readonly schemaVersion?: number;
  /** Rendered-skills runtime subdirectory under `skills/` (defaults to `claude`). */
  readonly skillsRuntime?: string;
}

/** Detected install posture — a discriminated union so callers `switch` on `kind`. */
export type InstallPosture =
  | {
      readonly kind: 'installed';
      readonly pluginRoot: string;
      readonly source: 'env-exarchos' | 'env-claude' | 'claude-cache';
    }
  | { readonly kind: 'dev-checkout'; readonly reason: string };

function defaultReadFileText(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Read a directory tree into digest entries. It skips an unreadable directory or file. */
function defaultReadTree(dir: string): DigestEntry[] {
  const entries: DigestEntry[] = [];
  const walk = (current: string, rel: string): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const childAbs = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        walk(childAbs, childRel);
      } else if (dirent.isFile()) {
        try {
          entries.push({ path: childRel, content: fs.readFileSync(childAbs, 'utf-8') });
        } catch {
        }
      }
    }
  };
  walk(dir, '');
  return entries;
}

/**
 * Write the TOFU lock through an atomic publish, not a plain write. The read
 * side treats a corrupt lock as no lock. Thus a crash during a plain write can
 * change a blocked verdict into `bootstrapped`. With an atomic publish, a reader
 * sees the old lock or the new lock, never a partial write.
 */
function defaultWriteFileText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFile(filePath, content);
}

function defaultMkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Return the `version` string from `package.json` text. Return `undefined` when
 * the text is absent, is not JSON, or has no non-empty `version` string.
 */
function extractPackageVersion(pkgText: string | undefined): string | undefined {
  if (pkgText === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkgText);
  } catch {
    return undefined;
  }
  if (parsed !== null && typeof parsed === 'object' && 'version' in parsed) {
    const version = (parsed as { version?: unknown }).version;
    if (typeof version === 'string' && version.length > 0) return version;
  }
  return undefined;
}

/**
 * Detect whether Exarchos is running as an installed plugin or from a source
 * checkout. Installed is signalled by `EXARCHOS_PLUGIN_ROOT` /
 * `CLAUDE_PLUGIN_ROOT`, or by the presence of the Claude plugin cache
 * directory. Anything else is a dev checkout.
 */
export function detectInstallPosture(deps: IdentityDeps = {}): InstallPosture {
  const env = deps.env ?? process.env;
  const home = deps.homedir ?? os.homedir();
  const pathExists = deps.pathExists ?? ((target: string): boolean => fs.existsSync(target));

  const exarchosRoot = env['EXARCHOS_PLUGIN_ROOT'];
  if (exarchosRoot !== undefined && exarchosRoot.trim() !== '') {
    return { kind: 'installed', pluginRoot: exarchosRoot, source: 'env-exarchos' };
  }
  const claudeRoot = env['CLAUDE_PLUGIN_ROOT'];
  if (claudeRoot !== undefined && claudeRoot.trim() !== '') {
    return { kind: 'installed', pluginRoot: claudeRoot, source: 'env-claude' };
  }
  const cacheRoot = path.join(home, '.claude', 'plugins', 'cache', 'lvlup-sw', 'exarchos');
  if (pathExists(cacheRoot)) {
    return { kind: 'installed', pluginRoot: cacheRoot, source: 'claude-cache' };
  }
  return {
    kind: 'dev-checkout',
    reason: 'no plugin-root env and no Claude plugin cache — running from source',
  };
}

/**
 * Read the {@link InstallIdentity} on disk under `pluginRoot`.
 *
 *   - binary: the `version` and a digest of `package.json`.
 *   - plugin: `.claude-plugin/plugin.json`, else `manifest.json`, else an empty string.
 *   - skill: the `skills/<runtime>` tree.
 *   - schema: {@link SCHEMA_VERSION} of the running binary.
 *   - cache: the resolved cache dir and its stable descriptor, never the payload.
 */
export function collectInstallIdentity(pluginRoot: string, deps: IdentityDeps = {}): InstallIdentity {
  const readFileText = deps.readFileText ?? defaultReadFileText;
  const readTree = deps.readTree ?? defaultReadTree;
  const skillsRuntime = deps.skillsRuntime ?? 'claude';
  const schemaVersion = deps.schemaVersion ?? SCHEMA_VERSION;

  const pkgText = readFileText(path.join(pluginRoot, 'package.json'));
  const binaryVersion = extractPackageVersion(pkgText) ?? UNKNOWN_VERSION_SENTINEL;
  const binaryEntries: DigestEntry[] =
    pkgText !== undefined ? [{ path: 'package.json', content: pkgText }] : [];

  const pluginManifest =
    readFileText(path.join(pluginRoot, '.claude-plugin', 'plugin.json')) ??
    readFileText(path.join(pluginRoot, 'manifest.json')) ??
    '';

  const skillEntries = readTree(path.join(pluginRoot, 'skills', skillsRuntime));

  const cacheLocation = resolveCacheDir({
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
  });
  const cacheDescriptor =
    readFileText(path.join(cacheLocation, CACHE_DESCRIPTOR_FILENAME)) ?? '';
  const cacheEntries: DigestEntry[] = [
    { path: CACHE_DESCRIPTOR_FILENAME, content: cacheDescriptor },
  ];

  return buildInstallIdentity({
    binaryVersion,
    binaryEntries,
    pluginManifest,
    skillEntries,
    schemaVersion,
    cacheLocation,
    cacheEntries,
  });
}

/**
 * Absolute path of the recorded identity lock for one installation. The key is
 * `pluginRoot`, not the state dir, so a change of `WORKFLOW_STATE_DIR` does not
 * move the lock. Otherwise one install gets a different freshness verdict for
 * each store. A digest of `pluginRoot` keeps two installs on one machine apart.
 *
 * Nothing reads an old lock in the state dir, so the install bootstraps again
 * through TOFU. The result uses POSIX separators because a caller compares it
 * with the forward-slash path from {@link resolveInstallIdentityDir}.
 */
export function installIdentityLockPath(pluginRoot: string, deps: IdentityDeps = {}): string {
  const dir = resolveInstallIdentityDir({
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
  });
  const key = createHash('sha256').update(path.resolve(pluginRoot)).digest('hex').slice(0, 12);
  const { name, ext } = path.parse(INSTALL_IDENTITY_LOCK_FILENAME);
  return toPosix(path.join(dir, `${name}-${key}${ext}`));
}

/**
 * Read the recorded install identity. Return `undefined` when no lock exists
 * yet, or when the lock is corrupt, so that a new record can heal it.
 */
export function readRecordedIdentity(
  pluginRoot: string,
  deps: IdentityDeps = {},
): InstallIdentity | undefined {
  const readFileText = deps.readFileText ?? defaultReadFileText;
  const text = readFileText(installIdentityLockPath(pluginRoot, deps));
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = InstallIdentitySchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/** Persist the expected install identity as the lock (install / first-run TOFU). */
export function writeRecordedIdentity(
  pluginRoot: string,
  identity: InstallIdentity,
  deps: IdentityDeps = {},
): void {
  const writeFileText = deps.writeFileText ?? defaultWriteFileText;
  const mkdirp = deps.mkdirp ?? defaultMkdirp;
  const lockPath = installIdentityLockPath(pluginRoot, deps);
  mkdirp(path.dirname(lockPath));
  writeFileText(lockPath, `${JSON.stringify(identity, null, 2)}\n`);
}

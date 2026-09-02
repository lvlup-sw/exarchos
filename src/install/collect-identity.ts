/**
 * collect-identity — the production reader that materializes an
 * {@link InstallIdentity} from the live filesystem, plus the install-posture
 * detection and the recorded-lock read/write used by the freshness gate
 * (P05-04; ART-006, ART-007, ART-009, ART-013).
 *
 * Two distinct install postures are recognised, and the distinction is
 * load-bearing:
 *
 *   - **installed** — Exarchos is running from a plugin install (a plugin-root
 *     env var is set, or the Claude plugin cache directory exists). Here the
 *     five install dimensions live at known on-disk locations and a mismatch
 *     between the recorded install identity and what is actually on disk is a
 *     genuine stale/mixed install that must block.
 *   - **dev-checkout** — Exarchos is running from a source checkout (no plugin
 *     root, no plugin cache). There is no "installed" content to diverge from,
 *     so the freshness gate SKIPS entirely. A developer running the test suite
 *     or `exarchos` from source must never be treated as a corrupt install.
 *
 * Every seam (filesystem, environment, home directory, schema version) is
 * injectable so the collector can be exercised hermetically; production callers
 * pass only the required `pluginRoot` / `stateDir` and the live defaults apply.
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
 * The stable cache DESCRIPTOR file. The freshness gate digests this marker —
 * NOT the volatile cache payload — so ordinary runtime cache writes (which
 * change the payload but not the descriptor) never false-block on the next run.
 * A stale cache is one whose *owning-install descriptor* diverges, which is
 * exactly the "upgraded binary, lingering old cache" case P05-04 blocks.
 */
export const CACHE_DESCRIPTOR_FILENAME = 'cache-manifest.json';

/**
 * Recorded expected-identity lock, written at install / first-run (TOFU).
 *
 * The stem and extension of the real filename, which
 * {@link installIdentityLockPath} suffixes with a per-install key. Kept as one
 * constant so the lock's name lives in a single place even though the path is
 * now computed.
 */
export const INSTALL_IDENTITY_LOCK_FILENAME = 'install-identity.json';

/** Injectable filesystem / environment seams. All default to live process state. */
export interface IdentityDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homedir?: string;
  /** Read a UTF-8 file; MUST return `undefined` when the file is absent/unreadable. */
  readonly readFileText?: (filePath: string) => string | undefined;
  /** Recursively read a directory into digest entries (relative POSIX paths); `[]` if absent. */
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
          // Unreadable file — skip it rather than aborting the whole tree read.
        }
      }
    }
  };
  walk(dir, '');
  return entries;
}

/**
 * TOFU-lock writes go through the atomic tmp+fsync+rename publish, NOT a plain
 * `fs.writeFileSync`. The read side ({@link readRecordedIdentity}) deliberately
 * treats a corrupt lock as "no lock" so a re-record can heal it — which means a
 * crash mid-plain-write would silently convert a would-be BLOCKED freshness
 * verdict into `bootstrapped`. An atomic publish makes a torn lock unobservable:
 * a reader sees the prior lock or the new lock, never a partial write.
 */
function defaultWriteFileText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWriteFile(filePath, content);
}

function defaultMkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Extract the `version` string from a `package.json` text blob. Returns
 * `undefined` when the text is absent or the field is missing/non-string —
 * callers substitute a sentinel so the binary dimension still digests
 * deterministically.
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
 * Materialize the {@link InstallIdentity} that is actually on disk under
 * `pluginRoot`. Pure w.r.t. the injected seams: identical on-disk content (modulo
 * line endings / path separators) yields an identical record on any platform.
 *
 *   - binary  ← `<pluginRoot>/package.json` (`version` + a descriptor digest).
 *   - plugin  ← `<pluginRoot>/.claude-plugin/plugin.json`, else `<pluginRoot>/manifest.json`.
 *   - skill   ← `<pluginRoot>/skills/<runtime>` tree.
 *   - schema  ← {@link SCHEMA_VERSION} (the running binary's store schema).
 *   - cache   ← resolved cache dir + its stable descriptor marker.
 */
export function collectInstallIdentity(pluginRoot: string, deps: IdentityDeps = {}): InstallIdentity {
  const readFileText = deps.readFileText ?? defaultReadFileText;
  const readTree = deps.readTree ?? defaultReadTree;
  const skillsRuntime = deps.skillsRuntime ?? 'claude';
  const schemaVersion = deps.schemaVersion ?? SCHEMA_VERSION;

  // binary — version + a descriptor digest over package.json (pins version +
  // dependency graph; a swapped bundle without a version bump still diverges).
  const pkgText = readFileText(path.join(pluginRoot, 'package.json'));
  const binaryVersion = extractPackageVersion(pkgText) ?? UNKNOWN_VERSION_SENTINEL;
  const binaryEntries: DigestEntry[] =
    pkgText !== undefined ? [{ path: 'package.json', content: pkgText }] : [];

  // plugin — prefer the Claude plugin manifest, fall back to the marketplace
  // manifest; empty string when neither is present (a benign-but-detectable
  // "no manifest installed" baseline).
  const pluginManifest =
    readFileText(path.join(pluginRoot, '.claude-plugin', 'plugin.json')) ??
    readFileText(path.join(pluginRoot, 'manifest.json')) ??
    '';

  // skill — the rendered skill tree for the active runtime.
  const skillEntries = readTree(path.join(pluginRoot, 'skills', skillsRuntime));

  // cache — resolved location + the STABLE descriptor marker (never the payload).
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
 * Absolute path of the recorded install-identity lock for a given installation.
 *
 * Keyed on `pluginRoot`, NOT on the event-store state dir. The lock records
 * what is INSTALLED, so its location must not move when `WORKFLOW_STATE_DIR`
 * does — otherwise one installation carries a different recorded identity per
 * store and reports two different freshness verdicts, which is what made
 * `doctor` self-contradictory and blocked the very configuration that collapses
 * a store divergence.
 *
 * The `pluginRoot` digest keeps two installs on one machine from sharing a
 * lock; the directory itself comes from {@link resolveInstallIdentityDir},
 * which never consults the store env var.
 *
 * Migration: an existing lock under the old state-dir location is NOT read
 * back. Reading it would reintroduce exactly the `WORKFLOW_STATE_DIR` variance
 * being removed. The absent lock re-bootstraps through the designed TOFU path
 * (record and proceed, never block).
 */
export function installIdentityLockPath(pluginRoot: string, deps: IdentityDeps = {}): string {
  const dir = resolveInstallIdentityDir({
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.homedir !== undefined ? { homedir: deps.homedir } : {}),
  });
  const key = createHash('sha256').update(path.resolve(pluginRoot)).digest('hex').slice(0, 12);
  const { name, ext } = path.parse(INSTALL_IDENTITY_LOCK_FILENAME);
  // POSIX separators, like every other resolver in `utils/paths.ts`. This path
  // is COMPARED (against the resolved lock directory) and not merely opened, so
  // a native `path.join` result would not match the forward-slash form the
  // directory resolver returns — green on POSIX, red on win32.
  return toPosix(path.join(dir, `${name}-${key}${ext}`));
}

/**
 * Read the recorded expected install identity, or `undefined` when no lock has
 * been written yet (first run / bootstrap) or when the lock is corrupt (a
 * corrupt lock is treated as "no lock" so a re-record can heal it rather than
 * wedging the gate).
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

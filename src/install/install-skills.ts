/**
 * `installSkills()` is the programmatic entry point for `exarchos install-skills`.
 * It resolves the runtime map for the target agent, or detects the agent.
 * Then it copies the rendered skills from a local source tree, or it runs
 * `npx skills add github:lvlup-sw/exarchos --skill '*' --agent <id> -y -g --copy`.
 *
 * The upstream `skills` CLI selects skills and agents with `@clack/prompts`.
 * Without `--yes` and explicit `--skill` and `--agent` flags, a closed stdin gives
 * "no selection", and the command exits 0 with no files written.
 *
 * For the `claude` runtime, `installSkills()` also merges `mcpServers.exarchos` into `~/.claude.json`.
 * All side effects are injected, so unit tests do not touch the host system.
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeMap } from './runtimes/types.js';
import { detectRuntime, AmbiguousRuntimeError, type DetectDeps } from './runtimes/detect.js';
import {
  AMBIGUOUS_INTERACTIVE_QUESTION,
  ambiguousNonInteractiveNoticeMessage,
  ambiguousNonInteractiveThrowMessage,
  childExitErrorMessage,
  childExitRetryHeader,
  missingGenericFallbackMessage,
  noAgentDetectedFallbackMessage,
  unknownRuntimeMessage,
} from './install-skills-messages.js';
import { atomicWriteFile } from '../utils/atomic-write.js';

/**
 * Result of the injected spawn function: the exit code, and stderr to show
 * as it is on failure.
 */
export interface SpawnResult {
  code: number;
  stderr: string;
}

/** Injectable spawn signature. The default wraps `child_process.spawn`. Tests inject a fake. */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: SpawnOptions,
) => Promise<SpawnResult>;

/**
 * Options and dependencies of `installSkills`. Each side effect is optional,
 * so tests can inject fakes and other callers get the real defaults.
 */
export interface InstallSkillsOpts {
  /** Target agent name. If absent, the runtime is auto-detected. */
  agent?: string;
  /** The set of known runtime maps (normally produced by `loadAllRuntimes`). */
  runtimes?: RuntimeMap[];
  /** Injected spawn. The default wraps `child_process.spawn`. */
  spawn?: SpawnFn;
  /** Where informational output goes. Default: `console.log`. */
  log?: (msg: string) => void;
  /** Where error output goes. Default: `console.error`. */
  errLog?: (msg: string) => void;
  /** Used for tilde expansion in `skillsInstallPath`. Default: `os.homedir`. */
  homeDir?: () => string;
  /**
   * Detection dependencies for `detectRuntime()` when `agent` is unset.
   * The default reads the real PATH and `process.env`.
   */
  detectDeps?: DetectDeps;
  /**
   * Whether the user can respond to prompts. Defaults to
   * `process.stdout.isTTY && !process.env.NON_INTERACTIVE`. In non-interactive
   * mode, an ambiguous detection throws an error with a remediation hint.
   */
  isInteractive?: boolean;
  /**
   * Prompt the user to choose one candidate when auto-detection finds more than
   * one runtime. The default wraps `@inquirer/prompts.select`.
   */
  prompt?: (question: string, choices: string[]) => Promise<string>;
  /**
   * Register the Exarchos MCP server in `~/.claude.json`, for the `claude` runtime only.
   * The default is `registerExarchosInClaudeJson`, which writes the real file.
   */
  registerMcp?: (home: string) => void;
  /**
   * Path to the rendered skills tree, with `standard/` and `<runtime>/` subtrees.
   * When it gives a non-empty skill set for the runtime, `installSkills()` copies
   * the skills from local disk and does not run `npx skills add`. The upstream CLI installs only the
   * repo root level, and its home-dir mapping does not match `skillsInstallPath`.
   *
   * `installSkills()` does not detect this path. A detection from the repo root finds
   * `rendered/skills`, and then the tests of the spawn argv skip the spawn.
   * The install-skills bridge passes `findSkillsSourceDir()`. Without it, the `npx skills add` path runs.
   */
  skillsSource?: string;
  /**
   * Recursive directory copy for the local-copy path (see `skillsSource`).
   * The default wraps `fs.cpSync(src, dest, { recursive: true })`.
   */
  copyDir?: (src: string, dest: string) => void;
  /**
   * Path to the command-alias tree with `<runtime>/<canonical>.md` files, emitted by
   * `build-command-aliases.ts`. When the runtime declares `commandsInstallPath` and
   * `<aliasesSource>/<runtime.name>/` exists, the alias files go to that path.
   * The copy runs after either skills transport, and no runtime name is hard-coded.
   * `installSkills()` does not detect this path. The bridge passes `findCommandAliasesSourceDir()`.
   */
  aliasesSource?: string;
  /**
   * Single-file copy for the command-alias install (see `aliasesSource`).
   * The default wraps `fs.copyFileSync(src, dest)`.
   */
  copyFile?: (src: string, dest: string) => void;
  /**
   * Host platform. It selects symlinks (POSIX) or file copies (`win32`) for the
   * canonical layout, and the case-insensitivity default. Defaults to `process.platform`.
   * Tests set it to run the win32 copy branch on a non-Windows runner.
   */
  platform?: NodeJS.Platform;
  /**
   * Directory symlink for the canonical layout on POSIX. The default wraps
   * `fs.symlinkSync(target, linkPath)`. It is never called on `win32`, which copies.
   */
  symlink?: (target: string, linkPath: string) => void;
  /**
   * Scope for the canonical `.agents/skills` path and the provenance manifest.
   * `user` (default) gives `~/.agents/skills`. `project` gives `<projectRoot>/.agents/skills`.
   * The native dir of each harness (`runtime.skillsInstallPath`) does not depend on the scope.
   */
  scope?: SkillsInstallScope;
  /**
   * Project root for `scope: 'project'` canonical/manifest paths. Defaults to
   * `process.cwd()`. Ignored for `scope: 'user'`.
   */
  projectRoot?: string;
  /**
   * Exarchos version for the provenance manifest. Defaults to the root
   * `package.json` `version`, or `'unknown'` when that file cannot be read.
   */
  version?: string;
  /**
   * Override case-insensitive-filesystem detection for manifest directory-name
   * key folding. Defaults to a platform heuristic (see {@link defaultCaseInsensitiveFs}).
   */
  caseInsensitiveFs?: boolean;
}

/** Error with the non-zero exit code of the child process, so the CLI can exit with it. */
export interface InstallSkillsError extends Error {
  exitCode?: number;
}

/**
 * Expand a leading `~` or `$HOME` in `p` to `home`. A path without a marker is
 * returned unchanged. The `$HOME` form matters because the in-process copy has no
 * shell to expand it, and `content/harness/runtimes/codex.yaml` uses it.
 */
export function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (p === '$HOME') return home;
  if (p.startsWith('$HOME/')) return path.join(home, p.slice('$HOME/'.length));
  return p;
}

/**
 * Find the local rendered skills tree. The candidates, in order:
 *   1. `<cwd>/rendered/skills`, for a run from the repo root.
 *   2. `<dirname(process.execPath)>/../../rendered/skills`, for a binary at `<repo>/dist/bin/`.
 *   3. `rendered/skills` two levels above this module, for a run from `src/`.
 * Return the first candidate that is a directory, or `undefined`.
 */
export function findSkillsSourceDir(): string | undefined {
  const candidates: string[] = [];

  candidates.push(path.join(process.cwd(), 'rendered', 'skills'));

  try {
    if (typeof process.execPath === 'string' && process.execPath.length > 0) {
      candidates.push(
        path.resolve(path.dirname(process.execPath), '..', '..', 'rendered', 'skills'),
      );
    }
  } catch {
  }

  try {
    if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.resolve(here, '../../rendered/skills'));
    }
  } catch {
  }

  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isDirectory()) return c;
    } catch {
    }
  }
  return undefined;
}

/** Default recursive copy with `fs.cpSync`. Errors go to the caller. */
function defaultCopyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * Copy each skill directory under `sourceDir` (a directory with a `SKILL.md`)
 * into `destDir`, and return the copied names.
 * Each skill directory is removed from `destDir` before the copy, so no stale files stay.
 * Other content of `destDir` stays, because the user can keep other skills there.
 */
export function copyLocalSkills(
  sourceDir: string,
  destDir: string,
  copyDir: (src: string, dest: string) => void = defaultCopyDir,
): string[] {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  const skillDirs = entries
    .filter((e) => e.isDirectory())
    .filter((e) => {
      try {
        return fs.statSync(path.join(sourceDir, e.name, 'SKILL.md')).isFile();
      } catch {
        return false;
      }
    })
    .map((e) => e.name);

  fs.mkdirSync(destDir, { recursive: true });

  for (const skill of skillDirs) {
    const src = path.join(sourceDir, skill);
    const dest = path.join(destDir, skill);
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(src, dest);
  }

  return skillDirs;
}

/** Default single-file copy with `fs.copyFileSync`. */
function defaultCopyFile(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
}

/**
 * Copy each top-level `*.md` alias file in `sourceDir` into `destDir`, and return
 * the copied names. The alias tree is flat. A copy overwrites a file of the same
 * name. Other files in `destDir` stay.
 */
export function copyCommandAliases(
  sourceDir: string,
  destDir: string,
  copyFile: (src: string, dest: string) => void = defaultCopyFile,
): string[] {
  const aliasFiles = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name);

  if (aliasFiles.length === 0) return [];

  fs.mkdirSync(destDir, { recursive: true });
  for (const file of aliasFiles) {
    copyFile(path.join(sourceDir, file), path.join(destDir, file));
  }
  return aliasFiles;
}

/**
 * True for the errors that a path probe can ignore: `ENOENT` and `ENOTDIR`.
 * Other errors, such as `EACCES` or `EIO`, are real faults and must surface.
 */
function isIgnorablePathProbeError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Find the local command-alias tree. The candidates are in the same order as
 * {@link findSkillsSourceDir}, under `rendered/command-aliases`.
 * Return the first candidate that is a directory, or `undefined`.
 */
export function findCommandAliasesSourceDir(): string | undefined {
  const candidates: string[] = [];
  candidates.push(path.join(process.cwd(), 'rendered', 'command-aliases'));
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    candidates.push(
      path.resolve(path.dirname(process.execPath), '..', '..', 'rendered', 'command-aliases'),
    );
  }
  try {
    if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.resolve(here, '../../rendered/command-aliases'));
    }
  } catch (err) {
    if (!isIgnorablePathProbeError(err)) throw err;
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch (err) {
      if (!isIgnorablePathProbeError(err)) throw err;
    }
  }
  return undefined;
}

/**
 * Install the command aliases for `runtime`. The copy needs `commandsInstallPath`
 * on the runtime, `opts.aliasesSource`, and a `<aliasesSource>/<runtime.name>/` directory.
 * No runtime name is hard-coded. A missing alias directory is normal. Other I/O errors throw.
 * Return the expanded destination when files were copied, or `undefined`.
 */
function installCommandAliases(
  runtime: RuntimeMap,
  opts: InstallSkillsOpts,
  home: string,
  log: (msg: string) => void,
): string | undefined {
  const aliasesSource = opts.aliasesSource;
  if (!aliasesSource || !runtime.commandsInstallPath) return undefined;

  const runtimeAliasDir = path.join(aliasesSource, runtime.name);
  let sourceIsViable = false;
  try {
    sourceIsViable = fs.statSync(runtimeAliasDir).isDirectory();
  } catch (err) {
    if (!isIgnorablePathProbeError(err)) throw err;
    sourceIsViable = false;
  }
  if (!sourceIsViable) return undefined;

  const destDir = expandTilde(runtime.commandsInstallPath, home);
  const copyFile = opts.copyFile ?? defaultCopyFile;
  const copied = copyCommandAliases(runtimeAliasDir, destDir, copyFile);
  if (copied.length === 0) return undefined;

  log(
    `Installed ${copied.length} command alias${copied.length === 1 ? '' : 'es'} → ${destDir}`,
  );
  return destDir;
}

/**
 * Print the post-install summary through `log`: the skills destination, the commands
 * destination when aliases were installed, and a restart hint.
 */
function printInstallSummary(
  log: (msg: string) => void,
  skillsDest: string,
  commandsDest: string | undefined,
  runtimeName: string,
): void {
  log('');
  log('Install complete.');
  log(`  Skills:   ${skillsDest}`);
  if (commandsDest) {
    log(`  Commands: ${commandsDest}`);
  }
  log(`Restart ${runtimeName} (or reload) to pick up new skills/commands.`);
}

/**
 * Default spawn: wraps `child_process.spawn` as a `SpawnFn`. It captures stderr
 * for the failure message and also writes it live to the real stderr.
 */
const defaultSpawn: SpawnFn = (cmd, args, opts) => {
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { stdio: ['inherit', 'inherit', 'pipe'], ...opts });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      process.stderr.write(chunk);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code: code ?? 0, stderr }));
  });
};

/** Find a runtime by name, or return `undefined`. The caller decides what to do on a miss. */
function findRuntime(runtimes: RuntimeMap[], name: string): RuntimeMap | undefined {
  return runtimes.find((r) => r.name === name);
}

/**
 * Map an Exarchos runtime name to the agent id of the upstream `skills` CLI:
 * `claude` to `claude-code`, `copilot` to `github-copilot`, and `generic` to `universal`.
 * Other names pass through unchanged.
 */
export function mapRuntimeToSkillsCliAgent(runtimeName: string): string {
  switch (runtimeName) {
    case 'claude':
      return 'claude-code';
    case 'copilot':
      return 'github-copilot';
    case 'generic':
      return 'universal';
    default:
      return runtimeName;
  }
}

/**
 * Install scope for the canonical skill layout and its provenance manifest.
 * The canonical skill set goes to the cross-client `.agents/skills` path and to
 * the native dir of the harness. A provenance manifest for each scope records both.
 */
export type SkillsInstallScope = 'user' | 'project';

/** Which placement a manifest record describes. */
export type SkillPlacementKind = 'canonical' | 'native';

/** Filename of the per-scope provenance manifest, at the `.agents/` root. */
export const SKILLS_MANIFEST_FILENAME = '.exarchos-skills.json';

/** Schema tag in each manifest, so a reader can check the version. */
export const SKILLS_MANIFEST_SCHEMA = 'exarchos-skills-provenance/v1';

/**
 * One placed skill tree for one harness. `path` is the POSIX-normalized destination
 * directory. `hashes` maps each skill name to the newline-normalized digest of the
 * source content at install time. {@link detectLayoutDrift} compares the copy on disk with it.
 */
export interface SkillPlacementRecord {
  harness: string;
  kind: SkillPlacementKind;
  path: string;
  hashes: Record<string, string>;
}

/**
 * The provenance manifest for one scope. On a case-insensitive filesystem, placement
 * paths and skill names are folded to lowercase for the merge (see {@link foldDirKey}).
 * A re-install that differs only in path case thus updates the record and adds no duplicate.
 */
export interface SkillsProvenanceManifest {
  schema: string;
  version: string;
  scope: SkillsInstallScope;
  generatedAt: string;
  skills: string[];
  placements: SkillPlacementRecord[];
}

/** POSIX-normalize a path (backslashes → forward slashes) for stable manifest keys. */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Normalize CRLF to LF before hashing, so a Windows checkout and a POSIX
 * checkout give the same hash.
 */
function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * Whether to fold directory-name keys to lowercase for the manifest merge.
 * The heuristic is `true` for `win32` and `darwin`. `opts.caseInsensitiveFs` overrides it.
 */
export function defaultCaseInsensitiveFs(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Fold a directory-name key for case-insensitive comparison when applicable. */
function foldDirKey(name: string, caseInsensitive: boolean): string {
  const posix = toPosixPath(name);
  return caseInsensitive ? posix.toLowerCase() : posix;
}

/** Default directory symlink: wraps `fs.symlinkSync`. Never called on `win32`. */
function defaultSymlink(target: string, linkPath: string): void {
  fs.symlinkSync(target, linkPath);
}

/**
 * List the skill directory names directly under `parentDir`. A directory is a skill
 * when it contains a top-level `SKILL.md`. An unreadable `parentDir` gives `[]`.
 */
function listSkillDirs(parentDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => {
      try {
        return fs.statSync(path.join(parentDir, e.name, 'SKILL.md')).isFile();
      } catch {
        return false;
      }
    })
    .map((e) => e.name);
}

/**
 * The canonical skill set for `runtimeName`: the procedural skills in
 * `<skillsSource>/standard/` and the orchestration skills in `<skillsSource>/<runtimeName>/`.
 * On a name collision, the procedural skill stays. Each item gives the source `dir`.
 */
export function collectCanonicalSkillSet(
  skillsSource: string,
  runtimeName: string,
  caseInsensitive = false,
): Array<{ name: string; dir: string }> {
  const set: Array<{ name: string; dir: string }> = [];
  const seen = new Set<string>();
  const add = (parent: string, name: string): void => {
    const key = foldDirKey(name, caseInsensitive);
    if (seen.has(key)) return;
    seen.add(key);
    set.push({ name, dir: path.join(parent, name) });
  };
  const standardDir = path.join(skillsSource, 'standard');
  for (const name of listSkillDirs(standardDir)) add(standardDir, name);
  const runtimeDir = path.join(skillsSource, runtimeName);
  for (const name of listSkillDirs(runtimeDir)) add(runtimeDir, name);
  return set;
}

/** Resolve the canonical `.agents/skills` convention directory for a scope. */
function resolveCanonicalSkillsDir(
  scope: SkillsInstallScope,
  home: string,
  projectRoot: string,
): string {
  return scope === 'user'
    ? expandTilde('~/.agents/skills', home)
    : path.join(projectRoot, '.agents', 'skills');
}

/** Resolve the per-scope provenance manifest path (`<.agents-root>/.exarchos-skills.json`). */
export function resolveSkillsManifestPath(
  scope: SkillsInstallScope,
  home: string,
  projectRoot: string,
): string {
  const agentsRoot =
    scope === 'user' ? expandTilde('~/.agents', home) : path.join(projectRoot, '.agents');
  return path.join(agentsRoot, SKILLS_MANIFEST_FILENAME);
}

/**
 * Hash the content of a skill directory: one digest over each file, sorted by relative
 * path and newline-normalized. It follows symlinks, so a canonical symlink and its
 * native copy give the same hash. It throws when `skillDir` is absent.
 */
export function hashSkillDirContent(skillDir: string): string {
  const rels: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, childRel);
      else if (st.isFile()) rels.push(childRel);
    }
  };
  walk(skillDir, '');
  rels.sort();
  const h = createHash('sha256');
  for (const rel of rels) {
    const content = fs.readFileSync(path.join(skillDir, rel)).toString('utf8');
    h.update(rel);
    h.update('\0');
    h.update(normalizeNewlines(content));
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Copy each skill in `set` into `destDir`, and replace a prior copy.
 * The native dir always gets a real copy, because the harness loads it.
 * The canonical dir gets a copy on `win32`.
 */
function copySkillSetToDir(
  set: Array<{ name: string; dir: string }>,
  destDir: string,
  copyDir: (src: string, dest: string) => void,
): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const s of set) {
    const dest = path.join(destDir, s.name);
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(s.dir, dest);
  }
}

/**
 * Place the canonical `.agents/skills` entries. On POSIX, each entry is a symlink to
 * the native copy. On `win32`, each entry is a copy from the source, because Windows
 * symlinks need elevated privileges or Developer Mode.
 * When the canonical dir is the native dir, as for `generic`, the function does nothing.
 */
function placeCanonicalSkillSet(
  set: Array<{ name: string; dir: string }>,
  canonicalDir: string,
  nativeDir: string,
  platform: NodeJS.Platform,
  copyDir: (src: string, dest: string) => void,
  symlink: (target: string, linkPath: string) => void,
): void {
  if (toPosixPath(path.resolve(canonicalDir)) === toPosixPath(path.resolve(nativeDir))) {
    return;
  }
  if (platform === 'win32') {
    copySkillSetToDir(set, canonicalDir, copyDir);
    return;
  }
  fs.mkdirSync(canonicalDir, { recursive: true });
  for (const s of set) {
    const link = path.join(canonicalDir, s.name);
    const target = path.join(nativeDir, s.name);
    fs.rmSync(link, { recursive: true, force: true });
    symlink(target, link);
  }
}

/** Build the provenance record for one placement. The hashes come from the source. */
function buildPlacementRecord(
  harness: string,
  kind: SkillPlacementKind,
  dirPath: string,
  set: Array<{ name: string; dir: string }>,
): SkillPlacementRecord {
  const hashes: Record<string, string> = {};
  for (const s of set) hashes[s.name] = hashSkillDirContent(s.dir);
  return { harness, kind, path: toPosixPath(dirPath), hashes };
}

/** Write JSON atomically: a unique temp file in the target dir, then a rename over the target. */
function atomicWriteJson(target: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  atomicWriteFile(target, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Type guard for a parsed value with the shape of a provenance manifest. */
function isProvenanceManifest(v: unknown): v is SkillsProvenanceManifest {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return Array.isArray(m.placements) && Array.isArray(m.skills);
}

/**
 * Read, merge and atomically write the provenance manifest of a scope.
 * The new placements replace a prior record with the same folded path.
 * Records with other paths stay. A missing or malformed manifest starts empty.
 * Skill names are merged, deduplicated by folded name, and sorted.
 */
export function writeSkillsProvenanceManifest(args: {
  scope: SkillsInstallScope;
  manifestPath: string;
  harness: string;
  canonicalDir: string;
  nativeDir: string;
  set: Array<{ name: string; dir: string }>;
  version: string;
  caseInsensitive: boolean;
}): void {
  const { scope, manifestPath, harness, canonicalDir, nativeDir, set, version, caseInsensitive } =
    args;

  let existing: SkillsProvenanceManifest | undefined;
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
  }
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isProvenanceManifest(parsed)) existing = parsed;
    } catch {
    }
  }

  const newPlacements: SkillPlacementRecord[] = [
    buildPlacementRecord(harness, 'canonical', canonicalDir, set),
  ];
  if (toPosixPath(path.resolve(nativeDir)) !== toPosixPath(path.resolve(canonicalDir))) {
    newPlacements.push(buildPlacementRecord(harness, 'native', nativeDir, set));
  }

  const newKeys = new Set(newPlacements.map((p) => foldDirKey(p.path, caseInsensitive)));
  const kept = (existing?.placements ?? []).filter(
    (p) => !newKeys.has(foldDirKey(p.path, caseInsensitive)),
  );

  const skills: string[] = [];
  const skillSeen = new Set<string>();
  for (const name of [...(existing?.skills ?? []), ...set.map((s) => s.name)]) {
    const key = foldDirKey(name, caseInsensitive);
    if (skillSeen.has(key)) continue;
    skillSeen.add(key);
    skills.push(name);
  }
  skills.sort();

  const manifest: SkillsProvenanceManifest = {
    schema: SKILLS_MANIFEST_SCHEMA,
    version,
    scope,
    generatedAt: new Date().toISOString(),
    skills,
    placements: [...kept, ...newPlacements],
  };
  atomicWriteJson(manifestPath, manifest);
}

/** A single layout-drift finding produced by {@link detectLayoutDrift}. */
export interface LayoutDriftFinding {
  scope: SkillsInstallScope;
  harness: string;
  kind: SkillPlacementKind;
  placementPath: string;
  skill: string;
  drift: 'missing' | 'modified';
  detail: string;
}

/**
 * Read-only layout-drift detector. It hashes each recorded placement again and
 * compares the result with the recorded hash. A skill dir that cannot be
 * hashed gives `missing`. A hash mismatch gives `modified`. A missing or malformed manifest gives `[]`.
 */
export function detectLayoutDrift(
  opts: {
    scope?: SkillsInstallScope;
    home?: string;
    projectRoot?: string;
  } = {},
): LayoutDriftFinding[] {
  const scope = opts.scope ?? 'user';
  const home = opts.home ?? homedir();
  const projectRoot = opts.projectRoot ?? process.cwd();
  const manifestPath = resolveSkillsManifestPath(scope, home, projectRoot);

  let manifest: SkillsProvenanceManifest;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!isProvenanceManifest(parsed)) return [];
    manifest = parsed;
  } catch {
    return [];
  }

  const findings: LayoutDriftFinding[] = [];
  for (const placement of manifest.placements) {
    for (const [skill, recordedHash] of Object.entries(placement.hashes)) {
      const skillDir = path.join(placement.path, skill);
      let actual: string | undefined;
      try {
        actual = hashSkillDirContent(skillDir);
      } catch {
        actual = undefined;
      }
      if (actual === undefined) {
        findings.push({
          scope,
          harness: placement.harness,
          kind: placement.kind,
          placementPath: placement.path,
          skill,
          drift: 'missing',
          detail: `skill "${skill}" is absent at ${placement.path}`,
        });
      } else if (actual !== recordedHash) {
        findings.push({
          scope,
          harness: placement.harness,
          kind: placement.kind,
          placementPath: placement.path,
          skill,
          drift: 'modified',
          detail: `content hash mismatch for skill "${skill}" at ${placement.path}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Filename of the committed legacy-render hash manifest under `tools/migrations/`.
 * Its entries are the newline-normalized SHA-256 of each per-runtime `SKILL.md` render
 * across past releases. The onboard rename migration deletes a stale old-name skill dir
 * only when this manifest or the install provenance manifest proves that Exarchos placed it.
 */
export const LEGACY_HASH_MANIFEST_FILENAME = 'legacy-skill-render-hashes.json';

/** One past per-runtime render hash in the legacy-render manifest. */
export interface LegacySkillRenderEntry {
  release: string;
  runtime: string;
  skill: string;
  path: string;
  hash: string;
}

/** The committed legacy-render hash manifest, in its on-disk shape. */
export interface LegacySkillRenderManifest {
  algorithm: string;
  normalization: string;
  scope: string;
  source: string;
  minRelease: string;
  releases: string[];
  entries: LegacySkillRenderEntry[];
}

/**
 * Newline-normalized SHA-256 hex of one `SKILL.md` render. It must give the same result
 * as `normalizeAndHash` in `tools/release/generate-legacy-skill-hashes.mjs`, so a file
 * that differs only in line endings still matches the manifest.
 */
export function hashSkillMdContent(content: string): string {
  return createHash('sha256').update(normalizeNewlines(content), 'utf8').digest('hex');
}

/**
 * Hash the `SKILL.md` in `skillDir` for legacy-render provenance. It follows symlinks.
 * Return `undefined` when the file cannot be read.
 */
export function hashSkillMdFile(
  skillDir: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): string | undefined {
  try {
    return hashSkillMdContent(readFile(path.join(skillDir, 'SKILL.md')));
  } catch {
    return undefined;
  }
}

/** Type guard for a parsed value with the shape of the legacy-render manifest. */
export function isLegacySkillRenderManifest(v: unknown): v is LegacySkillRenderManifest {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return Array.isArray(m.entries) && Array.isArray(m.releases);
}

/**
 * Index the legacy-render manifest by skill name. Each skill maps to the set of its
 * render hashes across all runtimes and releases. A stale old-name dir matches when
 * the hash of its `SKILL.md` is in the set of its skill.
 */
export function indexLegacyHashesBySkill(
  manifest: LegacySkillRenderManifest,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const entry of manifest.entries) {
    let set = index.get(entry.skill);
    if (!set) {
      set = new Set<string>();
      index.set(entry.skill, set);
    }
    set.add(entry.hash);
  }
  return index;
}

/**
 * Find the committed legacy-render hash manifest under `tools/migrations/`, from the cwd,
 * from two levels above the binary, or from one level above this module.
 * Return the first file found, or `undefined`. When the result is `undefined`, the
 * migration has no legacy provenance, and it keeps the directories.
 */
export function findLegacyHashManifestPath(): string | undefined {
  const candidates: string[] = [
    path.join(process.cwd(), 'tools', 'migrations', LEGACY_HASH_MANIFEST_FILENAME),
  ];
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    candidates.push(
      path.resolve(
        path.dirname(process.execPath),
        '..',
        '..',
        'tools',
        'migrations',
        LEGACY_HASH_MANIFEST_FILENAME,
      ),
    );
  }
  try {
    if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.resolve(here, '..', 'tools', 'migrations', LEGACY_HASH_MANIFEST_FILENAME));
    }
  } catch (err) {
    if (!isIgnorablePathProbeError(err)) throw err;
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch (err) {
      if (!isIgnorablePathProbeError(err)) throw err;
    }
  }
  return undefined;
}

/**
 * Load the legacy-render hash manifest and return its index by skill.
 * The path defaults to {@link findLegacyHashManifestPath}.
 * Return `undefined` when the manifest is absent or does not parse.
 */
export function loadLegacyHashIndex(
  opts: {
    manifestPath?: string;
    readFile?: (p: string) => string;
  } = {},
): Map<string, Set<string>> | undefined {
  const manifestPath = opts.manifestPath ?? findLegacyHashManifestPath();
  if (manifestPath === undefined) return undefined;
  const readFile = opts.readFile ?? ((p: string) => fs.readFileSync(p, 'utf8'));
  try {
    const parsed: unknown = JSON.parse(readFile(manifestPath));
    if (!isLegacySkillRenderManifest(parsed)) return undefined;
    return indexLegacyHashesBySkill(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Return `true` when a placement in `manifests` records `dirHash` for `skillName`.
 * A match proves that the dir on disk is an unchanged copy of what Exarchos placed.
 * When `caseInsensitive` is set, skill names compare in lowercase.
 */
export function installManifestVouchesForDir(
  manifests: readonly SkillsProvenanceManifest[],
  skillName: string,
  dirHash: string,
  caseInsensitive = false,
): boolean {
  const wanted = caseInsensitive ? skillName.toLowerCase() : skillName;
  for (const manifest of manifests) {
    for (const placement of manifest.placements) {
      for (const [recordedSkill, recordedHash] of Object.entries(placement.hashes)) {
        const key = caseInsensitive ? recordedSkill.toLowerCase() : recordedSkill;
        if (key === wanted && recordedHash === dirHash) return true;
      }
    }
  }
  return false;
}

let cachedExarchosVersion: string | undefined;
/**
 * Resolve the Exarchos version for the provenance manifest from the root `package.json`.
 * Return `'unknown'` when the file cannot be read, as in a bundled binary.
 * The result is cached after the first call.
 */
export function readDefaultExarchosVersion(): string {
  if (cachedExarchosVersion !== undefined) return cachedExarchosVersion;
  cachedExarchosVersion = 'unknown';
  try {
    if (import.meta.url.startsWith('file:')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const raw = fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string') cachedExarchosVersion = parsed.version;
    }
  } catch {
  }
  return cachedExarchosVersion;
}

/**
 * Install skills for one agent runtime.
 *
 *   1. Resolve the runtime from `opts.agent`, or detect it. If no runtime is detected,
 *      use `generic`. If detection is ambiguous, prompt, or throw in non-interactive mode.
 *   2. If `opts.skillsSource` has skills for the runtime, copy them to the native dir,
 *      place the canonical layout, and write the provenance manifest.
 *   3. If not, log and spawn `npx skills add` with `FORCE_COLOR=0` and `CI=true`.
 *      `--copy` writes real files, because symlinks into the npm cache break when the cache is cleaned.
 *      A non-zero exit throws an `InstallSkillsError` with `exitCode`.
 *   4. Install the command aliases. For `claude`, register the MCP server. A registration
 *      failure is logged and does not fail the install. Then print the summary.
 */
export async function installSkills(opts: InstallSkillsOpts): Promise<void> {
  const runtimes = opts.runtimes ?? [];
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const errLog = opts.errLog ?? ((msg: string) => console.error(msg));
  const spawn = opts.spawn ?? defaultSpawn;
  const homeDirFn = opts.homeDir ?? (() => homedir());
  const registerMcp = opts.registerMcp ?? registerExarchosInClaudeJson;
  const isInteractive =
    opts.isInteractive ??
    (Boolean(process.stdout.isTTY) && !process.env.NON_INTERACTIVE);

  let runtime: RuntimeMap | undefined;
  if (opts.agent !== undefined) {
    runtime = findRuntime(runtimes, opts.agent);
    if (!runtime) {
      throw new Error(
        unknownRuntimeMessage(opts.agent, runtimes.map((r) => r.name)),
      );
    }
  } else {
    try {
      const detected = detectRuntime(runtimes, opts.detectDeps);
      if (detected) {
        runtime = detected;
      } else {
        runtime = findRuntime(runtimes, 'generic');
        if (!runtime) {
          throw new Error(missingGenericFallbackMessage());
        }
        log(noAgentDetectedFallbackMessage(runtime.name));
      }
    } catch (err) {
      if (err instanceof AmbiguousRuntimeError) {
        if (isInteractive) {
          const chooser = opts.prompt ?? defaultPrompt;
          const choice = await chooser(
            AMBIGUOUS_INTERACTIVE_QUESTION,
            err.candidates,
          );
          const picked = findRuntime(runtimes, choice);
          if (!picked) {
            throw new Error(
              `Ambiguous runtime prompt returned unknown name "${choice}".`,
            );
          }
          runtime = picked;
        } else {
          errLog(ambiguousNonInteractiveNoticeMessage(err.candidates));
          throw new Error(ambiguousNonInteractiveThrowMessage(err.candidates));
        }
      } else {
        throw err;
      }
    }
  }

  const skillsSource = opts.skillsSource;
  if (skillsSource) {
    const platform = opts.platform ?? process.platform;
    const caseInsensitive =
      opts.caseInsensitiveFs ?? defaultCaseInsensitiveFs(platform);
    const set = collectCanonicalSkillSet(skillsSource, runtime.name, caseInsensitive);
    if (set.length > 0) {
      const home = homeDirFn();
      const scope = opts.scope ?? 'user';
      const projectRoot = opts.projectRoot ?? process.cwd();
      const version = opts.version ?? readDefaultExarchosVersion();
      const copyDir = opts.copyDir ?? defaultCopyDir;
      const symlink = opts.symlink ?? defaultSymlink;

      const nativeDir = expandTilde(runtime.skillsInstallPath, home);
      const canonicalDir = resolveCanonicalSkillsDir(scope, home, projectRoot);

      log(`Installing ${set.length} skill${set.length === 1 ? '' : 's'} → ${nativeDir}`);
      copySkillSetToDir(set, nativeDir, copyDir);
      placeCanonicalSkillSet(set, canonicalDir, nativeDir, platform, copyDir, symlink);
      log(`Installed: ${set.map((s) => s.name).join(', ')}`);

      writeSkillsProvenanceManifest({
        scope,
        manifestPath: resolveSkillsManifestPath(scope, home, projectRoot),
        harness: runtime.name,
        canonicalDir,
        nativeDir,
        set,
        version,
        caseInsensitive,
      });

      const commandsDest = installCommandAliases(runtime, opts, home, log);

      if (runtime.name === 'claude') {
        try {
          registerMcp(home);
        } catch (err) {
          errLog(
            `install-skills: skills installed, but failed to register MCP server in ~/.claude.json: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      printInstallSummary(log, nativeDir, commandsDest, runtime.name);
      return;
    }
  }

  const home = homeDirFn();
  const skillsDest = expandTilde(runtime.skillsInstallPath, home);

  const skillsAgentId = mapRuntimeToSkillsCliAgent(runtime.name);
  const cmd = 'npx';
  const args = [
    '--yes',
    'skills',
    'add',
    'github:lvlup-sw/exarchos',
    '--skill',
    '*',
    '--agent',
    skillsAgentId,
    '-y',
    '-g',
    '--copy',
  ];
  const commandString = `${cmd} ${args.join(' ')}`;

  log(`Running: ${commandString}`);

  const result = await spawn(cmd, args, {
    env: { ...process.env, FORCE_COLOR: '0', CI: 'true' },
  });
  if (result.code !== 0) {
    if (result.stderr) errLog(result.stderr);
    errLog(childExitRetryHeader(result.code));
    errLog(`  ${commandString}`);
    const error: InstallSkillsError = new Error(childExitErrorMessage(result.code));
    error.exitCode = result.code;
    throw error;
  }

  if (runtime.name === 'claude') {
    try {
      registerMcp(home);
    } catch (err) {
      errLog(
        `install-skills: skills installed, but failed to register MCP server in ~/.claude.json: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const commandsDest = installCommandAliases(runtime, opts, home, log);
  printInstallSummary(log, skillsDest, commandsDest, runtime.name);
}

/**
 * Default prompt. It loads `@inquirer/prompts` on first use, so a run that does not
 * prompt does not pay its startup cost.
 */
const defaultPrompt = async (
  question: string,
  choices: string[],
): Promise<string> => {
  const { select } = await import('@inquirer/prompts');
  return select({
    message: question,
    choices: choices.map((c) => ({ name: c, value: c })),
  });
};

/**
 * Merge the `mcpServers.exarchos` entry into `~/.claude.json`. Other MCP servers stay.
 * When the existing entry is the same, the function does not write, so the mtime stays.
 * The entry follows `.claude-plugin/plugin.json`: `command: 'exarchos'`, `args: ['mcp']`,
 * and a `WORKFLOW_STATE_DIR` under the home directory. A missing file starts empty.
 */
export function registerExarchosInClaudeJson(home: string): void {
  const configPath = path.join(home, '.claude.json');
  const workflowStateDir = path.join(home, '.claude', 'workflow-state');

  let config: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  const existingMcp =
    config.mcpServers && typeof config.mcpServers === 'object'
      ? (config.mcpServers as Record<string, unknown>)
      : {};

  const exarchosEntry = {
    type: 'stdio',
    command: 'exarchos',
    args: ['mcp'],
    env: {
      WORKFLOW_STATE_DIR: workflowStateDir,
    },
  };

  const existingEntry = existingMcp.exarchos;
  if (
    existingEntry &&
    JSON.stringify(existingEntry) === JSON.stringify(exarchosEntry)
  ) {
    return;
  }

  const merged = {
    ...config,
    mcpServers: {
      ...existingMcp,
      exarchos: exarchosEntry,
    },
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
}

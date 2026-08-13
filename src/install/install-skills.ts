/**
 * `installSkills()` — programmatic entry point for the `exarchos install-skills`
 * CLI subcommand. Given a target agent name (or auto-detection, added in
 * task 020), resolves the matching runtime map and shells out to
 * `npx skills add github:lvlup-sw/exarchos --skill '*' --agent <id> -y -g --copy`
 * so that an agent's skills directory is populated from the rendered output.
 *
 * Non-interactive correctness (#1217 — v2.9 GA blocker): the upstream
 * `skills` CLI uses `@clack/prompts` for skill/agent selection. Without
 * `--yes` plus explicit `--skill`/`--agent` flags, the prompts return
 * "no selection" when stdin is closed (CI, scripts, automation, the T4.3
 * test harness) and the command exits 0 with zero files written. The
 * earlier argv shape (`skills/<runtime>` positional + `--target <path>`)
 * was also not recognized by upstream — it was silently ignored after the
 * prompt cancellation. Path 1 of the #1217 decision tree: pass the
 * upstream non-interactive flags directly. Tightest fix that gets us
 * back to a working install on the v2.9 GA timeline.
 *
 * MCP registration: after a successful skills install for the `claude`
 * runtime, `installSkills()` also writes (or merges) the
 * `mcpServers.exarchos` entry into `~/.claude.json` so Claude Code
 * discovers the Exarchos MCP server on next launch. Other runtimes
 * register MCP servers through their own config formats and are out of
 * scope for this writer (T4.3 only pins the claude path; future work can
 * generalize when a second runtime's contract is needed).
 *
 * All side effects (spawn, logging, home-dir resolution, MCP registration)
 * are injected so that unit tests can verify behavior without touching the
 * host system. The CLI wiring lives in the binary entry point
 * (src/index.ts).
 *
 * Implements: DR-7 (install-skills CLI), DR-9 (docs surface), DR-10 (error paths).
 *             Fixes #1217 (non-interactive no-op + missing MCP registration).
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

/**
 * Result shape returned by the injected spawn function. We intentionally keep
 * this small: `installSkills` only needs to know whether the child exited
 * cleanly and to surface stderr verbatim on failure (task 021).
 */
export interface SpawnResult {
  code: number;
  stderr: string;
}

/**
 * Injectable spawn signature. The default implementation wraps
 * `child_process.spawn` but tests swap it for a fake that records calls.
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: SpawnOptions,
) => Promise<SpawnResult>;

/**
 * All dependencies of `installSkills`. Every side effect is optional so tests
 * can inject fakes and so callers can run the function with sensible defaults
 * (wrapping `child_process.spawn`, `os.homedir`, `console.log`, etc.).
 */
export interface InstallSkillsOpts {
  /** Target agent name. If absent, task 020 auto-detection kicks in. */
  agent?: string;
  /** The set of known runtime maps (normally produced by `loadAllRuntimes`). */
  runtimes?: RuntimeMap[];
  /** Injected spawn; defaults to a wrapper over `child_process.spawn`. */
  spawn?: SpawnFn;
  /** Where informational output goes. Default: `console.log`. */
  log?: (msg: string) => void;
  /** Where error output goes. Default: `console.error`. */
  errLog?: (msg: string) => void;
  /** Used for tilde expansion in `skillsInstallPath`. Default: `os.homedir`. */
  homeDir?: () => string;
  /**
   * Injected detection dependencies forwarded to `detectRuntime()` when
   * auto-detection runs (i.e. when `agent` is unset). Defaults to real PATH
   * + process.env lookups.
   */
  detectDeps?: DetectDeps;
  /**
   * Whether stdin is a TTY and the user can respond to prompts. Defaults to
   * `process.stdout.isTTY && !process.env.NON_INTERACTIVE`. In
   * non-interactive mode, ambiguous runtime detection becomes a hard error
   * with a remediation hint rather than a prompt.
   */
  isInteractive?: boolean;
  /**
   * Prompt the user to choose from a list of candidate strings. Used for
   * disambiguation when auto-detection finds multiple matching runtimes.
   * Default wraps `@inquirer/prompts.select`.
   */
  prompt?: (question: string, choices: string[]) => Promise<string>;
  /**
   * Register the Exarchos MCP server entry in `~/.claude.json`. Default
   * wraps `registerExarchosInClaudeJson` (real filesystem write). Tests
   * inject a no-op or recorder to avoid touching disk. Only invoked for
   * the `claude` runtime.
   */
  registerMcp?: (home: string) => void;
  /**
   * Optional explicit path to the per-runtime skills source tree (the
   * directory that contains `<runtime>/<skill>/SKILL.md` children — i.e.
   * the repo's `skills/` directory). When provided and the resolved
   * `<skillsSource>/<runtime.name>/` exists, `installSkills()` performs
   * a direct local-disk copy of every skill directory in that subtree
   * to `runtime.skillsInstallPath` and skips the upstream `npx skills
   * add` shell-out entirely. This is the #1355 fix path: the upstream
   * CLI mis-installed for every non-claude runtime because it (a)
   * cloned the repo and walked only the root level (missing the
   * per-runtime trees) and (b) used its own per-agent home-dir mapping
   * (`github-copilot` → `~/.agents/skills`) that does not align with
   * our `content/harness/runtimes/*.yaml` `skillsInstallPath` values. Copying locally
   * sidesteps both bugs.
   *
   * When `undefined`, `installSkills()` does NOT auto-detect — the
   * function falls straight through to the legacy `npx skills add`
   * shell-out path. Auto-detection is strictly the caller's job:
   * `install-skills-bridge.js` invokes the exported `findSkillsSourceDir()`
   * (which checks `<cwd>/skills`, then `<binary-dir>/../../skills`) and
   * passes the result as `opts.skillsSource`. Library-level callers and
   * the existing unit tests that assert on the upstream spawn argv
   * (`src/install-skills.test.ts`) pass no `skillsSource`, so the spawn
   * path stays the default for them and the upstream invocation contract
   * remains under test. To opt into the local-copy fast path, call
   * `findSkillsSourceDir()` yourself and thread the result through here.
   */
  skillsSource?: string;
  /**
   * Injectable recursive directory copy. Default wraps
   * `fs.cpSync(src, dest, { recursive: true })`. Tests inject a
   * recorder so they can assert what was copied without touching disk.
   * Only invoked when the local-copy fast path runs (see `skillsSource`).
   */
  copyDir?: (src: string, dest: string) => void;
  /**
   * Optional explicit path to the per-runtime command-alias source tree
   * (the directory that contains `<runtime>/<canonical>.md` children — i.e.
   * the repo's `command-aliases/` directory, a build artifact emitted by
   * `build-command-aliases.ts`). When provided AND the resolved runtime
   * declares `commandsInstallPath` AND `<aliasesSource>/<runtime.name>/`
   * exists, `installSkills()` copies every alias `*.md` file into the
   * expanded `commandsInstallPath` so the bare canonical names (`/ideate`,
   * `/plan`, ...) autoload off the Claude path (T3, #1471/#1472).
   *
   * The copy runs regardless of which skills-install transport ran (the
   * local-copy fast path or the upstream `npx skills add` shell-out) — it
   * is gated purely on the presence of `commandsInstallPath` + a viable
   * source tree, never a runtime-name literal (INV-4). When `undefined`,
   * `installSkills()` does NOT auto-detect — the bridge supplies
   * `findCommandAliasesSourceDir()` explicitly, mirroring `skillsSource`.
   */
  aliasesSource?: string;
  /**
   * Injectable single-file copy used by the command-alias install. Default
   * wraps `fs.copyFileSync(src, dest)`. Tests inject a recorder so they can
   * assert what was copied without touching disk. Only invoked when the
   * command-alias copy runs (see `aliasesSource`).
   */
  copyFile?: (src: string, dest: string) => void;
  /**
   * Host platform, used only to fork the canonical-layout placement between
   * symlink (POSIX) and file copy (`win32`) — INV-16. Defaults to
   * `process.platform`. Injected by tests to exercise the win32 copy-mode
   * branch on a non-Windows CI runner without a real Windows host (Task 010;
   * the real Windows lane is Task 021).
   */
  platform?: NodeJS.Platform;
  /**
   * Injectable directory symlink used by the canonical-layout placement on
   * POSIX (`fs.symlinkSync(target, linkPath)`). Never invoked on `win32`
   * (INV-16: Windows copies). Tests inject a recorder to assert copy-not-symlink.
   */
  symlink?: (target: string, linkPath: string) => void;
  /**
   * Install scope for the canonical `.agents/skills` convention path + the
   * provenance manifest. `user` (default) → `~/.agents/skills` (global, the
   * `-g` model the runtime maps use); `project` → `<projectRoot>/.agents/skills`
   * (onboard threads this so `doctor` can detect drift per project). The
   * per-harness native dirs (`runtime.skillsInstallPath`) are scope-independent.
   */
  scope?: SkillsInstallScope;
  /**
   * Project root for `scope: 'project'` canonical/manifest paths. Defaults to
   * `process.cwd()`. Ignored for `scope: 'user'`.
   */
  projectRoot?: string;
  /**
   * Exarchos version recorded in the provenance manifest. Defaults to the root
   * `package.json` `version` (the single source of truth; Task 022 bumps it),
   * or `'unknown'` when unreadable. Tests inject a literal for determinism.
   */
  version?: string;
  /**
   * Override case-insensitive-filesystem detection for manifest directory-name
   * key folding. Defaults to a platform heuristic (see {@link defaultCaseInsensitiveFs}).
   */
  caseInsensitiveFs?: boolean;
}

/**
 * Augmented Error type the CLI main() can catch to propagate the child
 * process's non-zero exit code. Using a discriminated property (`exitCode`)
 * avoids defining a new Error subclass for a single field.
 */
export interface InstallSkillsError extends Error {
  exitCode?: number;
}

/**
 * Expand a leading `~` or `$HOME` in a path to the user's home directory.
 * We do not use `os.homedir()` directly so tests can pass a deterministic
 * home. Handles the no-marker case (returns input unchanged), a bare `~`
 * or `$HOME` (returns home), and the `~/...` / `$HOME/...` prefixes. The
 * `$HOME` form is recognized because `content/harness/runtimes/codex.yaml` and any future
 * shell-literal-style entry will not otherwise be expanded by the
 * local-copy fast path (the upstream shell-out used to mask this because
 * its child shell expanded `$HOME` itself, but the in-process copy never
 * sees a shell).
 */
export function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  if (p === '$HOME') return home;
  if (p.startsWith('$HOME/')) return path.join(home, p.slice('$HOME/'.length));
  return p;
}

/**
 * Auto-detect the local skills source directory — the parent of
 * `<runtime>/<skill>/SKILL.md` (i.e. the repo's `skills/` directory).
 *
 * Resolution order:
 *   1. `<process.cwd()>/skills` — the outcome-test invocation path
 *      (vitest runs from REPO_ROOT, so `process.cwd()` equals the
 *      repo root and `skills/` is one level below).
 *   2. `<dirname(process.execPath)>/../../skills` — the compiled-binary
 *      install layout where the executable lives at
 *      `<repo>/dist/bin/exarchos-<os>-<arch>`. Two `..` hops climb from
 *      `dist/bin/` back to the repo root.
 *   3. `<dirname(import.meta.url)>/../skills` — the Node-import dev
 *      path. `src/install-skills.ts` is one directory below the repo
 *      root, so a single `..` resolves to the `skills/` sibling.
 *
 * Returns the first candidate that exists as a directory, or `undefined`
 * when none do. The caller (installSkills) falls back to the legacy
 * upstream shell-out when this returns `undefined`.
 *
 * Implements: #1355 fix — auto-detection seam so the binary's local-copy
 * fast path works in both the test harness and a developer-checkout
 * production install.
 */
export function findSkillsSourceDir(): string | undefined {
  const candidates: string[] = [];

  // Candidate 1: process.cwd()/skills.
  candidates.push(path.join(process.cwd(), 'rendered', 'skills'));

  // Candidate 2: <binary-dir>/../../skills (dist/bin/ layout).
  try {
    if (typeof process.execPath === 'string' && process.execPath.length > 0) {
      candidates.push(
        path.resolve(path.dirname(process.execPath), '..', '..', 'rendered', 'skills'),
      );
    }
  } catch {
    // process.execPath is always defined under Node/Bun, but guard anyway.
  }

  // Candidate 3: <this-file-dir>/../skills (src/ layout under tsx/ts-node).
  try {
    if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.resolve(here, '../../rendered/skills'));
    }
  } catch {
    // import.meta.url may be a non-file: URL inside bun-compile output.
  }

  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isDirectory()) return c;
    } catch {
      // Candidate doesn't exist — try next.
    }
  }
  return undefined;
}

/**
 * Recursively copy `src` to `dest` using `fs.cpSync`. Pulled into a
 * named helper so `installSkills` can default `opts.copyDir` to a
 * stable function reference and tests can inject a recorder. Errors
 * propagate to the caller — the upstream loop decides whether to
 * partial-fail or abort.
 */
function defaultCopyDir(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * Copy every skill directory under `sourceDir` (a directory containing
 * `<skill>/SKILL.md` children) into `destDir`, creating `destDir` if
 * needed. Returns the list of skill directory names that were copied
 * so the caller can log a manifest.
 *
 * Idempotent at the directory-replace level: each skill subdir is
 * removed from `destDir` before re-copy so stale files (left over from
 * a previous install of an older version) are cleaned up. Files outside
 * of a skill subdir under `destDir` are left untouched — we never
 * blow away `destDir` itself in case the user keeps other skills there.
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
    // Remove any prior copy so the install is byte-stable across runs.
    // `force: true` makes ENOENT a no-op; `recursive: true` follows into
    // subdirectories (reference files etc.).
    fs.rmSync(dest, { recursive: true, force: true });
    copyDir(src, dest);
  }

  return skillDirs;
}

/**
 * Default single-file copy: wraps `fs.copyFileSync`. Pulled into a named
 * helper so `installSkills` can default `opts.copyFile` to a stable
 * reference and tests can inject a recorder.
 */
function defaultCopyFile(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
}

/**
 * Copy every `*.md` alias file under `sourceDir` (a directory of flat
 * `<canonical>.md` command-alias files) into `destDir`, creating `destDir`
 * if needed. Returns the list of file names copied so the caller can log a
 * manifest.
 *
 * Only top-level `*.md` files are copied — the alias tree is flat by
 * construction (`build-command-aliases.ts` emits `<runtime>/<name>.md`).
 * Existing files in `destDir` are overwritten (the alias content is a pure
 * function of the canonical command map, so a re-copy is byte-stable); other
 * files the user keeps in their commands dir are left untouched.
 *
 * Used by the T3 command-alias install (#1471/#1472).
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
 * Auto-detect the local command-alias source directory — the parent of
 * `<runtime>/<canonical>.md` (i.e. the repo's `command-aliases/`
 * directory). Mirrors {@link findSkillsSourceDir}'s candidate resolution
 * (cwd, compiled-binary `dist/bin/../..`, src-relative dev path) so the
 * binary's command-alias install works in both the test harness and a
 * developer checkout.
 *
 * Returns the first candidate that exists as a directory, or `undefined`
 * when none do (the caller skips the alias copy). T3, #1471/#1472.
 */
/**
 * True for the only errors a path *probe* is allowed to swallow: the
 * candidate simply isn't there (`ENOENT`) or a path component isn't a
 * directory (`ENOTDIR`). Anything else (`EACCES`, `EIO`, a non-`file:`
 * URL passed to `fileURLToPath`, ...) is a real fault that must surface
 * rather than be silently treated as "candidate missing" — per the repo's
 * no-silent-catches guideline.
 */
function isIgnorablePathProbeError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

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
    // A genuine non-file: URL under bun-compile output is benign; anything
    // else is unexpected and should not be hidden.
    if (!isIgnorablePathProbeError(err)) throw err;
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch (err) {
      if (!isIgnorablePathProbeError(err)) throw err;
      // Candidate doesn't exist — try next.
    }
  }
  return undefined;
}

/**
 * Install canonical command aliases for `runtime`, when applicable, and
 * return the expanded destination path so the caller can include it in the
 * post-install summary.
 *
 * The copy is gated purely on (a) the runtime declaring
 * `commandsInstallPath`, (b) `opts.aliasesSource` being supplied, and (c)
 * `<aliasesSource>/<runtime.name>/` existing as a directory — never a
 * runtime-name literal (INV-4). It runs regardless of which skills-install
 * transport ran, so opencode gets its `/ideate`, `/plan`, ... aliases
 * whether skills came via the local-copy fast path or the upstream shell-out.
 *
 * Returns the expanded commands destination if files were copied, else
 * `undefined`. T3, #1471/#1472.
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
    // No alias subtree for this runtime is expected; surface real I/O faults.
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
 * Print the post-install summary: skills destination, commands destination
 * (when aliases were installed), and a restart hint so the user reloads the
 * runtime to pick up the new content. Kept concise and routed through the
 * injected `log` so tests can assert on it (the #1471 nice-to-have).
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
 * Default spawn wrapper: wires `child_process.spawn` into the `SpawnFn` shape
 * used by `installSkills`. Captures stderr so callers can surface it verbatim
 * on failure (task 021). Not used in unit tests — they inject a fake.
 */
const defaultSpawn: SpawnFn = (cmd, args, opts) => {
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = nodeSpawn(cmd, args, { stdio: ['inherit', 'inherit', 'pipe'], ...opts });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      // Also surface to the real stderr so users see live output.
      process.stderr.write(chunk);
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code: code ?? 0, stderr }));
  });
};

/**
 * Find a runtime by name. Returns `undefined` if the name is not present in
 * the provided array — the caller decides whether to throw or fall back.
 */
function findRuntime(runtimes: RuntimeMap[], name: string): RuntimeMap | undefined {
  return runtimes.find((r) => r.name === name);
}

/**
 * Map our internal runtime name to the upstream `skills` CLI agent
 * identifier. The two namespaces differ — e.g. our `claude` corresponds
 * to upstream `claude-code`, our `copilot` to upstream `github-copilot`,
 * our `generic` to upstream `universal`. Unknown runtime names pass
 * through unchanged so future runtimes work as long as their name
 * matches an upstream agent ID.
 *
 * Implements: #1217 fix (non-interactive install argv).
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

// ─── Canonical layout + provenance manifest (DR-4, DR-8) ─────────────────────
//
// DR-4 aligns installs to the cross-client `.agents/skills/` convention: the
// canonical skill set (procedural skills rendered once to `skills/standard/`
// plus the per-runtime orchestration skills under `skills/<runtime>/`) is
// placed BOTH at the convention path (`~/.agents/skills` user / `.agents/skills`
// project) AND at each harness's native dir (`runtime.skillsInstallPath`). Every
// such install writes/updates a provenance manifest — one per scope — enumerating
// the per-harness placement paths, the installed skill names, the exarchos
// version, and newline-normalized (CRLF→LF) content hashes so `doctor` can flag
// a stale/modified canonical copy read-only.

/** Install scope for the canonical convention path + provenance manifest. */
export type SkillsInstallScope = 'user' | 'project';

/** Which placement a manifest record describes. */
export type SkillPlacementKind = 'canonical' | 'native';

/** Filename of the per-scope provenance manifest, at the `.agents/` root. */
export const SKILLS_MANIFEST_FILENAME = '.exarchos-skills.json';

/** Schema tag stamped into every manifest so future readers can version-gate. */
export const SKILLS_MANIFEST_SCHEMA = 'exarchos-skills-provenance/v1';

/**
 * One placed skill tree for a single harness. `path` is the POSIX-normalized
 * destination directory (containing `<skill>/…` children). `hashes` maps each
 * installed skill name to the newline-normalized content digest of the SOURCE
 * bytes at install time — the provenance baseline `doctor` compares the on-disk
 * copy against.
 */
export interface SkillPlacementRecord {
  harness: string;
  kind: SkillPlacementKind;
  path: string;
  hashes: Record<string, string>;
}

/**
 * The per-scope provenance manifest. Directory-name keys (placement `path`s and
 * skill names) are folded case-insensitively when merging/deduping on a
 * case-insensitive filesystem (macOS/Windows) — see {@link foldDirKey} — so a
 * re-install that differs only in path casing updates the existing record
 * instead of appending a phantom duplicate.
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
 * Normalize CRLF → LF before hashing so a Windows checkout (or a `.gitattributes`
 * autocrlf copy) hashes identically to a POSIX one — the manifest is
 * newline-agnostic by construction (INV-16).
 */
function normalizeNewlines(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * Whether directory-name keys should be folded to lowercase for manifest
 * dedup/merge. Heuristic: `win32` and `darwin` default to case-insensitive
 * filesystems (NTFS / APFS-insensitive). Callers may override via
 * `opts.caseInsensitiveFs` when they know the real filesystem semantics.
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
 * List the skill directory names directly under `parentDir` — a directory is a
 * skill iff it contains a top-level `SKILL.md`. Missing `parentDir` → `[]` (a
 * source tree that lacks `skills/standard/` or `skills/<runtime>/` simply
 * contributes nothing).
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
 * The canonical skill set for `runtimeName`: procedural skills from
 * `<skillsSource>/standard/` unioned with the runtime's orchestration skills
 * from `<skillsSource>/<runtimeName>/`. Deduped by folded name (the two trees
 * are disjoint after the DR-1 collapse; a collision keeps the first — procedural).
 * Returns `{ name, dir }` for each skill so callers can copy/hash the SOURCE.
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
 * Hash a skill directory's content: a stable digest over every file under
 * `skillDir` (sorted by POSIX relative path), each newline-normalized before
 * hashing. Reads THROUGH symlinks (so a canonical entry symlinked at its native
 * copy hashes to the same value). Throws if `skillDir` is absent — callers that
 * probe on-disk placements guard for that (a missing dir is `drift: 'missing'`).
 */
export function hashSkillDirContent(skillDir: string): string {
  const rels: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      // stat (not lstat) so symlinked children resolve to their target kind.
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
 * Copy each skill in `set` into `destDir` (real bytes), replacing any prior copy
 * so the install is byte-stable across runs. Used for the per-harness NATIVE dir
 * (always a real copy — its content is what the harness loads) and for the
 * canonical dir on `win32` (INV-16: Windows copies, never symlinks).
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
 * Place the canonical `.agents/skills` convention copy. On POSIX each entry is a
 * symlink pointing at the harness's real native copy (the cross-client dir
 * dedups to one content source); on `win32` each entry is a full file copy from
 * the SOURCE (INV-16 — Windows symlinks need elevated privileges / Developer
 * Mode and break copy-based distribution). No-ops when the canonical dir IS the
 * native dir (e.g. the `generic` runtime whose native path already is
 * `~/.agents/skills`) — the native copy already satisfies the convention.
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

/** Build the provenance record for one placement — hashes come from the SOURCE. */
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

/** Atomically write JSON: temp file in the target dir, then rename over target. */
function atomicWriteJson(target: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

/** Type guard: does a parsed value look like a provenance manifest we can merge into? */
function isProvenanceManifest(v: unknown): v is SkillsProvenanceManifest {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return Array.isArray(m.placements) && Array.isArray(m.skills);
}

/**
 * Read-modify-write the per-scope provenance manifest, atomically. This install's
 * placements (canonical + native, unless they coincide) replace any prior record
 * for the same folded path; a second harness installing to the same scope merges
 * its placements in rather than clobbering the file. Skill names are unioned
 * (folded dedup, original casing preserved, sorted). INV-16: atomic temp+rename.
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
    // ENOENT → no manifest yet, start fresh.
  }
  if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isProvenanceManifest(parsed)) existing = parsed;
    } catch {
      // Malformed JSON → start fresh.
    }
  }

  const newPlacements: SkillPlacementRecord[] = [
    buildPlacementRecord(harness, 'canonical', canonicalDir, set),
  ];
  // Native == canonical (e.g. `generic`) → one placement suffices.
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
 * Read-only layout-drift detector (the `doctor` DR-4 surface): re-hash every
 * placement recorded in the scope manifest and compare against the recorded
 * provenance hash. A missing skill dir → `missing`; a content-hash mismatch →
 * `modified`. Absent/malformed manifest → `[]` (nothing to check). Performs NO
 * writes — safe to run from `doctor`.
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

// ─── Multi-release legacy-render hash provenance (DR-8, Task 023 consumer) ────
//
// The onboard rename migration (Task 011, DR-3/DR-8) deletes a stale OLD-NAME
// skill dir from a consumer install ONLY when it can prove the dir came from us.
// Two provenance sources establish that (either suffices):
//   (a) the Task 010 install provenance manifest (`.exarchos-skills.json`),
//       whose per-placement `hashes[skill]` are whole-dir digests
//       ({@link hashSkillDirContent}); and
//   (b) the Task 023 multi-release legacy-render hash manifest
//       (`migrations/legacy-skill-render-hashes.json`), whose entries are the
//       newline-normalized (CRLF→LF) sha256 of every per-runtime `SKILL.md`
//       render ACROSS historical release tags — so a pre-existing install of any
//       prior release, even a CRLF checkout, still hash-matches.
//
// These helpers are the single format-consumers for both provenance sources; the
// onboard migration (server package, isolated by the MCP server's tsc
// `rootDir: "./src"`) mirrors the two hashers and is drift-guarded against these
// by a co-located cross-package test.

/** Filename of the committed multi-release legacy-render hash manifest (Task 023). */
export const LEGACY_HASH_MANIFEST_FILENAME = 'legacy-skill-render-hashes.json';

/** One historical per-runtime render hash in the Task 023 manifest. */
export interface LegacySkillRenderEntry {
  release: string;
  runtime: string;
  skill: string;
  path: string;
  hash: string;
}

/** The committed Task 023 legacy-render hash manifest (real on-disk shape). */
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
 * Newline-normalized (CRLF→LF) sha256 hex of a single `SKILL.md` render's
 * content. MUST stay byte-identical to the Task 023 generator's `normalizeAndHash`
 * (`scripts/generate-legacy-skill-hashes.mjs`) so a consumer file that differs
 * only in line endings still hash-matches the manifest — the cross-format
 * equality is pinned by `install-skills.test.ts`.
 */
export function hashSkillMdContent(content: string): string {
  return createHash('sha256').update(normalizeNewlines(content), 'utf8').digest('hex');
}

/**
 * Hash the `SKILL.md` inside `skillDir` for legacy-render provenance. Reads
 * THROUGH symlinks (so a symlinked install hashes to its target's render).
 * Returns `undefined` when the dir carries no `SKILL.md` (not a skill dir).
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

/** Type guard for a parsed value shaped like the Task 023 legacy-render manifest. */
export function isLegacySkillRenderManifest(v: unknown): v is LegacySkillRenderManifest {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return Array.isArray(m.entries) && Array.isArray(m.releases);
}

/**
 * Index a Task 023 manifest by skill name → the set of every historical render
 * hash for that skill (across all runtimes and releases). A stale old-name dir is
 * legacy-provenance-matched when its `SKILL.md` hash is a member of its skill's
 * set, for ANY release — the union is exactly the "matches any release" contract.
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
 * Resolve the committed legacy-render hash manifest on disk. Mirrors
 * {@link findSkillsSourceDir}'s candidate order (cwd, compiled-binary
 * `dist/bin/../..`, src-relative dev path) but rooted at `migrations/`. Returns
 * the first existing candidate, or `undefined` when none exist (the migration
 * then simply has no legacy provenance to match against — the conservative
 * PRESERVE default, never a spurious deletion).
 */
export function findLegacyHashManifestPath(): string | undefined {
  const candidates: string[] = [
    path.join(process.cwd(), 'migrations', LEGACY_HASH_MANIFEST_FILENAME),
  ];
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    candidates.push(
      path.resolve(
        path.dirname(process.execPath),
        '..',
        '..',
        'migrations',
        LEGACY_HASH_MANIFEST_FILENAME,
      ),
    );
  }
  try {
    if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.resolve(here, '..', 'migrations', LEGACY_HASH_MANIFEST_FILENAME));
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
 * Load + index the legacy-render hash manifest for provenance matching. Resolves
 * the manifest path via {@link findLegacyHashManifestPath} (overridable), parses
 * it, and returns the by-skill hash index. Returns `undefined` when the manifest
 * is absent or unparseable — provenance (b) is then simply unavailable (PRESERVE).
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
 * Does any placement in the supplied install provenance manifests (Task 010
 * format) vouch for a skill dir whose whole-dir content hash is `dirHash`? A
 * manifest records `placements[].hashes[skill]` as the newline-normalized
 * whole-dir digest at install time; a match proves the on-disk dir is an
 * unmodified copy of exactly what we placed. Skill-name keys are folded
 * case-insensitively when `caseInsensitive` is set (matching the manifest's own
 * dedup semantics).
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

/**
 * Resolve the exarchos version recorded in the provenance manifest. Reads the
 * root `package.json` `version` (the single source of truth) relative to this
 * module; falls back to `'unknown'` when the file cannot be read (e.g. a bundled
 * binary whose `package.json` is not on disk). Cached after first resolution.
 */
let cachedExarchosVersion: string | undefined;
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
    // Keep the 'unknown' fallback.
  }
  return cachedExarchosVersion;
}

/**
 * Install skills for a specific agent runtime.
 *
 * High-level flow:
 *   1. Resolve the target runtime via `opts.agent` → `runtimes.find(...)`.
 *   2. Build the `npx skills add ...` argv with non-interactive flags
 *      (`--skill '*' --agent <id> -y -g --copy`).
 *   3. Print the full command via `log` BEFORE spawning, so users can
 *      copy it for a manual retry.
 *   4. Spawn it via the injected `spawn` function with `FORCE_COLOR=0`
 *      and `CI=true` env so the upstream spinner doesn't flood the pipe.
 *   5. On success, register the Exarchos MCP server in `~/.claude.json`
 *      for the claude runtime (T4.3 contract).
 *
 * Failure modes:
 *   - Unknown agent → throws with the supported list.
 *   - Ambiguous detection in non-interactive mode → throws with hint.
 *   - Child non-zero exit → throws `InstallSkillsError` with `exitCode`.
 *   - MCP registration failure (post-skills) → logged to errLog but does
 *     not fail the whole install (skills are already on disk).
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

  // Resolve target runtime.
  //   - If `agent` is set, look it up and throw on miss.
  //   - If `agent` is unset, run auto-detection. A null result falls back to
  //     `generic`; an AmbiguousRuntimeError is handled below by either
  //     prompting (interactive) or surfacing remediation (non-interactive).
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
        // No agent detected — fall back to generic with a clear message.
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

  // #1355 fix — local-copy fast path.
  //
  // The upstream `npx skills add github:lvlup-sw/exarchos ...` shell-out
  // mis-installed for every non-claude runtime: it cloned the repo and
  // walked only the root level (finding just `design-invariants`,
  // missing every skill under `skills/<runtime>/`) and used its own
  // per-agent home-dir mapping that does not match our
  // `content/harness/runtimes/*.yaml` `skillsInstallPath` values. We sidestep both
  // bugs by copying the rendered per-runtime tree directly to the
  // runtime's canonical install path when a local skills source is
  // available. The shell-out path below is retained as a fallback so
  // existing unit tests (which never set `opts.skillsSource`) keep
  // verifying the upstream invocation contract.
  //
  // `skillsSource` is strictly opt-in: callers (the install-skills
  // bridge) explicitly supply `findSkillsSourceDir()` when they want
  // the fast path. Library-level callers and the existing unit tests
  // that assert on the upstream spawn argv (`src/install-skills.test.ts`)
  // pass no `skillsSource`, so the spawn path stays the default. Doing
  // implicit auto-detection inside `installSkills()` itself would
  // regress those unit tests every time they ran from REPO_ROOT.
  const skillsSource = opts.skillsSource;
  if (skillsSource) {
    const platform = opts.platform ?? process.platform;
    const caseInsensitive =
      opts.caseInsensitiveFs ?? defaultCaseInsensitiveFs(platform);
    // The canonical set = procedural (`skills/standard/`) + this runtime's
    // orchestration skills (`skills/<runtime>/`). Empty ⇒ no local tree ⇒ fall
    // through to the upstream `npx skills add` shell-out.
    const set = collectCanonicalSkillSet(skillsSource, runtime.name, caseInsensitive);
    if (set.length > 0) {
      const home = homeDirFn();
      const scope = opts.scope ?? 'user';
      const projectRoot = opts.projectRoot ?? process.cwd();
      const version = opts.version ?? readDefaultExarchosVersion();
      const copyDir = opts.copyDir ?? defaultCopyDir;
      const symlink = opts.symlink ?? defaultSymlink;

      // Per-harness NATIVE dir: always a real copy (its bytes are what the
      // harness loads). This preserves the pre-DR-4 copy contract.
      const nativeDir = expandTilde(runtime.skillsInstallPath, home);
      // Cross-client CANONICAL dir: `.agents/skills` (scope-resolved).
      const canonicalDir = resolveCanonicalSkillsDir(scope, home, projectRoot);

      log(`Installing ${set.length} skill${set.length === 1 ? '' : 's'} → ${nativeDir}`);
      copySkillSetToDir(set, nativeDir, copyDir);
      // Convention path: POSIX symlinks to the native copy; win32 copies
      // (INV-16). No-op when canonicalDir === nativeDir (e.g. `generic`).
      placeCanonicalSkillSet(set, canonicalDir, nativeDir, platform, copyDir, symlink);
      log(`Installed: ${set.map((s) => s.name).join(', ')}`);

      // Provenance manifest — one per scope, atomic write, enumerating the
      // canonical + native placement paths with newline-normalized hashes.
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

      // Install canonical command aliases (T3, #1471/#1472) — gated on the
      // runtime declaring `commandsInstallPath` + a viable alias source tree,
      // never a runtime-name literal (INV-4).
      const commandsDest = installCommandAliases(runtime, opts, home, log);

      // Mirror the post-success MCP registration that the spawn path
      // performs for the `claude` runtime — install-skills' contract
      // is "skills land + claude gets MCP wired up", regardless of
      // which install transport ran.
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

  // Build the command. We map our runtime name to the upstream `skills`
  // CLI agent identifier (e.g. our `claude` → upstream `claude-code`)
  // and pass non-interactive flags so the install completes unattended
  // in CI / scripts / non-TTY environments.
  //
  //   * `--yes` (npx) — auto-install the `skills` package without prompting.
  //   * `skills add <source>` — the upstream subcommand.
  //   * `--skill '*'` — select every skill in the source repo. Without
  //     this flag the upstream CLI prompts for selection and silently
  //     exits 0 with no writes when stdin is closed (#1217 root cause).
  //   * `--agent <id>` — scope writes to the runtime's canonical home dir
  //     (~/.claude/skills for claude-code, etc.).
  //   * `-y` — skip the global vs project confirmation prompt.
  //   * `-g` — install to the user's global home dir, which matches what
  //     `runtime.skillsInstallPath` describes (`~/.claude/skills`).
  //   * `--copy` — materialize real files instead of symlinks. Symlinks
  //     pointing into npm's cache disappear if the cache is GC'd; copies
  //     survive across sessions and are byte-stable for idempotence.
  const home = homeDirFn();
  // The expanded skills destination. No longer needed in the argv (`--target`
  // is not a valid upstream flag), but reused below for the post-install
  // summary so the user sees where skills landed.
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

  // Execute and handle failure:
  //   - Surface stderr verbatim so the user gets full diagnostics.
  //   - Echo the exact command for manual retry.
  //   - Throw an Error carrying the child's exitCode so the CLI main() can
  //     forward it to process.exit(code).
  const result = await spawn(cmd, args, {
    // Force the upstream CLI off colorized output and into a CI-friendly
    // mode so its progress spinner does not write thousands of escape
    // sequences when run under a pipe. Pure cosmetics; functionally a no-op.
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

  // Register the Exarchos MCP server in ~/.claude.json so Claude Code
  // discovers it on next launch. Only the `claude` runtime uses
  // `~/.claude.json`; other runtimes have their own config formats and
  // are out of scope for this writer (T4.3 / #1217 pin the claude path).
  if (runtime.name === 'claude') {
    try {
      registerMcp(home);
    } catch (err) {
      // Don't fail the whole install on MCP-registration trouble — the
      // skills are already on disk. Surface the failure clearly so users
      // can re-run with `claude mcp add` or edit ~/.claude.json directly.
      errLog(
        `install-skills: skills installed, but failed to register MCP server in ~/.claude.json: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Install canonical command aliases (T3, #1471/#1472) on the shell-out
  // path too — gated on `commandsInstallPath` + a viable alias source tree,
  // never a runtime-name literal (INV-4). Then print the post-install summary.
  const commandsDest = installCommandAliases(runtime, opts, home, log);
  printInstallSummary(log, skillsDest, commandsDest, runtime.name);
}

/**
 * Default prompt implementation. Lazy-loads `@inquirer/prompts` so that unit
 * tests never import it (tests inject their own `prompt` and take this path
 * out of play). Keeps the hot path free of inquirer's startup cost in cases
 * where the CLI doesn't need interactive disambiguation.
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
 * Write (or merge) the `mcpServers.exarchos` entry into `~/.claude.json`.
 *
 * Uses a merge-rather-than-overwrite policy so we never clobber unrelated
 * MCP servers a user has already configured. Idempotent: if the existing
 * entry is structurally identical to what we'd write, the function
 * returns without touching the file (mtime preserved). Otherwise it
 * writes the merged config.
 *
 * The MCP entry shape mirrors `.claude-plugin/plugin.json` (the canonical
 * source of truth for how Exarchos is invoked as an MCP server) — `command:
 * 'exarchos'`, `args: ['mcp']`, plus `WORKFLOW_STATE_DIR` env so workflow
 * events land in the user's home rather than a transient cwd.
 *
 * Implements: T4.3 contract (~/.claude.json contains MCP registration),
 *             #1217 fix.
 */
export function registerExarchosInClaudeJson(home: string): void {
  const configPath = path.join(home, '.claude.json');
  const workflowStateDir = path.join(home, '.claude', 'workflow-state');

  // Read existing config (if any) and parse. ENOENT → start from empty.
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

  // Idempotence short-circuit: if the existing entry is structurally
  // identical to what we'd write, skip the write entirely so the file's
  // mtime is preserved across repeated install-skills invocations.
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

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
 * (servers/exarchos-mcp/src/index.ts).
 *
 * Implements: DR-7 (install-skills CLI), DR-9 (docs surface), DR-10 (error paths).
 *             Fixes #1217 (non-interactive no-op + missing MCP registration).
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
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
   * our `runtimes/*.yaml` `skillsInstallPath` values. Copying locally
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
 * `$HOME` form is recognized because `runtimes/codex.yaml` and any future
 * shell-literal-style entry will not otherwise be expanded by the
 * local-copy fast path (the upstream shell-out used to mask this because
 * its child shell expanded `$HOME` itself, but the in-process copy never
 * sees a shell).
 */
export function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}${p.slice(1)}`;
  if (p === '$HOME') return home;
  if (p.startsWith('$HOME/')) return `${home}${p.slice('$HOME'.length)}`;
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
  candidates.push(path.join(process.cwd(), 'skills'));

  // Candidate 2: <binary-dir>/../../skills (dist/bin/ layout).
  try {
    if (typeof process.execPath === 'string' && process.execPath.length > 0) {
      candidates.push(path.resolve(path.dirname(process.execPath), '..', '..', 'skills'));
    }
  } catch {
    // process.execPath is always defined under Node/Bun, but guard anyway.
  }

  // Candidate 3: <this-file-dir>/../skills (src/ layout under tsx/ts-node).
  try {
    if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.resolve(here, '..', 'skills'));
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
export function findCommandAliasesSourceDir(): string | undefined {
  const candidates: string[] = [];
  candidates.push(path.join(process.cwd(), 'command-aliases'));
  try {
    if (typeof process.execPath === 'string' && process.execPath.length > 0) {
      candidates.push(
        path.resolve(path.dirname(process.execPath), '..', '..', 'command-aliases'),
      );
    }
  } catch {
    // process.execPath is always defined under Node/Bun, but guard anyway.
  }
  try {
    if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')) {
      const here = path.dirname(fileURLToPath(import.meta.url));
      candidates.push(path.resolve(here, '..', 'command-aliases'));
    }
  } catch {
    // import.meta.url may be a non-file: URL inside bun-compile output.
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
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
  } catch {
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
  // `runtimes/*.yaml` `skillsInstallPath` values. We sidestep both
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
    const runtimeSourceDir = path.join(skillsSource, runtime.name);
    let sourceIsViable = false;
    try {
      sourceIsViable = fs.statSync(runtimeSourceDir).isDirectory();
    } catch {
      sourceIsViable = false;
    }
    if (sourceIsViable) {
      const home = homeDirFn();
      const destDir = expandTilde(runtime.skillsInstallPath, home);
      const copyDir = opts.copyDir ?? defaultCopyDir;
      log(
        `Installing skills locally from ${runtimeSourceDir} → ${destDir}`,
      );
      const installed = copyLocalSkills(runtimeSourceDir, destDir, copyDir);
      log(`Installed ${installed.length} skill${installed.length === 1 ? '' : 's'}: ${installed.join(', ')}`);

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

      printInstallSummary(log, destDir, commandsDest, runtime.name);
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

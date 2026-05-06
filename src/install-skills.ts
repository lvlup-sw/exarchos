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
 * Expand a leading `~` in a path to the user's home directory. We do not use
 * `os.homedir()` directly so tests can pass a deterministic home. Also handles
 * the no-tilde case (returns input unchanged) and a bare `~` (returns home).
 */
export function expandTilde(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}${p.slice(1)}`;
  return p;
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
  // `expandTilde` retained as an exported helper for downstream callers /
  // future runtimes; it's no longer needed in the argv since `--target` is
  // not a valid upstream flag.
  const _target = expandTilde(runtime.skillsInstallPath, home);
  void _target;

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

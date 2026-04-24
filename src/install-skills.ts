/**
 * `installSkills()` — programmatic entry point for the `exarchos install-skills`
 * CLI subcommand. Given a target agent name (or auto-detection, added in
 * task 020), resolves the matching runtime map and shells out to
 * `npx skills add github:lvlup-sw/exarchos skills/<name> --target <path>`
 * so that an agent's skills directory is populated from the rendered output.
 *
 * All side effects (spawn, logging, home-dir resolution) are injected so that
 * unit tests can verify behavior without touching the host system. The CLI
 * wiring lives in the binary entry point (servers/exarchos-mcp/src/index.ts).
 *
 * Implements: DR-7 (install-skills CLI), DR-9 (docs surface), DR-10 (error paths).
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
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
export function expandTilde(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home}${path.slice(1)}`;
  return path;
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
 * Install skills for a specific agent runtime.
 *
 * High-level flow (task 019):
 *   1. Resolve the target runtime via `opts.agent` → `runtimes.find(...)`.
 *   2. Expand the tilde in `skillsInstallPath` using the injected home-dir.
 *   3. Build the `npx skills add ...` argv.
 *   4. Print the full command via `log` BEFORE spawning, so users can copy it
 *      for a manual retry.
 *   5. Spawn it via the injected `spawn` function.
 *
 * Task 020 adds auto-detection when `opts.agent` is absent; task 021 adds
 * richer error handling and interactive disambiguation. For task 019 we only
 * implement the happy path plus the unknown-agent error.
 */
export async function installSkills(opts: InstallSkillsOpts): Promise<void> {
  const runtimes = opts.runtimes ?? [];
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const errLog = opts.errLog ?? ((msg: string) => console.error(msg));
  const spawn = opts.spawn ?? defaultSpawn;
  const homeDirFn = opts.homeDir ?? (() => homedir());
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

  // Build the command.
  const home = homeDirFn();
  const target = expandTilde(runtime.skillsInstallPath, home);

  const cmd = 'npx';
  const args = [
    'skills',
    'add',
    'github:lvlup-sw/exarchos',
    `skills/${runtime.name}`,
    '--target',
    target,
  ];
  const commandString = `${cmd} ${args.join(' ')}`;

  log(`Running: ${commandString}`);

  // Execute and handle failure:
  //   - Surface stderr verbatim so the user gets full diagnostics.
  //   - Echo the exact command for manual retry.
  //   - Throw an Error carrying the child's exitCode so the CLI main() can
  //     forward it to process.exit(code).
  const result = await spawn(cmd, args);
  if (result.code !== 0) {
    if (result.stderr) errLog(result.stderr);
    errLog(childExitRetryHeader(result.code));
    errLog(`  ${commandString}`);
    const error: InstallSkillsError = new Error(childExitErrorMessage(result.code));
    error.exitCode = result.code;
    throw error;
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

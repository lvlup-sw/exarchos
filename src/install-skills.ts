/**
 * `installSkills()` — programmatic entry point for the `exarchos install-skills`
 * CLI subcommand. Given a target agent name (or auto-detection, added in
 * task 020), resolves the matching runtime map and shells out to
 * `npx skills add github:lvlup-sw/exarchos skills/<name> --target <path>`
 * so that an agent's skills directory is populated from the rendered output.
 *
 * All side effects (spawn, logging, home-dir resolution) are injected so that
 * unit tests can verify behavior without touching the host system. The CLI
 * entry point in `src/install.ts` provides the real implementations.
 *
 * Implements: DR-7 (install-skills CLI), DR-9 (docs surface), DR-10 (error paths).
 */

import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import type { RuntimeMap } from './runtimes/types.js';

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
  const spawn = opts.spawn ?? defaultSpawn;
  const homeDirFn = opts.homeDir ?? (() => homedir());

  if (opts.agent === undefined) {
    throw new Error(
      'installSkills: no agent specified and auto-detection not yet wired. ' +
        'Pass opts.agent explicitly.',
    );
  }

  const runtime = findRuntime(runtimes, opts.agent);
  if (!runtime) {
    const supported = runtimes.map((r) => r.name).join(', ');
    throw new Error(
      `Unknown runtime: "${opts.agent}". Supported: ${supported || '(none)'}.`,
    );
  }

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

  log(`Running: ${cmd} ${args.join(' ')}`);

  await spawn(cmd, args);
}

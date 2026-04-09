/**
 * Runtime auto-detection.
 *
 * Given a set of loaded runtime maps (`generic`, `claude`, `codex`, ...), work
 * out which one is installed on the host so that `exarchos install-skills`
 * can target the right agent without the user passing `--agent`.
 *
 * Detection precedence:
 *   1. **Environment variables** — if any runtime declares an env var in
 *      `detection.envVars` that is currently set, that runtime wins
 *      immediately. Env-var matches always beat PATH matches (they're
 *      higher-signal: the agent is actively running, not merely installed).
 *   2. **PATH binaries** — for each runtime, check whether any of its
 *      `detection.binaries` resolve via `which`. Zero PATH matches returns
 *      null; exactly one is returned; two or more throw
 *      `AmbiguousRuntimeError` so the caller can prompt the user.
 *
 * All side effects (PATH lookup, env access) are injected via `DetectDeps`
 * so unit tests are fully deterministic.
 *
 * Implements: DR-7 (install-skills runtime detection).
 */

import { execSync } from 'node:child_process';
import type { RuntimeMap } from './types.js';

/**
 * Injected dependencies for `detectRuntime`. The defaults bind to real OS
 * calls (`which` via `execSync`, `env` via `process.env`); tests always
 * override both so no real lookups happen.
 */
export interface DetectDeps {
  /**
   * Resolve a binary name to its absolute path or null if not on PATH.
   * Shape matches Unix `which`: null means "not found".
   */
  which?: (cmd: string) => string | null;
  /** Environment to check for runtime env-var signals. */
  env?: Record<string, string | undefined>;
}

/**
 * Thrown when multiple runtimes match via PATH detection and no env-var
 * disambiguator is set. The CLI catches this and prompts the user (task 021).
 */
export class AmbiguousRuntimeError extends Error {
  constructor(public readonly candidates: string[]) {
    super(
      `Ambiguous runtime detection. Candidates: ${candidates.join(', ')}. ` +
        `Pass --agent to disambiguate.`,
    );
    this.name = 'AmbiguousRuntimeError';
  }
}

/**
 * Default `which` implementation: shell out to `which <cmd>` and return the
 * trimmed stdout, or null on non-zero exit / any error. Only used when the
 * caller doesn't inject their own. Tests never hit this path.
 */
const defaultWhich = (cmd: string): string | null => {
  try {
    // `which` exits non-zero if not found; execSync throws on non-zero.
    const out = execSync(`which ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
};

/**
 * Detect which runtime is installed on the host. Returns the matching
 * `RuntimeMap` on exactly one match, `null` on no match, and throws
 * `AmbiguousRuntimeError` on multiple PATH matches with no env-var signal.
 */
export function detectRuntime(
  runtimes: RuntimeMap[],
  deps: DetectDeps = {},
): RuntimeMap | null {
  const which = deps.which ?? defaultWhich;
  const env = deps.env ?? process.env;

  // 1. Env-var precedence: first runtime with any of its envVars set wins.
  for (const runtime of runtimes) {
    for (const key of runtime.detection.envVars) {
      if (env[key] !== undefined && env[key] !== '') {
        return runtime;
      }
    }
  }

  // 2. PATH-based detection: collect every runtime whose binaries resolve.
  const pathMatches: RuntimeMap[] = [];
  for (const runtime of runtimes) {
    if (runtime.detection.binaries.length === 0) continue;
    const hit = runtime.detection.binaries.some((bin) => which(bin) !== null);
    if (hit) pathMatches.push(runtime);
  }

  if (pathMatches.length === 0) return null;
  if (pathMatches.length === 1) return pathMatches[0];
  throw new AmbiguousRuntimeError(pathMatches.map((r) => r.name));
}

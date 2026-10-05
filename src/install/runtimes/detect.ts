/**
 * Detect the installed runtime, so `exarchos install-skills` can target the
 * right agent without `--agent`. Detection precedence:
 * 1. Environment variables. The first runtime with a non-empty variable from
 *    `detection.envVars` wins. An env-var match beats a PATH match, because it
 *    shows that the agent runs now.
 * 2. PATH binaries. A runtime matches when one of its `detection.binaries`
 *    resolves through `which`. No match returns `null`, and one match returns
 *    that runtime. Two or more matches throw `AmbiguousRuntimeError`.
 *
 * `DetectDeps` injects the PATH lookup and the environment.
 */

import { execSync } from 'node:child_process';
import type { RuntimeMap } from './types.js';

/**
 * Injected dependencies for `detectRuntime`. The defaults run `which` through
 * `execSync` and read `process.env`.
 */
export interface DetectDeps {
  /** Resolve a binary name to its absolute path, or `null` when it is not on PATH. */
  which?: (cmd: string) => string | null;
  /** Environment to check for runtime env-var signals. */
  env?: Record<string, string | undefined>;
}

/**
 * Thrown when two or more runtimes match on PATH and no env var selects one.
 * In an interactive session, `install-skills` catches it and prompts the user.
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
 * Default `which`: run `which <cmd>` and return the trimmed stdout. A non-zero
 * exit makes `execSync` throw, and any error returns `null`.
 */
const defaultWhich = (cmd: string): string | null => {
  try {
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

  for (const runtime of runtimes) {
    for (const key of runtime.detection.envVars) {
      if (env[key] !== undefined && env[key] !== '') {
        return runtime;
      }
    }
  }

  const pathMatches: RuntimeMap[] = [];
  for (const runtime of runtimes) {
    if (runtime.detection.binaries.length === 0) continue;
    const hit = runtime.detection.binaries.some((bin) => which(bin) !== null);
    if (hit) pathMatches.push(runtime);
  }

  if (pathMatches.length === 0) return null;
  if (pathMatches.length === 1) return pathMatches[0] ?? null;
  throw new AmbiguousRuntimeError(pathMatches.map((r) => r.name));
}

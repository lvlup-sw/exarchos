/**
 * DoctorProbes — the probe bundle passed to every per-check function.
 *
 * Each check receives a single `DoctorProbes` argument rather than
 * reaching into `process.*` or module-scope state, so unit tests can
 * build checks with plain object overrides (DIM-4/T-4.2: ≤3 mocks per
 * test). Defaults bind to real runtime surfaces; the composer wires
 * them via `buildProbes(ctx)` at dispatch time, never at module init.
 *
 * Probe fields:
 *   - `fs`       — narrow filesystem surface (readFile / stat / access)
 *   - `env`      — process env snapshot
 *   - `git`      — narrow git surface (which, isRepo)
 *   - `sqlite`   — lazy handle getter for sqlite integrity probing; may
 *                  be null when no backend is attached (jsonl-only mode)
 *   - `detector` — AgentEnvironmentDetector callable
 *   - `eventStore` — the context's EventStore, forwarded by reference
 *   - `runtime`  — observable runtime metadata (node version), injected
 *                  rather than read via `process.*` inside checks
 *   - `stateDir` — resolved state directory path (forwarded from
 *                  DispatchContext)
 */

import { promises as nodeFs, constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DispatchContext } from '../../core/dispatch.js';
import type { EventStore, IntegrityResult } from '../../event-store/store.js';
import {
  detectAgentEnvironments,
  type AgentEnvironment,
  type DetectorFs,
} from '../../runtime/agent-environment-detector.js';

const execFileAsync = promisify(execFile);

/** Widened fs surface for doctor checks: readFile/stat from DetectorFs
 * plus an `access` probe for writability checks. Optional so tests can
 * omit it when irrelevant. */
export interface DoctorFs extends DetectorFs {
  access?(path: string, mode?: number): Promise<void>;
}

export interface DoctorGit {
  which(cmd: string): Promise<string | null>;
  isRepo(cwd: string): Promise<boolean>;
  /** Returns the `git --version` short string (e.g. "2.43.0") or null
   * when the binary is unavailable or emits unrecognized output. Used by
   * vcs-git-available for the Pass message. */
  version(): Promise<string | null>;
}

export interface DoctorSqlite {
  /**
   * Run a bounded backend integrity probe via the EventStore's narrow
   * accessor. The EventStore itself enforces the timeout and abort
   * contract (DIM-7); this probe is a thin forwarder. The returned
   * IntegrityResult is a discriminated union — callers pattern-match
   * on `ok` without type assertions (DIM-3).
   */
  runIntegrityCheck(opts?: {
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<IntegrityResult>;
}

export interface DoctorRuntime {
  /** Node.js version string (e.g. "v20.11.0") — injected so checks
   * don't read `process.version` directly (DIM-4). */
  readonly nodeVersion: string;
}

export interface DoctorSkills {
  /** Cheap drift detection over the skills-src → skills pipeline. Returns
   * `{inSync:true}` when generated output matches source, otherwise
   * `{inSync:false, driftedPaths}` listing representative drifted files.
   * Must honor `signal` (AbortController) and stay within 2000ms
   * (DIM-7). */
  guardStatus(signal?: AbortSignal): Promise<{ inSync: boolean; driftedPaths?: string[] }>;
}

export interface DoctorPlugin {
  /** Version string from the installed plugin's package.json (Claude
   * Code plugin cache), or null when the plugin is not installed
   * locally. Compute per call — DIM-1 forbids module-global caching. */
  installedVersion(): Promise<string | null>;
  /** Version string from the repo-root package.json (the version this
   * MCP server was built from), or null when unreadable. */
  runningVersion(): Promise<string | null>;
}

export interface DoctorProbes {
  readonly fs: DoctorFs;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly git: DoctorGit;
  readonly sqlite: DoctorSqlite;
  readonly detector: (signal?: AbortSignal) => Promise<AgentEnvironment[]>;
  readonly eventStore: EventStore;
  readonly runtime: DoctorRuntime;
  readonly stateDir: string;
  readonly skills: DoctorSkills;
  readonly plugin: DoctorPlugin;
}

const DEFAULT_FS: DoctorFs = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  stat: (p) => nodeFs.stat(p),
  access: (p, mode) => nodeFs.access(p, mode ?? fsConstants.F_OK),
};

const DEFAULT_GIT: DoctorGit = {
  which: async (cmd) => {
    // 'which' is POSIX-only; use 'where' on Windows
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    try {
      const { stdout } = await execFileAsync(whichCmd, [cmd]);
      const trimmed = stdout.trim().split(/\r?\n/)[0] ?? '';
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  },
  isRepo: async (cwd) => {
    try {
      await execFileAsync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
      return true;
    } catch {
      return false;
    }
  },
  version: async () => {
    try {
      const { stdout } = await execFileAsync('git', ['--version']);
      // `git --version` prints "git version 2.43.0" (with optional
      // trailing suffix). Extract the semver-ish token; null if the
      // output shape is unrecognized.
      const match = stdout.match(/\d+\.\d+(?:\.\d+)?/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  },
};

/** Resolve the repo root by walking up from this module until a
 * `package.json` is found. Computed per call (DIM-1 forbids module-
 * global caching). */
async function findRepoRoot(marker: string): Promise<string | null> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      await nodeFs.access(join(dir, marker), fsConstants.F_OK);
      return dir;
    } catch {
      // keep walking
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Lightweight drift heuristic: for each `skills-src/<name>/SKILL.md`,
 * if any matching `skills/<runtime>/<name>/SKILL.md` has an older mtime,
 * treat that skill as drifted. Fast and avoids spawning `npm run
 * skills:guard` (which re-renders everything and would exceed the 2000ms
 * probe budget). */
async function defaultSkillsGuardStatus(
  signal?: AbortSignal,
): Promise<{ inSync: boolean; driftedPaths?: string[] }> {
  const root = await findRepoRoot('skills-src');
  if (root === null) return { inSync: true }; // nothing to check
  const srcRoot = join(root, 'skills-src');
  const outRoot = join(root, 'skills');
  let srcSkills: string[];
  try {
    srcSkills = (await nodeFs.readdir(srcRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => d.name);
  } catch {
    return { inSync: true };
  }
  let runtimes: string[];
  try {
    runtimes = (await nodeFs.readdir(outRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { inSync: true };
  }

  const drifted: string[] = [];
  for (const skill of srcSkills) {
    if (signal?.aborted) {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    }
    const srcPath = join(srcRoot, skill, 'SKILL.md');
    let srcMtime: number;
    try {
      srcMtime = (await nodeFs.stat(srcPath)).mtimeMs;
    } catch {
      continue;
    }
    for (const runtime of runtimes) {
      const outPath = join(outRoot, runtime, skill, 'SKILL.md');
      try {
        const outMtime = (await nodeFs.stat(outPath)).mtimeMs;
        if (outMtime < srcMtime) drifted.push(`skills/${runtime}/${skill}/SKILL.md`);
      } catch {
        // runtime may not render every skill; skip missing entries
      }
    }
  }

  return drifted.length === 0 ? { inSync: true } : { inSync: false, driftedPaths: drifted };
}

async function readPackageVersion(path: string): Promise<string | null> {
  try {
    const raw = await nodeFs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Find the installed plugin's package.json by scanning the Claude Code
 * plugin cache. DIM-1: computed per call, no caching. */
async function defaultInstalledPluginVersion(): Promise<string | null> {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return null;
  const cacheRoot = join(home, '.claude', 'plugins', 'cache', 'lvlup-sw', 'exarchos');
  let versions: string[];
  try {
    versions = (await nodeFs.readdir(cacheRoot, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }),
      );
  } catch {
    return null;
  }
  for (const v of versions) {
    const pkg = await readPackageVersion(join(cacheRoot, v, 'package.json'));
    if (pkg !== null) return pkg;
  }
  return null;
}

async function defaultRunningVersion(): Promise<string | null> {
  const root = await findRepoRoot('package.json');
  if (root === null) return null;
  return readPackageVersion(join(root, 'package.json'));
}

/**
 * Build a DoctorProbes bundle from a DispatchContext. Each probe field
 * binds to a real runtime surface; tests bypass this factory entirely
 * by constructing a DoctorProbes literal with just the fields under
 * test.
 */
export function buildProbes(ctx: DispatchContext): DoctorProbes {
  return {
    fs: DEFAULT_FS,
    env: process.env,
    git: DEFAULT_GIT,
    // Thin forwarder to the EventStore's narrow integrity accessor.
    // The EventStore enforces timeout + abort internally (DIM-7) and
    // reports skipped when no applicable backend is attached, so this
    // probe never needs to reach for a raw sqlite handle (DIM-6).
    sqlite: {
      runIntegrityCheck: (opts) => ctx.eventStore.runIntegrityCheck(opts),
    },
    detector: (signal) => detectAgentEnvironments(undefined, signal),
    eventStore: ctx.eventStore,
    runtime: { nodeVersion: process.version },
    stateDir: ctx.stateDir,
    skills: { guardStatus: defaultSkillsGuardStatus },
    plugin: {
      installedVersion: defaultInstalledPluginVersion,
      runningVersion: defaultRunningVersion,
    },
  };
}

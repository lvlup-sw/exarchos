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
import type { DispatchContext } from '../../core/dispatch.js';
import type { EventStore } from '../../event-store/store.js';
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
}

export interface DoctorSqlite {
  /** Returns a backend handle suitable for PRAGMA integrity_check, or
   * null when no backend is attached (jsonl-only mode). */
  handle(): unknown | null;
}

export interface DoctorRuntime {
  /** Node.js version string (e.g. "v20.11.0") — injected so checks
   * don't read `process.version` directly (DIM-4). */
  readonly nodeVersion: string;
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
}

const DEFAULT_FS: DoctorFs = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  stat: (p) => nodeFs.stat(p),
  access: (p, mode) => nodeFs.access(p, mode ?? fsConstants.F_OK),
};

const DEFAULT_GIT: DoctorGit = {
  which: async (cmd) => {
    try {
      const { stdout } = await execFileAsync('which', [cmd]);
      const trimmed = stdout.trim();
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
};

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
    // The EventStore does not expose a raw sqlite handle today; the
    // storage-sqlite-health check reads through the backend interface
    // when present. handle() returns null in jsonl-only mode so the
    // check can emit Skipped with a reason.
    sqlite: { handle: () => null },
    detector: (signal) => detectAgentEnvironments(undefined, signal),
    eventStore: ctx.eventStore,
    runtime: { nodeVersion: process.version },
    stateDir: ctx.stateDir,
  };
}

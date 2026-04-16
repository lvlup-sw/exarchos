/**
 * AgentEnvironmentDetector — "which agent runtime configs exist in this
 * project?"
 *
 * Separation from `src/runtimes/detect.ts`: that module answers a
 * different question — "which runtime binary is installed on PATH" for
 * `exarchos install-skills` targeting (DR-7). This module inspects the
 * filesystem for runtime config files (`~/.claude.json`,
 * `.cursor/mcp.json`, `.codex/`, etc.) so that `exarchos doctor` can
 * report per-runtime config presence/validity and so the enhanced
 * `exarchos init` (#1091) can offer targeted remediation. The two
 * primitives compose but never duplicate: one asks "is the agent
 * installed on this host?", the other "is the agent configured in this
 * project?". A host can have claude-code on PATH without a project
 * `.claude.json`, and vice versa. Consolidation, if it ever makes sense,
 * is a dedicated hygiene PR — not a drive-by edit here.
 *
 * All side effects (`fs`, HOME, cwd) are injected via `DetectorDeps`
 * with `process.*` defaults (DIM-1). No module-global state.
 */

import { promises as nodeFs } from 'node:fs';
import * as path from 'node:path';

export type AgentRuntimeName =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'copilot'
  | 'opencode';

export interface AgentEnvironment {
  readonly name: AgentRuntimeName;
  readonly configPath: string;
  readonly configPresent: boolean;
  readonly configValid: boolean;
  readonly mcpRegistered: boolean;
  readonly skillsDir?: string;
}

/** Narrow fs surface so tests can pass plain-object stubs. */
export interface DetectorFs {
  readFile(p: string): Promise<string>;
  stat(p: string): Promise<{ isDirectory(): boolean }>;
}

export interface DetectorDeps {
  readonly fs?: DetectorFs;
  readonly home?: () => string;
  readonly cwd?: () => string;
}

const DEFAULT_FS: DetectorFs = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  stat: (p) => nodeFs.stat(p),
};
const DEFAULT_HOME = (): string =>
  process.env.HOME ?? process.env.USERPROFILE ?? '';
const DEFAULT_CWD = (): string => process.cwd();

const RUNTIMES: readonly AgentRuntimeName[] = [
  'claude-code',
  'codex',
  'cursor',
  'copilot',
  'opencode',
];

/**
 * Inspect the filesystem (via injected `deps.fs`) and return one record
 * per known runtime describing config presence, validity, and whether
 * exarchos is registered as an MCP server. Pure with respect to
 * injected deps; no cache. If `signal` fires, the promise rejects with
 * an AbortError-shaped exception. Non-abort probe failures collapse to
 * `configPresent: false` — absence is never a runtime error.
 */
export async function detectAgentEnvironments(
  deps?: DetectorDeps,
  signal?: AbortSignal,
): Promise<AgentEnvironment[]> {
  throwIfAborted(signal);
  const fs = deps?.fs ?? DEFAULT_FS;
  const home = (deps?.home ?? DEFAULT_HOME)();
  const cwd = (deps?.cwd ?? DEFAULT_CWD)();

  const results: AgentEnvironment[] = [];
  for (const name of RUNTIMES) {
    throwIfAborted(signal);
    results.push(await probeRuntime(name, fs, home, cwd));
  }
  return results;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

async function probeRuntime(
  name: AgentRuntimeName,
  fs: DetectorFs,
  home: string,
  cwd: string,
): Promise<AgentEnvironment> {
  const configPath = configPathFor(name, home, cwd);

  if (name === 'claude-code') {
    const probed = await probeJsonMcpConfig(fs, configPath);
    return { name, configPath, ...probed, skillsDir: path.join(home, '.claude', 'skills') };
  }
  if (name === 'cursor' || name === 'opencode') {
    const probed = await probeJsonMcpConfig(fs, configPath);
    return { name, configPath, ...probed };
  }
  if (name === 'codex') {
    // Presence-only: codex has no well-known JSON config file yet.
    const present = await dirExists(fs, configPath);
    return { name, configPath, configPresent: present, configValid: present, mcpRegistered: false };
  }
  if (name === 'copilot') {
    // Two documented instruction paths; either signals project targets copilot.
    const vscode = path.join(cwd, '.vscode', 'copilot-instructions.md');
    const github = path.join(cwd, '.github', 'copilot-instructions.md');
    const hit = (await fileExists(fs, vscode)) ? vscode
      : (await fileExists(fs, github)) ? github
      : null;
    return {
      name,
      configPath: hit ?? configPath,
      configPresent: hit !== null,
      configValid: hit !== null,
      mcpRegistered: false,
    };
  }
  const _exhaustive: never = name;
  return _exhaustive;
}

/** Read a JSON config file and report presence, JSON validity, and
 * whether `mcpServers.exarchos` is registered. Used by claude-code,
 * cursor, and opencode probes. */
async function probeJsonMcpConfig(
  fs: DetectorFs,
  configPath: string,
): Promise<{ configPresent: boolean; configValid: boolean; mcpRegistered: boolean }> {
  const raw = await readOrNull(fs, configPath);
  if (raw === null) {
    return { configPresent: false, configValid: false, mcpRegistered: false };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { configPresent: true, configValid: false, mcpRegistered: false };
    }
    const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
    const mcpRegistered =
      typeof mcpServers === 'object' &&
      mcpServers !== null &&
      'exarchos' in (mcpServers as Record<string, unknown>);
    return { configPresent: true, configValid: true, mcpRegistered };
  } catch {
    return { configPresent: true, configValid: false, mcpRegistered: false };
  }
}

async function readOrNull(fs: DetectorFs, p: string): Promise<string | null> {
  try { return await fs.readFile(p); } catch { return null; }
}

async function fileExists(fs: DetectorFs, p: string): Promise<boolean> {
  try { await fs.readFile(p); return true; } catch { return false; }
}

async function dirExists(fs: DetectorFs, p: string): Promise<boolean> {
  try { const s = await fs.stat(p); return s.isDirectory(); } catch { return false; }
}

function configPathFor(name: AgentRuntimeName, home: string, cwd: string): string {
  switch (name) {
    case 'claude-code': return path.join(home, '.claude.json');
    case 'cursor':      return path.join(cwd, '.cursor', 'mcp.json');
    case 'codex':       return path.join(cwd, '.codex');
    case 'copilot':     return path.join(cwd, '.github', 'copilot-instructions.md');
    case 'opencode':    return path.join(cwd, '.opencode', 'mcp.json');
  }
}

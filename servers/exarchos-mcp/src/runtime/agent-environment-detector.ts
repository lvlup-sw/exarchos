/**
 * AgentEnvironmentDetector — "which agent runtime configs exist in this
 * project?"
 *
 * # Separation from `src/runtimes/detect.ts`
 *
 * The repo already has `src/runtimes/detect.ts`, which answers a different
 * question: "which runtime *binary* is installed on PATH" so that
 * `exarchos install-skills` can pick an install target when `--agent` is
 * not passed (see DR-7 in that file's JSDoc).
 *
 * This module instead inspects the filesystem for runtime *config files*
 * (e.g., `~/.claude.json`, `.cursor/mcp.json`, `.codex/`) so that
 * `exarchos doctor` can report per-runtime config presence/validity and so
 * that the enhanced `exarchos init` (issue #1091) can offer targeted
 * remediation.
 *
 * The two primitives compose but never duplicate: one asks "is the agent
 * installed on this host?", the other asks "is the agent configured in
 * this project?". A host can have claude-code on PATH without a project
 * `.claude.json`, and vice versa. If future work finds a shared signal,
 * consolidation belongs in a dedicated hygiene PR, not a drive-by edit.
 *
 * # Dependency injection (DIM-1)
 *
 * All side effects (`fs`, `process.env.HOME`, `process.cwd`) are injected
 * through `DetectorDeps`. Defaults bind to real system calls; tests
 * always pass stubs so no real filesystem reads happen. No module-global
 * state; every call is independent.
 *
 * Implements the shared primitive consumed by issues #1089 (doctor) and
 * #1091 (enhanced init).
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

/**
 * Minimal fs surface the detector needs. Keeps the interface narrow so
 * tests can implement it with plain objects instead of mocking whole
 * modules.
 */
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
 * Inspect the host filesystem (via injected `deps.fs`) and return a
 * record per known runtime describing config presence, validity, and
 * whether exarchos is registered as an MCP server.
 *
 * Every call is pure with respect to the injected deps; there is no
 * cache. Callers that need memoization should wrap the call themselves.
 *
 * If `signal` fires before or during probing, the returned promise
 * rejects with an AbortError-shaped exception. Probe failures other
 * than abort collapse to `configPresent: false` — "no config here" is
 * always a valid answer, not a runtime error.
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
    const raw = await readOrNull(fs, configPath);
    if (raw === null) {
      return {
        name,
        configPath,
        configPresent: false,
        configValid: false,
        mcpRegistered: false,
        skillsDir: path.join(home, '.claude', 'skills'),
      };
    }
    const parsed = parseClaudeConfig(raw);
    return {
      name,
      configPath,
      configPresent: true,
      configValid: parsed.valid,
      mcpRegistered: parsed.mcpRegistered,
      skillsDir: path.join(home, '.claude', 'skills'),
    };
  }

  // Tasks 005: cursor, codex, copilot, opencode branches land next.
  return {
    name,
    configPath,
    configPresent: false,
    configValid: false,
    mcpRegistered: false,
  };
}

async function readOrNull(fs: DetectorFs, p: string): Promise<string | null> {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

function parseClaudeConfig(raw: string): { valid: boolean; mcpRegistered: boolean } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { valid: false, mcpRegistered: false };
    }
    const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
    const mcpRegistered =
      typeof mcpServers === 'object' &&
      mcpServers !== null &&
      'exarchos' in (mcpServers as Record<string, unknown>);
    return { valid: true, mcpRegistered };
  } catch {
    return { valid: false, mcpRegistered: false };
  }
}

function configPathFor(name: AgentRuntimeName, home: string, cwd: string): string {
  switch (name) {
    case 'claude-code':
      return path.join(home, '.claude.json');
    case 'cursor':
      return path.join(cwd, '.cursor', 'mcp.json');
    case 'codex':
      return path.join(cwd, '.codex');
    case 'copilot':
      return path.join(cwd, '.github', 'copilot-instructions.md');
    case 'opencode':
      return path.join(cwd, '.opencode', 'mcp.json');
  }
}

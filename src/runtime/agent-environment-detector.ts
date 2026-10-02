/**
 * Detects which agent runtime configs exist in this project.
 *
 * `src/install/runtimes/detect.ts` answers a different question: which runtime
 * binary is on PATH. This module reads runtime config files (`~/.claude.json`,
 * `.cursor/mcp.json`, `.codex/`, and more) for `exarchos doctor` and for onboarding.
 * A host can have claude-code on PATH without a project config, and the opposite.
 *
 * All side effects (`fs`, HOME, cwd) come through `DetectorDeps`, with `process.*` defaults.
 */

import { promises as nodeFs } from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../utils/paths.js';

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
 * Return one record for each known runtime: config presence, config validity, and
 * whether exarchos is registered as an MCP server. There is no cache.
 * If `signal` fires, the promise rejects with an `AbortError`.
 * A missing path gives `configPresent: false`. Other read errors reject the promise.
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

/**
 * Probe one runtime. Codex has no known JSON config file, so its probe checks only
 * that `.codex/` exists. Copilot is present when either of its two instruction files exists.
 */
async function probeRuntime(
  name: AgentRuntimeName,
  fs: DetectorFs,
  home: string,
  cwd: string,
): Promise<AgentEnvironment> {
  const configPath = configPathFor(name, home, cwd);

  if (name === 'claude-code') {
    const probed = await probeJsonMcpConfig(fs, configPath);
    const mcpRegistered =
      probed.mcpRegistered || (await probeExarchosPluginInstall(fs, home));
    return {
      name,
      configPath,
      configPresent: probed.configPresent,
      configValid: probed.configValid,
      mcpRegistered,
      skillsDir: toPosix(path.join(home, '.claude', 'skills')),
    };
  }
  if (name === 'cursor' || name === 'opencode') {
    const probed = await probeJsonMcpConfig(fs, configPath);
    return { name, configPath, ...probed };
  }
  if (name === 'codex') {
    const present = await dirExists(fs, configPath);
    return { name, configPath, configPresent: present, configValid: present, mcpRegistered: false };
  }
  if (name === 'copilot') {
    const vscode = toPosix(path.join(cwd, '.vscode', 'copilot-instructions.md'));
    const github = toPosix(path.join(cwd, '.github', 'copilot-instructions.md'));
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

/**
 * Read a JSON config file and report presence, JSON validity, and whether
 * `mcpServers.exarchos` is registered. The claude-code, cursor and opencode probes use it.
 */
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

/**
 * Return `true` when an installed plugin named `exarchos@*` has a manifest that
 * declares `mcpServers.exarchos`. A marketplace install wires the MCP server in
 * `<installPath>/.claude-plugin/plugin.json`, not in `~/.claude.json`.
 * Without this probe, `exarchos doctor` reports a false negative for that install.
 * Any read or parse failure gives `false`.
 */
async function probeExarchosPluginInstall(fs: DetectorFs, home: string): Promise<boolean> {
  const installedPluginsPath = toPosix(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  let raw: string | null;
  try {
    raw = await readOrNull(fs, installedPluginsPath);
  } catch {
    return false;
  }
  if (raw === null) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;

  const plugins = (parsed as { plugins?: unknown }).plugins;
  if (typeof plugins !== 'object' || plugins === null) return false;

  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (!key.startsWith('exarchos@')) continue;
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) continue;
      const installPath = (entry as { installPath?: unknown }).installPath;
      if (typeof installPath !== 'string') continue;
      const manifestPath = toPosix(path.join(installPath, '.claude-plugin', 'plugin.json'));
      if (await manifestWiresExarchosMcp(fs, manifestPath)) return true;
    }
  }
  return false;
}

async function manifestWiresExarchosMcp(fs: DetectorFs, manifestPath: string): Promise<boolean> {
  let raw: string | null;
  try {
    raw = await readOrNull(fs, manifestPath);
  } catch {
    return false;
  }
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return false;
    const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
    return (
      typeof mcpServers === 'object' &&
      mcpServers !== null &&
      'exarchos' in (mcpServers as Record<string, unknown>)
    );
  } catch {
    return false;
  }
}

function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readOrNull(fs: DetectorFs, p: string): Promise<string | null> {
  try {
    return await fs.readFile(p);
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

async function fileExists(fs: DetectorFs, p: string): Promise<boolean> {
  try {
    await fs.readFile(p);
    return true;
  } catch (err) {
    if (isMissingPathError(err)) return false;
    throw err;
  }
}

async function dirExists(fs: DetectorFs, p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch (err) {
    if (isMissingPathError(err)) return false;
    throw err;
  }
}

/**
 * Default config path for a runtime, in POSIX form. Callers compare these paths
 * with config keys and show them in results, so the separator must be the same on each platform.
 */
function configPathFor(name: AgentRuntimeName, home: string, cwd: string): string {
  switch (name) {
    case 'claude-code': return toPosix(path.join(home, '.claude.json'));
    case 'cursor':      return toPosix(path.join(cwd, '.cursor', 'mcp.json'));
    case 'codex':       return toPosix(path.join(cwd, '.codex'));
    case 'copilot':     return toPosix(path.join(cwd, '.github', 'copilot-instructions.md'));
    case 'opencode':    return toPosix(path.join(cwd, '.opencode', 'mcp.json'));
  }
}

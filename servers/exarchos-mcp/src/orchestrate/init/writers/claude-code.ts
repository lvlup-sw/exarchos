/**
 * Claude Code RuntimeConfigWriter — deploys exarchos MCP server config,
 * commands, and skills to ~/.claude/.
 *
 * Three deployment phases:
 *   1. MCP config — read-modify-write ~/.claude.json with merge semantics
 *   2. Commands — copy project commands/ to ~/.claude/commands/
 *   3. Skills — copy project skills/claude-code/ to ~/.claude/skills/
 *
 * Each phase is independent; a skipped MCP config does not block content
 * deployment. Atomic writes via tmp+rename prevent partial writes on crash.
 */

import { join, dirname } from 'node:path';
import type { WriterDeps, WriterFs } from '../probes.js';
import type { ConfigWriteResult } from '../schema.js';
import type { RuntimeConfigWriter, WriteOptions } from './writer.js';

/** MCP server entry shape in ~/.claude.json */
interface McpServerEntry {
  readonly type: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

// ─── Atomic write helper ──────────────────────────────────────────────────

/**
 * Write JSON to disk atomically: serialize → write to `${path}.tmp` →
 * rename to `${path}`. Other writers can reuse this for their own
 * config files.
 */
export async function atomicWriteJson(
  deps: WriterDeps,
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const serialized = JSON.stringify(data, null, 2);
  await deps.fs.writeFile(tmp, serialized);
  await deps.fs.rename(tmp, path);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function isMissingPathError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function readExistingConfig(
  deps: WriterDeps,
  configPath: string,
): Promise<{ config: ClaudeConfig | null; error?: string }> {
  let raw: string;
  try {
    raw = await deps.fs.readFile(configPath);
  } catch (err: unknown) {
    if (isMissingPathError(err)) {
      return { config: {} };
    }
    return { config: null, error: `Failed to read ${configPath}: ${String(err)}` };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return { config: null, error: `${configPath} does not contain a JSON object` };
    }
    return { config: parsed as ClaudeConfig };
  } catch {
    return {
      config: null,
      error: `Failed to parse JSON in ${configPath}`,
    };
  }
}

function buildExarchosEntry(home: string): McpServerEntry {
  return {
    type: 'stdio',
    command: 'node',
    args: [join(home, '.claude', 'mcp-servers', 'exarchos-mcp.js')],
    env: {
      WORKFLOW_STATE_DIR: join(home, '.claude', 'workflow-state'),
    },
  };
}

/** Check if a directory exists at the given path. */
async function dirExists(fs: WriterFs, p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch (err: unknown) {
    if (isMissingPathError(err)) return false;
    throw err;
  }
}

/**
 * Copy all files from `srcDir` to `destDir`, creating `destDir` if
 * needed. Non-recursive: copies only top-level files. For skills the
 * layout is deeper, so we use `copyDirRecursive`.
 */
async function copyDirRecursive(
  fs: WriterFs,
  srcDir: string,
  destDir: string,
): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  let entries: string[];
  try {
    entries = await fs.readdir(srcDir);
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    let isDir = false;
    try {
      const s = await fs.stat(srcPath);
      isDir = s.isDirectory();
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'ENOENT') continue;
      throw err;
    }
    if (isDir) {
      await copyDirRecursive(fs, srcPath, destPath);
    } else {
      // Ensure parent dir exists for nested structures
      await fs.mkdir(dirname(destPath), { recursive: true });
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ─── Phase: MCP config ───────────────────────────────────────────────────

async function deployMcpConfig(
  deps: WriterDeps,
  options: WriteOptions,
): Promise<{ wrote: boolean; error?: string }> {
  const home = deps.home();
  const configPath = join(home, '.claude.json');

  const { config, error } = await readExistingConfig(deps, configPath);
  if (config === null) {
    return { wrote: false, error: error ?? 'Unknown error reading config' };
  }

  const rawServers = config.mcpServers;
  const existingServers = typeof rawServers === 'object' && rawServers !== null && !Array.isArray(rawServers)
    ? rawServers as Record<string, unknown>
    : {};
  const alreadyRegistered = 'exarchos' in existingServers;

  if (alreadyRegistered && !options.forceOverwrite) {
    return { wrote: false };
  }

  const mergedConfig: ClaudeConfig = {
    ...config,
    mcpServers: {
      ...existingServers,
      exarchos: buildExarchosEntry(home),
    },
  };

  await deps.fs.mkdir(dirname(configPath), { recursive: true });
  await atomicWriteJson(deps, configPath, mergedConfig);

  return { wrote: true };
}

// ─── Phase: Commands ─────────────────────────────────────────────────────

async function deployCommands(
  deps: WriterDeps,
  options: WriteOptions,
): Promise<boolean> {
  const srcDir = join(options.projectRoot, 'commands');
  if (!(await dirExists(deps.fs, srcDir))) return false;

  const destDir = join(deps.home(), '.claude', 'commands');
  await copyDirRecursive(deps.fs, srcDir, destDir);
  return true;
}

// ─── Phase: Skills ───────────────────────────────────────────────────────

async function deploySkills(
  deps: WriterDeps,
  options: WriteOptions,
): Promise<boolean> {
  // Claude Code skills live under skills/claude-code/ in the project
  const srcDir = join(options.projectRoot, 'skills', 'claude-code');
  if (!(await dirExists(deps.fs, srcDir))) return false;

  const destDir = join(deps.home(), '.claude', 'skills');
  await copyDirRecursive(deps.fs, srcDir, destDir);
  return true;
}

// ─── Compositor ──────────────────────────────────────────────────────────

async function writeClaudeCode(
  deps: WriterDeps,
  options: WriteOptions,
): Promise<ConfigWriteResult> {
  const home = deps.home();
  const configPath = join(home, '.claude.json');
  const componentsWritten: string[] = [];
  const warnings: string[] = [];

  // Phase 1: MCP config
  const mcpResult = await deployMcpConfig(deps, options);
  if (mcpResult.error) {
    return {
      runtime: 'claude-code',
      path: configPath,
      status: 'failed',
      componentsWritten: [],
      error: mcpResult.error,
    };
  }
  if (mcpResult.wrote) {
    componentsWritten.push('mcp-config');
  } else {
    warnings.push('exarchos MCP server already registered; use forceOverwrite to update');
  }

  // Phase 2: Commands
  const commandsDeployed = await deployCommands(deps, options);
  if (commandsDeployed) {
    componentsWritten.push('commands');
  }

  // Phase 3: Skills
  const skillsDeployed = await deploySkills(deps, options);
  if (skillsDeployed) {
    componentsWritten.push('skills');
  }

  // Determine overall status
  if (componentsWritten.length === 0) {
    return {
      runtime: 'claude-code',
      path: configPath,
      status: 'skipped',
      componentsWritten: [],
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  return {
    runtime: 'claude-code',
    path: configPath,
    status: 'written',
    componentsWritten,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export const claudeCodeWriter: RuntimeConfigWriter = {
  runtime: 'claude-code',
  write: writeClaudeCode,
};

/**
 * Class wrapper used by init compositor — `new ClaudeCodeWriter()`.
 * Delegates to the same `writeClaudeCode` implementation.
 */
export class ClaudeCodeWriter implements RuntimeConfigWriter {
  readonly runtime = 'claude-code' as const;
  write(deps: WriterDeps, options: WriteOptions): Promise<ConfigWriteResult> {
    return writeClaudeCode(deps, options);
  }
}

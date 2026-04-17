/**
 * Claude Code RuntimeConfigWriter — deploys exarchos MCP server config
 * to ~/.claude.json.
 *
 * Read-modify-write with merge semantics: existing servers and config
 * keys are preserved. Atomic writes via tmp+rename prevent partial
 * writes on crash. When an exarchos entry already exists and
 * `forceOverwrite` is false, the writer skips (no data loss from
 * accidental re-init).
 */

import { join, dirname } from 'node:path';
import type { WriterDeps } from '../probes.js';
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
    args: ['run', join(home, '.claude', 'mcp-servers', 'exarchos-mcp.js')],
    env: {
      WORKFLOW_STATE_DIR: join(home, '.claude', 'workflow-state'),
    },
  };
}

// ─── Writer ───────────────────────────────────────────────────────────────

async function writeMcpConfig(
  deps: WriterDeps,
  options: WriteOptions,
): Promise<ConfigWriteResult> {
  const home = deps.home();
  const configPath = join(home, '.claude.json');

  const { config, error } = await readExistingConfig(deps, configPath);
  if (config === null) {
    return {
      runtime: 'claude-code',
      path: configPath,
      status: 'failed',
      componentsWritten: [],
      error: error ?? 'Unknown error reading config',
    };
  }

  const existingServers = config.mcpServers ?? {};
  const alreadyRegistered = 'exarchos' in existingServers;

  if (alreadyRegistered && !options.forceOverwrite) {
    return {
      runtime: 'claude-code',
      path: configPath,
      status: 'skipped',
      componentsWritten: [],
      warnings: ['exarchos MCP server already registered; use forceOverwrite to update'],
    };
  }

  const mergedConfig: ClaudeConfig = {
    ...config,
    mcpServers: {
      ...existingServers,
      exarchos: buildExarchosEntry(home),
    },
  };

  // Ensure parent directory exists
  await deps.fs.mkdir(dirname(configPath), { recursive: true });

  await atomicWriteJson(deps, configPath, mergedConfig);

  return {
    runtime: 'claude-code',
    path: configPath,
    status: 'written',
    componentsWritten: ['mcp-config'],
  };
}

export const claudeCodeWriter: RuntimeConfigWriter = {
  runtime: 'claude-code',
  write: writeMcpConfig,
};

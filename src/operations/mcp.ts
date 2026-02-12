/**
 * MCP server configuration management for ~/.claude.json.
 *
 * Handles reading, merging, and writing MCP server entries in the
 * Claude config file. Supports bundled, external, and remote server types.
 * Only touches keys for servers declared in the manifest — preserves
 * any user-added servers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServerComponent } from '../manifest/types.js';

/** A single MCP server entry in ~/.claude.json. */
export interface McpServerEntry {
  readonly type: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
}

/** The structure of ~/.claude.json (partial — preserves unknown keys). */
export interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/**
 * Read the Claude config file from disk.
 *
 * @param configPath - Absolute path to ~/.claude.json.
 * @returns The parsed config, or an empty object if the file does not exist.
 * @throws If the file exists but contains invalid JSON.
 */
export function readMcpConfig(configPath: string): ClaudeConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  try {
    return JSON.parse(raw) as ClaudeConfig;
  } catch {
    throw new Error(`Failed to parse Claude config JSON at ${configPath}`);
  }
}

/**
 * Merge MCP server entries into an existing Claude config.
 *
 * Only adds or updates entries for servers in the provided list.
 * User-added servers (not in the manifest) are preserved untouched.
 *
 * @param config - The existing Claude config.
 * @param servers - MCP server components from the manifest.
 * @param runtime - The JavaScript runtime command (e.g., 'bun', 'node').
 * @param claudeHome - Absolute path to ~/.claude/.
 * @returns A new config with merged server entries.
 */
export function mergeMcpServers(
  config: ClaudeConfig,
  servers: readonly McpServerComponent[],
  runtime: string,
  claudeHome: string,
): ClaudeConfig {
  const existingServers = config.mcpServers ?? {};
  const mergedServers = { ...existingServers };

  for (const server of servers) {
    mergedServers[server.id] = generateMcpEntry(server, runtime, claudeHome);
  }

  return {
    ...config,
    mcpServers: mergedServers,
  };
}

/**
 * Generate a single MCP server entry from a manifest component.
 *
 * @param server - The MCP server component definition.
 * @param runtime - The JavaScript runtime command (e.g., 'bun', 'node').
 * @param claudeHome - Absolute path to ~/.claude/.
 * @returns The MCP server entry for ~/.claude.json.
 */
export function generateMcpEntry(
  server: McpServerComponent,
  runtime: string,
  claudeHome: string,
): McpServerEntry {
  switch (server.type) {
    case 'bundled': {
      const bundleFilename = server.bundlePath
        ? path.basename(server.bundlePath)
        : `${server.id}-mcp.js`;
      return {
        type: 'stdio',
        command: runtime,
        args: ['run', path.join(claudeHome, 'mcp-servers', bundleFilename)],
        env: {
          WORKFLOW_STATE_DIR: path.join(claudeHome, 'workflow-state'),
        },
      };
    }
    case 'external':
      return {
        type: 'stdio',
        command: server.command!,
        args: server.args ? [...server.args] : [],
      };
    case 'remote':
      return {
        type: 'http',
        url: server.url!,
      };
  }
}

/**
 * Remove MCP server entries by their IDs.
 *
 * Only removes servers whose IDs appear in the provided list.
 * All other servers and config keys are preserved.
 *
 * @param config - The existing Claude config.
 * @param serverIds - IDs of servers to remove.
 * @returns A new config with the specified servers removed.
 */
export function removeMcpServers(
  config: ClaudeConfig,
  serverIds: readonly string[],
): ClaudeConfig {
  if (!config.mcpServers) {
    return { ...config };
  }

  const remainingServers = { ...config.mcpServers };
  const idsToRemove = new Set(serverIds);

  for (const id of Object.keys(remainingServers)) {
    if (idsToRemove.has(id)) {
      delete remainingServers[id];
    }
  }

  return {
    ...config,
    mcpServers: remainingServers,
  };
}

/**
 * Write the Claude config to disk.
 *
 * Creates parent directories if they do not exist.
 * Output is pretty-printed with 2-space indentation.
 *
 * @param configPath - Absolute path to ~/.claude.json.
 * @param config - The config to persist.
 */
export function writeMcpConfig(configPath: string, config: ClaudeConfig): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

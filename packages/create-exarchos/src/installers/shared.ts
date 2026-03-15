import { parseJsonFile, writeJsonFile } from '../utils.js';

interface McpJson { mcpServers?: Record<string, unknown>; }

export const EXARCHOS_SERVER_CONFIG = { command: 'npx', args: ['@lvlup-sw/exarchos', 'mcp'] };

export function mergeMcpServer(configPath: string, label: string, serverId: string, serverConfig: unknown): void {
  const config = parseJsonFile<McpJson>(configPath, label);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers[serverId] = serverConfig;
  writeJsonFile(configPath, config);
}

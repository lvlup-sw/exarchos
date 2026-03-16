import type { CompanionInstall, InstallResult } from '../types.js';
import { parseJsonFile, writeJsonFile, runCommand } from '../utils.js';

interface McpJson { mcpServers?: Record<string, unknown>; }

export const EXARCHOS_SERVER_CONFIG = { command: 'npx', args: ['@lvlup-sw/exarchos', 'mcp'] };

export function mergeMcpServer(configPath: string, label: string, serverId: string, serverConfig: unknown): void {
  const config = parseJsonFile<McpJson>(configPath, label);
  if (!config.mcpServers) config.mcpServers = {};
  config.mcpServers[serverId] = serverConfig;
  writeJsonFile(configPath, config);
}

export function runPostInstallCommands(install: CompanionInstall, name: string): InstallResult | null {
  if (!install.commands?.length) return null;
  for (const cmd of install.commands) {
    const result = runCommand(cmd);
    if (!result.success) return { success: false, name, error: result.error };
  }
  return null;
}

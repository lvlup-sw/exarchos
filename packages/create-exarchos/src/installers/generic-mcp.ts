import { join } from 'node:path';
import type { Companion, InstallResult } from '../types.js';
import { mergeMcpServer, EXARCHOS_SERVER_CONFIG } from './shared.js';

export function installExarchos(mcpJsonPath?: string): InstallResult {
  const configPath = mcpJsonPath ?? join(process.cwd(), '.mcp.json');
  mergeMcpServer(configPath, '.mcp.json', 'exarchos', EXARCHOS_SERVER_CONFIG);
  return { success: true, name: 'exarchos' };
}

export function installCompanion(companion: Companion, mcpJsonPath?: string): InstallResult {
  const install = companion.install['generic-mcp'];
  if (!install) return { success: true, name: companion.name, skipped: true };
  if (install.mcp) {
    const configPath = mcpJsonPath ?? join(process.cwd(), '.mcp.json');
    mergeMcpServer(configPath, '.mcp.json', companion.id, install.mcp);
    return { success: true, name: companion.name };
  }
  return { success: true, name: companion.name, skipped: true };
}

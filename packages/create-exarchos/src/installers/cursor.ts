import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Companion, InstallResult } from '../types.js';
import { runCommand } from '../utils.js';
import { mergeMcpServer, EXARCHOS_SERVER_CONFIG } from './shared.js';

export function installExarchos(mcpJsonPath?: string): InstallResult {
  const configPath = mcpJsonPath ?? join(homedir(), '.cursor', 'mcp.json');
  mergeMcpServer(configPath, '.cursor/mcp.json', 'exarchos', EXARCHOS_SERVER_CONFIG);
  return { success: true, name: 'exarchos' };
}

export function installCompanion(companion: Companion, mcpJsonPath?: string): InstallResult {
  const install = companion.install.cursor;
  if (!install) return { success: true, name: companion.name, skipped: true };
  if (install.skills) {
    const result = runCommand(`npx skills add ${install.skills}`);
    return { success: result.success, name: companion.name, error: result.error };
  }
  if (install.mcp) {
    const configPath = mcpJsonPath ?? join(homedir(), '.cursor', 'mcp.json');
    mergeMcpServer(configPath, '.cursor/mcp.json', companion.id, install.mcp);
    return { success: true, name: companion.name };
  }
  return { success: true, name: companion.name, skipped: true };
}

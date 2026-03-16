import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Companion, InstallResult } from '../types.js';
import { runCommand } from '../utils.js';
import { mergeMcpServer, runPostInstallCommands, EXARCHOS_SERVER_CONFIG } from './shared.js';

export function installExarchos(mcpJsonPath?: string): InstallResult {
  const configPath = mcpJsonPath ?? join(homedir(), '.copilot', 'mcp-config.json');
  mergeMcpServer(configPath, '.copilot/mcp-config.json', 'exarchos', EXARCHOS_SERVER_CONFIG);
  return { success: true, name: 'exarchos' };
}

export function installCompanion(companion: Companion, mcpJsonPath?: string): InstallResult {
  const install = companion.install['copilot-cli'];
  if (!install) return { success: true, name: companion.name, skipped: true };
  if (install.skills) {
    const result = runCommand(`npx skills add ${install.skills}`);
    if (!result.success) return { success: false, name: companion.name, error: result.error };
  }
  if (install.mcp) {
    const configPath = mcpJsonPath ?? join(homedir(), '.copilot', 'mcp-config.json');
    mergeMcpServer(configPath, '.copilot/mcp-config.json', companion.id, install.mcp);
  }
  const cmdErr = runPostInstallCommands(install, companion.name);
  if (cmdErr) return cmdErr;
  if (!install.skills && !install.mcp && !install.commands?.length) {
    return { success: true, name: companion.name, skipped: true };
  }
  return { success: true, name: companion.name };
}

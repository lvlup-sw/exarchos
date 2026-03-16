import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Companion, InstallResult } from '../types.js';
import { runCommand } from '../utils.js';
import { mergeMcpServer, runPostInstallCommands } from './shared.js';

export function installExarchos(): InstallResult {
  const result = runCommand('claude plugin install exarchos@lvlup-sw');
  return { success: result.success, name: 'exarchos', error: result.error };
}

export function installCompanion(companion: Companion, claudeJsonPath?: string): InstallResult {
  const install = companion.install['claude-code'];
  if (!install) return { success: true, name: companion.name, skipped: true };
  if (install.plugin) {
    const result = runCommand(`claude plugin install ${install.plugin}`);
    if (!result.success) return { success: false, name: companion.name, error: result.error };
  }
  if (install.mcp) {
    const configPath = claudeJsonPath ?? join(homedir(), '.claude.json');
    mergeMcpServer(configPath, '.claude.json', companion.id, install.mcp);
  }
  const cmdErr = runPostInstallCommands(install, companion.name);
  if (cmdErr) return cmdErr;
  if (!install.plugin && !install.mcp && !install.commands?.length) {
    return { success: true, name: companion.name, skipped: true };
  }
  return { success: true, name: companion.name };
}

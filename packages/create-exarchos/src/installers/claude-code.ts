import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Companion, InstallResult } from '../types.js';
import { runCommand } from '../utils.js';
import { mergeMcpServer } from './shared.js';

export function installExarchos(): InstallResult {
  const result = runCommand('claude plugin install exarchos@lvlup-sw');
  return { success: result.success, name: 'exarchos', error: result.error };
}

export function installCompanion(companion: Companion, claudeJsonPath?: string): InstallResult {
  const install = companion.install['claude-code'];
  if (!install) return { success: true, name: companion.name, skipped: true };
  if (install.plugin) {
    const result = runCommand(`claude plugin install ${install.plugin}`);
    return { success: result.success, name: companion.name, error: result.error };
  }
  if (install.mcp) {
    const configPath = claudeJsonPath ?? join(homedir(), '.claude.json');
    mergeMcpServer(configPath, '.claude.json', companion.id, install.mcp);
    return { success: true, name: companion.name };
  }
  return { success: true, name: companion.name, skipped: true };
}

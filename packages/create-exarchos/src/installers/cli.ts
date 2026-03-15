import type { Companion, InstallResult } from '../types.js';
import { runCommand } from '../utils.js';

export function installExarchos(): InstallResult {
  const result = runCommand('npm install -g @lvlup-sw/exarchos');
  return { success: result.success, name: 'exarchos', error: result.error };
}

export function installCompanion(_companion: Companion): InstallResult {
  return { success: true, name: _companion.name, skipped: true };
}

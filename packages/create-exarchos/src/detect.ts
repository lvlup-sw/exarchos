import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Environment } from './types.js';

export function detectEnvironment(): Environment | null {
  // Check for ~/.claude.json (Claude Code config) rather than ~/.claude/ directory,
  // which can be created by tools like playwright-cli installing skills.
  const claudeConfig = join(homedir(), '.claude.json');
  if (existsSync(claudeConfig)) return 'claude-code';
  const copilotDir = join(homedir(), '.copilot');
  if (existsSync(copilotDir)) return 'copilot-cli';
  const cursorHome = join(homedir(), '.cursor');
  const cursorCwd = join(process.cwd(), '.cursor');
  if (existsSync(cursorHome) || existsSync(cursorCwd)) return 'cursor';
  return null;
}

export function isCommandAvailable(cmd: string): boolean {
  if (!/^[\w.-]+$/.test(cmd)) return false;
  try {
    execFileSync('which', [cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

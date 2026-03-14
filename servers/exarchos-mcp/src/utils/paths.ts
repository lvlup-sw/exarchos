import os from 'node:os';
import path from 'node:path';

/**
 * Expand a leading `~` to the user's home directory.
 * Node.js `fs` does not perform shell-style tilde expansion,
 * so paths like `~/.claude/workflow-state` must be expanded manually.
 */
export function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Detect whether Exarchos is running as a Claude Code plugin.
 * Returns true if either CLAUDE_PLUGIN_ROOT or EXARCHOS_PLUGIN_ROOT
 * environment variable is set to a non-empty value.
 */
export function isClaudeCodePlugin(): boolean {
  return !!(process.env.CLAUDE_PLUGIN_ROOT || process.env.EXARCHOS_PLUGIN_ROOT);
}

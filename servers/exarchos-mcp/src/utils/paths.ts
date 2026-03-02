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
 * Resolve a script name to its absolute path.
 *
 * Uses `EXARCHOS_PLUGIN_ROOT` env var when available (plugin mode),
 * falling back to `~/.claude/scripts/` for legacy symlink installs.
 */
export function resolveScript(scriptName: string): string {
  const pluginRoot = process.env.EXARCHOS_PLUGIN_ROOT;
  if (pluginRoot) {
    return path.join(pluginRoot, 'scripts', scriptName);
  }
  return path.join(os.homedir(), '.claude', 'scripts', scriptName);
}

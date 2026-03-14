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
 * Returns true if running as a Claude Code plugin (detected via
 * `CLAUDE_PLUGIN_ROOT` or `EXARCHOS_PLUGIN_ROOT` env vars).
 */
export function isClaudeCodePlugin(): boolean {
  return !!(process.env['CLAUDE_PLUGIN_ROOT'] || process.env['EXARCHOS_PLUGIN_ROOT']);
}

/**
 * Resolve a directory path using the 4-level cascade:
 *   1. Explicit env var (always wins)
 *   2. Claude Code plugin mode → `~/.claude/<claudeSubdir>`
 *   3. `XDG_STATE_HOME` → `$XDG_STATE_HOME/exarchos/<exarchosSubdir>`
 *   4. Universal default → `~/.exarchos/<exarchosSubdir>`
 *
 * `expandTilde()` is applied to explicit env var values.
 */
function resolveDir(envKey: string, claudeSubdir: string, exarchosSubdir: string): string {
  const envValue = process.env[envKey];
  if (envValue) {
    return expandTilde(envValue);
  }

  if (isClaudeCodePlugin()) {
    return path.join(os.homedir(), '.claude', claudeSubdir);
  }

  const xdgStateHome = process.env['XDG_STATE_HOME'];
  if (xdgStateHome) {
    return path.join(xdgStateHome, 'exarchos', exarchosSubdir);
  }

  return path.join(os.homedir(), '.exarchos', exarchosSubdir);
}

/**
 * Resolve the workflow state directory.
 * Env: `WORKFLOW_STATE_DIR` | Claude: `~/.claude/workflow-state` | Default: `~/.exarchos/state`
 */
export function resolveStateDir(): string {
  return resolveDir('WORKFLOW_STATE_DIR', 'workflow-state', 'state');
}

/**
 * Resolve the teams directory.
 * Env: `EXARCHOS_TEAMS_DIR` | Claude: `~/.claude/teams` | Default: `~/.exarchos/teams`
 */
export function resolveTeamsDir(): string {
  return resolveDir('EXARCHOS_TEAMS_DIR', 'teams', 'teams');
}

/**
 * Resolve the tasks directory.
 * Env: `EXARCHOS_TASKS_DIR` | Claude: `~/.claude/tasks` | Default: `~/.exarchos/tasks`
 */
export function resolveTasksDir(): string {
  return resolveDir('EXARCHOS_TASKS_DIR', 'tasks', 'tasks');
}

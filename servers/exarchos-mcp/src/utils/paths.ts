import os from 'node:os';
import path from 'node:path';

/**
 * Normalize a path's separators to POSIX forward-slashes (#1620).
 *
 * These resolvers produce paths that are **stored and compared** (the state /
 * teams / tasks directories used as keys and surfaced to consumers), so they
 * must be byte-identical across platforms. `path.join` emits OS-native
 * separators (backslashes on Windows), which breaks string equality against
 * the posix form used everywhere else. Node's `fs` accepts `/` on Windows, so
 * normalizing the *stored* representation is safe — the filesystem layer is
 * happy either way.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Expand a leading `~` to the user's home directory.
 * Node.js `fs` does not perform shell-style tilde expansion,
 * so paths like `~/.claude/workflow-state` must be expanded manually.
 *
 * The expanded result is POSIX-normalized (see {@link toPosix}).
 */
export function expandTilde(p: string): string {
  if (p === '~') return toPosix(os.homedir());
  if (p.startsWith('~/')) return toPosix(path.join(os.homedir(), p.slice(2)));
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
    return toPosix(expandTilde(envValue));
  }

  if (isClaudeCodePlugin()) {
    return toPosix(path.join(os.homedir(), '.claude', claudeSubdir));
  }

  const xdgStateHome = process.env['XDG_STATE_HOME'];
  if (xdgStateHome) {
    return toPosix(path.join(xdgStateHome, 'exarchos', exarchosSubdir));
  }

  return toPosix(path.join(os.homedir(), '.exarchos', exarchosSubdir));
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

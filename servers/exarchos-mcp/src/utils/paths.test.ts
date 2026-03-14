import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import { expandTilde, isClaudeCodePlugin, resolveStateDir, resolveTeamsDir, resolveTasksDir } from './paths.js';

describe('expandTilde', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expands leading tilde to home directory', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    expect(expandTilde('~/.claude/workflow-state')).toBe('/home/testuser/.claude/workflow-state');
  });

  it('expands bare tilde to home directory', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    expect(expandTilde('~')).toBe('/home/testuser');
  });

  it('returns absolute paths unchanged', () => {
    expect(expandTilde('/usr/local/bin')).toBe('/usr/local/bin');
  });

  it('returns relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path');
  });

  it('does not expand tilde in middle of path', () => {
    expect(expandTilde('/some/~/path')).toBe('/some/~/path');
  });

  it('returns empty string unchanged', () => {
    expect(expandTilde('')).toBe('');
  });
});

describe('isClaudeCodePlugin', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns true when CLAUDE_PLUGIN_ROOT is set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/path');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    expect(isClaudeCodePlugin()).toBe(true);
  });

  it('returns true when EXARCHOS_PLUGIN_ROOT is set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '/some/path');
    expect(isClaudeCodePlugin()).toBe(true);
  });

  it('returns false when no plugin root is set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    expect(isClaudeCodePlugin()).toBe(false);
  });
});

describe('resolveStateDir', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    // Clear all env vars that could affect resolution
    vi.stubEnv('WORKFLOW_STATE_DIR', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    vi.stubEnv('XDG_STATE_HOME', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns expanded env value when WORKFLOW_STATE_DIR is set', () => {
    vi.stubEnv('WORKFLOW_STATE_DIR', '/custom/state');
    expect(resolveStateDir()).toBe('/custom/state');
  });

  it('expands tilde when WORKFLOW_STATE_DIR contains tilde', () => {
    vi.stubEnv('WORKFLOW_STATE_DIR', '~/my-state');
    expect(resolveStateDir()).toBe('/home/testuser/my-state');
  });

  it('returns Claude path when CLAUDE_PLUGIN_ROOT is set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/path');
    expect(resolveStateDir()).toBe('/home/testuser/.claude/workflow-state');
  });

  it('returns XDG path when XDG_STATE_HOME is set', () => {
    vi.stubEnv('XDG_STATE_HOME', '/home/testuser/.local/state');
    expect(resolveStateDir()).toBe('/home/testuser/.local/state/exarchos/state');
  });

  it('returns universal default when no env vars are set', () => {
    expect(resolveStateDir()).toBe('/home/testuser/.exarchos/state');
  });

  it('prefers env var over plugin root', () => {
    vi.stubEnv('WORKFLOW_STATE_DIR', '/custom/state');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/path');
    expect(resolveStateDir()).toBe('/custom/state');
  });
});

describe('resolveTeamsDir', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    vi.stubEnv('EXARCHOS_TEAMS_DIR', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    vi.stubEnv('XDG_STATE_HOME', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns env value when EXARCHOS_TEAMS_DIR is set', () => {
    vi.stubEnv('EXARCHOS_TEAMS_DIR', '/custom/teams');
    expect(resolveTeamsDir()).toBe('/custom/teams');
  });

  it('returns Claude path when CLAUDE_PLUGIN_ROOT is set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/path');
    expect(resolveTeamsDir()).toBe('/home/testuser/.claude/teams');
  });

  it('returns default fallback when no env vars set', () => {
    expect(resolveTeamsDir()).toBe('/home/testuser/.exarchos/teams');
  });
});

describe('resolveTasksDir', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    vi.stubEnv('EXARCHOS_TASKS_DIR', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    vi.stubEnv('XDG_STATE_HOME', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns env value when EXARCHOS_TASKS_DIR is set', () => {
    vi.stubEnv('EXARCHOS_TASKS_DIR', '/custom/tasks');
    expect(resolveTasksDir()).toBe('/custom/tasks');
  });

  it('returns Claude path when CLAUDE_PLUGIN_ROOT is set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/path');
    expect(resolveTasksDir()).toBe('/home/testuser/.claude/tasks');
  });

  it('returns default fallback when no env vars set', () => {
    expect(resolveTasksDir()).toBe('/home/testuser/.exarchos/tasks');
  });
});


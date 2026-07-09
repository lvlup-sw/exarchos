import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expandTilde, isClaudeCodePlugin, resolveStateDir, resolveTeamsDir, resolveTasksDir, deriveRepoKey } from './paths.js';

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

  it('returns Claude path when EXARCHOS_PLUGIN_ROOT is set', () => {
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '/some/path');
    expect(resolveTeamsDir()).toBe('/home/testuser/.claude/teams');
  });

  it('returns XDG path when XDG_STATE_HOME is set', () => {
    vi.stubEnv('XDG_STATE_HOME', '/home/testuser/.local/state');
    expect(resolveTeamsDir()).toBe('/home/testuser/.local/state/exarchos/teams');
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

  it('returns Claude path when EXARCHOS_PLUGIN_ROOT is set', () => {
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '/some/path');
    expect(resolveTasksDir()).toBe('/home/testuser/.claude/tasks');
  });

  it('returns XDG path when XDG_STATE_HOME is set', () => {
    vi.stubEnv('XDG_STATE_HOME', '/home/testuser/.local/state');
    expect(resolveTasksDir()).toBe('/home/testuser/.local/state/exarchos/tasks');
  });

  it('returns default fallback when no env vars set', () => {
    expect(resolveTasksDir()).toBe('/home/testuser/.exarchos/tasks');
  });
});

// ─── deriveRepoKey (DR-5) ────────────────────────────────────────────────────
//
// Git-spawning cases carry an explicit ≥15s per-test timeout — vitest's 5s
// default flakes for subprocess-spawning tests under CI load (repo memory).

describe('deriveRepoKey', () => {
  it('DeriveRepoKey_WorktreePath_MatchesMainCheckoutKey', () => {
    const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drk-main-'));
    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'drk-wt-'));
    const wtPath = path.join(wtParent, 'linked');
    const git = (args: string[]) =>
      execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      git(['init', '-q', mainRoot]);
      git(['-C', mainRoot, 'config', 'user.email', 'test@example.com']);
      git(['-C', mainRoot, 'config', 'user.name', 'Test']);
      git(['-C', mainRoot, 'commit', '-q', '--allow-empty', '-m', 'init']);
      git(['-C', mainRoot, 'worktree', 'add', '-q', wtPath]);

      const mainKey = deriveRepoKey(mainRoot);
      const worktreeKey = deriveRepoKey(wtPath);

      // A linked worktree resolves to the SAME identity as the main checkout —
      // the whole point of keying on --git-common-dir rather than the worktree
      // root. Both are absolute, POSIX-separated.
      expect(worktreeKey).toBe(mainKey);
      expect(worktreeKey.startsWith('/')).toBe(true);
      expect(worktreeKey).not.toContain('\\');
    } finally {
      fs.rmSync(mainRoot, { recursive: true, force: true });
      fs.rmSync(wtParent, { recursive: true, force: true });
    }
  }, 20000);

  it('DeriveRepoKey_NonGitPath_FallsBackToNormalizedPath', () => {
    // A temp dir outside any git repository: the git spawn exits non-zero, so we
    // fall back to the canonicalized input path.
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'drk-nongit-'));
    try {
      const key = deriveRepoKey(nonGit);
      // Equals the realpath'd input (canonicalized: macOS /var → /private/var,
      // no-op on Linux), POSIX-separated, never mangled to a git root.
      expect(key).toBe(fs.realpathSync.native(nonGit).replace(/\\/g, '/'));
      expect(key).not.toContain('\\');
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  }, 20000);

  it('DeriveRepoKey_WindowsSeparators_ReturnsPosix', () => {
    // A win32-form input on the POSIX CI host: force the non-git fallback and an
    // identity realpath so the assertion is deterministic off Windows. The key
    // MUST come back separator-normalized to POSIX (#1620).
    const key = deriveRepoKey('C:\\Users\\dev\\my-repo', {
      gitCommonDir: () => {
        throw new Error('not a git repo');
      },
      realpath: (p) => p,
    });
    expect(key).toBe('C:/Users/dev/my-repo');
    expect(key).not.toContain('\\');
  });

  it('DeriveRepoKey_RepeatedCall_UsesMemo', () => {
    // The git subprocess is invoked at most ONCE across repeated calls for one
    // input path — steady-state pipeline calls pay a map lookup, not a spawn.
    let spawnCount = 0;
    const uniquePath = `/tmp/drk-memo-probe-${Math.random().toString(36).slice(2)}`;
    const deps = {
      gitCommonDir: (_cwd: string) => {
        spawnCount += 1;
        return '/canonical/repo/.git';
      },
      realpath: (p: string) => p,
    };

    const first = deriveRepoKey(uniquePath, deps);
    const second = deriveRepoKey(uniquePath, deps);

    expect(spawnCount).toBe(1);
    expect(first).toBe('/canonical/repo');
    expect(second).toBe(first);
  });
});


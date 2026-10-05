import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';
import { expandTilde, isClaudeCodePlugin, resolveStateDir, resolveTeamsDir, resolveTasksDir, resolveCacheDir, deriveRepoKey, resetRepoKeyMemo, resolveStorePath, computeStorePathDivergence, STORE_DB_FILENAME } from '../../../src/utils/paths.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

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

  /** A leading `~` in `XDG_STATE_HOME` must not give a path relative to the cwd. */
  it('expands tilde when XDG_STATE_HOME contains tilde', () => {
    vi.stubEnv('XDG_STATE_HOME', '~/state');
    expect(resolveStateDir()).toBe('/home/testuser/state/exarchos/state');
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

describe('resolveCacheDir', () => {
  beforeEach(() => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    vi.stubEnv('EXARCHOS_CACHE_DIR', '');
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '');
    vi.stubEnv('EXARCHOS_PLUGIN_ROOT', '');
    vi.stubEnv('XDG_STATE_HOME', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns env value when EXARCHOS_CACHE_DIR is set', () => {
    vi.stubEnv('EXARCHOS_CACHE_DIR', '/custom/cache');
    expect(resolveCacheDir()).toBe('/custom/cache');
  });

  it('returns Claude path when CLAUDE_PLUGIN_ROOT is set', () => {
    vi.stubEnv('CLAUDE_PLUGIN_ROOT', '/some/path');
    expect(resolveCacheDir()).toBe('/home/testuser/.claude/cache');
  });

  it('returns default fallback when no env vars set', () => {
    expect(resolveCacheDir()).toBe('/home/testuser/.exarchos/cache');
  });

  it('honors injected env/homedir seams (DR-11)', () => {
    expect(
      resolveCacheDir({ env: {}, homedir: '/injected/home', pluginMode: false }),
    ).toBe('/injected/home/.exarchos/cache');
  });
});

/**
 * The cases that can spawn git carry a 20000 ms timeout.
 * The 5 s default of vitest is too short for a subprocess under CI load.
 */
describe('deriveRepoKey', () => {
  /**
   * The memo key is the input path alone.
   * Without the reset, a path that two tests use with different `deps` gives a stale hit.
   */
  beforeEach(() => resetRepoKeyMemo());

  /**
   * A linked worktree gets the key of the main checkout, because the key comes from
   * `--git-common-dir`. The key is absolute with POSIX separators: it starts with `/`
   * on POSIX, or with a drive root such as `C:/` on Windows.
   */
  it('DeriveRepoKey_WorktreePath_MatchesMainCheckoutKey', async () => {
    const mainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'drk-main-'));
    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'drk-wt-'));
    const wtPath = path.join(wtParent, 'linked');
    const git = (args: string[]) => execFileAsync('git', args);
    try {
      await git(['init', '-q', mainRoot]);
      await git(['-C', mainRoot, 'config', 'user.email', 'test@example.com']);
      await git(['-C', mainRoot, 'config', 'user.name', 'Test']);
      await git(['-C', mainRoot, 'commit', '-q', '--allow-empty', '-m', 'init']);
      await git(['-C', mainRoot, 'worktree', 'add', '-q', wtPath]);

      const mainKey = deriveRepoKey(mainRoot);
      const worktreeKey = deriveRepoKey(wtPath);

      expect(worktreeKey).toBe(mainKey);
      expect(worktreeKey).toMatch(/^(\/|[A-Za-z]:\/)/);
      expect(worktreeKey).not.toContain('\\');
    } finally {
      rmrf(mainRoot);
      rmrf(wtParent);
    }
  }, 20000);

  /**
   * The test assumes that the temp dir is outside a git repository. Then the git spawn
   * fails, and the key is the real path of the input with POSIX separators.
   */
  it('DeriveRepoKey_NonGitPath_FallsBackToNormalizedPath', () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'drk-nongit-'));
    try {
      const key = deriveRepoKey(nonGit);
      expect(key).toBe(fs.realpathSync.native(nonGit).replace(/\\/g, '/'));
      expect(key).not.toContain('\\');
    } finally {
      rmrf(nonGit);
    }
  }, 20000);

  /**
   * The injected `gitCommonDir` throws and the injected `realpath` is the identity.
   * So the result for a win32 input is deterministic on a POSIX host.
   */
  it('DeriveRepoKey_WindowsSeparators_ReturnsPosix', () => {
    const key = deriveRepoKey('C:\\Users\\dev\\my-repo', {
      gitCommonDir: () => {
        throw new Error('not a git repo');
      },
      realpath: (p) => p,
    });
    expect(key).toBe('C:/Users/dev/my-repo');
    expect(key).not.toContain('\\');
  });

  /** The common dir of a non-bare repo ends in `.git`, so the key is its parent directory. */
  it('DeriveRepoKey_NonBareRepo_UsesDirnameOfDotGit', () => {
    const key = deriveRepoKey('/whatever', {
      gitCommonDir: () => '/home/dev/my-repo/.git',
      realpath: (p) => p,
    });
    expect(key).toBe('/home/dev/my-repo');
  });

  /**
   * A bare repo reports its own root, and the basename of that root is not `.git`.
   * So the key is the common dir itself, not its parent.
   */
  it('DeriveRepoKey_BareRepo_UsesCommonDirVerbatim', () => {
    const key = deriveRepoKey('/whatever', {
      gitCommonDir: () => '/srv/repos/thing.git',
      realpath: (p) => p,
    });
    expect(key).toBe('/srv/repos/thing.git');
  });

  /** Repeated calls for one input path call `gitCommonDir` one time. */
  it('DeriveRepoKey_RepeatedCall_UsesMemo', () => {
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

  /**
   * A client can supply `repoRoot`, so the memo is a bounded FIFO.
   * `MEMO_CAP` mirrors `REPO_KEY_MEMO_MAX` in `paths.ts`. One key more than the cap
   * evicts the oldest key and keeps the newest. Each distinct key costs one spawn,
   * and the keys carry the PID, so they do not collide with the keys of other tests.
   */
  it('DeriveRepoKey_MemoBounded_EvictsOldestBeyondCap', () => {
    const MEMO_CAP = 500;
    let spawns = 0;
    const deps = {
      gitCommonDir: (_cwd: string) => {
        spawns += 1;
        return '/canonical/repo/.git';
      },
      realpath: (p: string) => p,
    };
    const key = (i: number) => `/tmp/drk-evict-${process.pid}-${i}`;

    for (let i = 0; i <= MEMO_CAP; i++) deriveRepoKey(key(i), deps);
    expect(spawns).toBe(MEMO_CAP + 1);

    deriveRepoKey(key(MEMO_CAP), deps);
    expect(spawns).toBe(MEMO_CAP + 1);

    deriveRepoKey(key(0), deps);
    expect(spawns).toBe(MEMO_CAP + 2);
  });
});

/**
 * The CLI entry and the plugin MCP server must resolve the event store through one resolver.
 * The tests inject `env`, `homedir` and `pluginMode`, so they read neither `process.env`
 * nor the real home.
 */
describe('resolveStorePath (shared CLI/plugin resolver)', () => {
  const HOME = '/home/testuser';

  it('composes the state-dir cascade with the single-source-of-truth filename', () => {
    expect(STORE_DB_FILENAME).toBe('exarchos.db');
    const p = resolveStorePath({ env: {}, homedir: HOME, pluginMode: false });
    expect(p).toBe(`${HOME}/.exarchos/state/${STORE_DB_FILENAME}`);
    expect(p).toBe(
      `${resolveStateDir({ env: {}, homedir: HOME, pluginMode: false })}/${STORE_DB_FILENAME}`,
    );
  });

  /**
   * `WORKFLOW_STATE_DIR` wins in both modes, so it pins the CLI and the plugin to one store.
   * The last assertion compares the two modes for a pinned directory with a leading `~`.
   */
  it('storePathResolution_CliAndPlugin_ResolveSameDefault', () => {
    const env = { WORKFLOW_STATE_DIR: '/srv/shared-state' };
    const cli = resolveStorePath({ env, homedir: HOME, pluginMode: false });
    const plugin = resolveStorePath({ env, homedir: HOME, pluginMode: true });
    expect(cli).toBe(plugin);
    expect(cli).toBe(`/srv/shared-state/${STORE_DB_FILENAME}`);

    const tildeEnv = { WORKFLOW_STATE_DIR: '~/shared-state' };
    expect(resolveStorePath({ env: tildeEnv, homedir: HOME, pluginMode: false })).toBe(
      resolveStorePath({ env: tildeEnv, homedir: HOME, pluginMode: true }),
    );
  });
});

describe('computeStorePathDivergence (DR-11 B-5 detection core)', () => {
  const HOME = '/home/testuser';

  it('reports divergence when no env override pins the two surfaces', () => {
    const d = computeStorePathDivergence({ env: {}, homedir: HOME });
    expect(d.diverges).toBe(true);
    expect(d.cliPath).toBe(`${HOME}/.exarchos/state/${STORE_DB_FILENAME}`);
    expect(d.pluginPath).toBe(`${HOME}/.claude/workflow-state/${STORE_DB_FILENAME}`);
  });

  it('reports NO divergence when WORKFLOW_STATE_DIR unifies both surfaces', () => {
    const d = computeStorePathDivergence({
      env: { WORKFLOW_STATE_DIR: '/srv/shared-state' },
      homedir: HOME,
    });
    expect(d.diverges).toBe(false);
    expect(d.cliPath).toBe(d.pluginPath);
  });
});


import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommandSync } from './process.js';

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

// ─── Repo identity (DR-5) ───────────────────────────────────────────────────

/**
 * Injectable seams for {@link deriveRepoKey} (defaults → real git spawn +
 * `fs.realpathSync.native`). Injected so the git-common-root and normalization
 * branches are unit-testable on the POSIX CI host without touching git or the
 * real filesystem, and so the memoization can be exercised with a call counter.
 */
export interface DeriveRepoKeyDeps {
  /**
   * Resolve the absolute git *common* dir for `cwd` — `git rev-parse
   * --path-format=absolute --git-common-dir`. Returns the *common* dir (never
   * `--git-dir` / `--show-toplevel`) so every linked worktree of one repository
   * points at the MAIN checkout's git dir and collapses to a single identity.
   * MUST throw when `cwd` is not inside a git repository (→ input-path fallback).
   */
  readonly gitCommonDir?: (cwd: string) => string;
  /** Canonicalize (symlink- + Windows-8.3-resolve) a path. Default: `fs.realpathSync.native`. */
  readonly realpath?: (p: string) => string;
}

/**
 * Per-input-path memo of derived repo keys (Technical Design: hot-path git
 * spawn). The long-lived server process derives its own cwd key exactly once;
 * every steady-state pipeline call thereafter pays a map lookup, never a
 * subprocess. Keyed by the RAW input path (distinct worktree paths of one repo
 * are separate entries that each spawn once and resolve to the same key).
 *
 * Bounded FIFO (cap {@link REPO_KEY_MEMO_MAX}): `deriveRepoKey(args.repoRoot)`
 * is reachable from a client-supplied `repoRoot` (see `handleViewPipeline`), so
 * an unbounded map would grow for the process lifetime under many distinct
 * inputs. Eviction is oldest-first — the process cwd is derived first and thus
 * evicted last, keeping the steady-state hot path a lookup.
 */
const REPO_KEY_MEMO_MAX = 500;
const repoKeyMemo = new Map<string, string>();

/** Insert a memo entry, evicting the oldest key once the cap is exceeded. */
function memoSet(inputPath: string, key: string): void {
  repoKeyMemo.set(inputPath, key);
  if (repoKeyMemo.size > REPO_KEY_MEMO_MAX) {
    const oldest = repoKeyMemo.keys().next().value;
    if (oldest !== undefined) repoKeyMemo.delete(oldest);
  }
}

/**
 * Cap the synchronous git spawn (ms). `deriveRepoKey` is reachable with a
 * client-supplied `repoRoot`, so an unbounded blocking spawn on a hung/slow
 * filesystem (network mount, lock contention) would stall the event loop for
 * every concurrent request. On timeout `execFileSync` throws → `deriveRepoKey`
 * degrades to the input-path fallback, exactly as for a non-git directory.
 */
const GIT_COMMON_DIR_TIMEOUT_MS = 5000;

/** Default git-common-dir resolver — routed through the shared command-runner. */
function defaultGitCommonDir(cwd: string): string {
  // Spawn via `runCommandSync` (the #1623 Windows dynamic-spawn rule), NEVER a
  // raw `execFileSync`, so a `.cmd`/`.bat` `git` shim launches correctly on
  // win32. `--path-format=absolute` guarantees an absolute path even when git
  // would otherwise return one relative to `cwd`.
  const out = runCommandSync(
    'git',
    ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_COMMON_DIR_TIMEOUT_MS,
    },
  );
  return String(out).trim();
}

/** Default canonicalizer — `.native` so Windows 8.3 SHORT names expand (#1620). */
function defaultNativeRealpath(p: string): string {
  // `.native` (not the JS `fs.realpathSync`) expands `RUNNER~1` → `runneradmin`
  // so a test-constructed key and a git-derived key agree in the username
  // segment on win32 CI. No-op on POSIX. Inlined here (rather than importing the
  // shared `defaultRealpath`) to avoid a `paths.ts` ↔ `path-containment.ts`
  // import cycle — that module already imports `toPosix` from here.
  return fs.realpathSync.native(p);
}

/**
 * Reduce a path to an absolute, symlink-/8.3-resolved, POSIX-separator form.
 *
 * Separator-agnostic (mirrors the launcher canonicalizer, #1620): a win32
 * `C:\…` input is normalized in place instead of being mangled by a POSIX
 * `path.resolve` on the CI host, so the Windows-form contract is testable off
 * Windows. A realpath failure (e.g. a not-yet-existing input-path fallback)
 * degrades to the absolute, un-canonicalized form rather than throwing.
 */
function normalizeRepoPath(p: string, realpath: (x: string) => string): string {
  const posix = toPosix(p);
  let absolute: string;
  if (path.posix.isAbsolute(posix)) {
    absolute = path.posix.normalize(posix);
  } else if (path.win32.isAbsolute(p)) {
    absolute = toPosix(path.win32.normalize(p));
  } else {
    absolute = toPosix(path.resolve(p));
  }
  try {
    return toPosix(realpath(absolute));
  } catch {
    return absolute;
  }
}

/**
 * Derive a stable repository identity key for `inputPath` (DR-5).
 *
 * Resolves the git *common* root (dirname of `--git-common-dir`) so the main
 * checkout and every linked worktree of one repository collapse to a SINGLE
 * key; outside a git repository, falls back to the canonicalized input path.
 * The result is POSIX-normalized (#1620) and MEMOIZED per input path — the
 * long-lived server process pays the git subprocess exactly once for its own
 * cwd, then only a map lookup (Technical Design: hot-path git spawn).
 */
export function deriveRepoKey(inputPath: string, deps: DeriveRepoKeyDeps = {}): string {
  const memoized = repoKeyMemo.get(inputPath);
  if (memoized !== undefined) return memoized;

  const gitCommonDir = deps.gitCommonDir ?? defaultGitCommonDir;
  const realpath = deps.realpath ?? defaultNativeRealpath;

  let key: string;
  try {
    const commonDir = gitCommonDir(inputPath);
    // dirname of `<repo>/.git` (the common dir a linked worktree also reports)
    // → the shared repo root.
    key = normalizeRepoPath(path.dirname(commonDir), realpath);
  } catch {
    // Not a git repository (or git unavailable): fall back to the canonicalized
    // input path so a non-git working directory still gets a stable identity.
    key = normalizeRepoPath(inputPath, realpath);
  }

  memoSet(inputPath, key);
  return key;
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

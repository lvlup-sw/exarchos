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
 * Clear the repo-key memo. Test-only isolation seam (mirrors the view layer's
 * `resetMaterializerCache`): the memo is keyed by `inputPath` alone, so two
 * tests reusing one path with *different* injected `deps` would otherwise see a
 * stale cross-test cache hit. Production never varies `deps`, so this is never
 * needed at runtime.
 */
export function resetRepoKeyMemo(): void {
  repoKeyMemo.clear();
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
    // A non-bare repo (and every linked worktree of it) reports `<repo>/.git`, so
    // the shared repo root is its dirname. A BARE repo reports its own root
    // (`<repo>.git`, basename ≠ `.git`); applying dirname there would wrongly
    // climb to the parent, so use the common dir verbatim. Guarding on the
    // `.git` basename handles both without a second git spawn.
    const root =
      path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    key = normalizeRepoPath(root, realpath);
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
 * `home` is injectable (default `os.homedir()`) so the DR-11 store-path
 * resolvers can compute deterministic paths without touching the real home
 * directory; production leaves it unset.
 *
 * The expanded result is POSIX-normalized (see {@link toPosix}).
 */
export function expandTilde(p: string, home: string = os.homedir()): string {
  if (p === '~') return toPosix(home);
  if (p.startsWith('~/')) return toPosix(path.join(home, p.slice(2)));
  return p;
}

/**
 * Returns true if running as a Claude Code plugin (detected via
 * `CLAUDE_PLUGIN_ROOT` or `EXARCHOS_PLUGIN_ROOT` env vars).
 *
 * `env` is injectable (default live `process.env`) so the DR-11 divergence
 * check can evaluate the plugin-mode signal over an explicit snapshot.
 */
export function isClaudeCodePlugin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !!(env['CLAUDE_PLUGIN_ROOT'] || env['EXARCHOS_PLUGIN_ROOT']);
}

/**
 * Injectable inputs steering state-dir / store-path resolution (DR-11 B-5).
 *
 * Production leaves every field unset — resolution reads the live
 * `process.env`, the real home directory, and the live plugin-mode signal, so
 * the CLI entry and the plugin MCP server share ONE resolver. The `doctor`
 * divergence check (`store-path-divergence`) injects `env`/`pluginMode`/`homedir`
 * to compute what the CLI surface and the plugin surface WOULD each resolve on
 * this machine, deterministically and without mutating `process.env`.
 */
export interface StorePathResolutionInputs {
  /** Environment snapshot. Default: live `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Claude Code plugin mode. Default: {@link isClaudeCodePlugin} over `env`. */
  readonly pluginMode?: boolean;
  /** Home directory. Default: `os.homedir()`. */
  readonly homedir?: string;
}

/**
 * Resolve a directory path using the 4-level cascade:
 *   1. Explicit env var (always wins)
 *   2. Claude Code plugin mode → `~/.claude/<claudeSubdir>`
 *   3. `XDG_STATE_HOME` → `$XDG_STATE_HOME/exarchos/<exarchosSubdir>`
 *   4. Universal default → `~/.exarchos/<exarchosSubdir>`
 *
 * `expandTilde()` is applied to explicit env var values. `inputs` are the DR-11
 * injectable seams (defaulting to live process state) so callers never diverge
 * on the cascade — there is exactly one implementation of the precedence.
 */
function resolveDir(
  envKey: string,
  claudeSubdir: string,
  exarchosSubdir: string,
  inputs: StorePathResolutionInputs = {},
): string {
  const env = inputs.env ?? process.env;
  const home = inputs.homedir ?? os.homedir();
  const pluginMode = inputs.pluginMode ?? isClaudeCodePlugin(env);

  const envValue = env[envKey];
  if (envValue) {
    return toPosix(expandTilde(envValue, home));
  }

  if (pluginMode) {
    return toPosix(path.join(home, '.claude', claudeSubdir));
  }

  const xdgStateHome = env['XDG_STATE_HOME'];
  if (xdgStateHome) {
    // Expand a leading `~` here too — otherwise `XDG_STATE_HOME=~/state` opens
    // the store at a cwd-relative path, diverging from the env-value branch
    // above (which applies expandTilde) and from WORKFLOW_STATE_DIR.
    return toPosix(path.join(expandTilde(xdgStateHome, home), 'exarchos', exarchosSubdir));
  }

  return toPosix(path.join(home, '.exarchos', exarchosSubdir));
}

/**
 * Resolve the workflow state directory.
 * Env: `WORKFLOW_STATE_DIR` | Claude: `~/.claude/workflow-state` | Default: `~/.exarchos/state`
 *
 * `inputs` are the DR-11 injectable seams; production calls this zero-arg.
 */
export function resolveStateDir(inputs?: StorePathResolutionInputs): string {
  return resolveDir('WORKFLOW_STATE_DIR', 'workflow-state', 'state', inputs);
}

/**
 * Canonical event-store SQLite filename — the single source of truth for the
 * leaf DB name (DR-11 B-5). Previously the string literal `'exarchos.db'` was
 * duplicated in `index.ts:initializeBackend` and
 * `atomic-appender.ts` (the lazily-constructed backend), kept in sync only by a
 * hand-maintained code comment. Both now import this constant so the two
 * computations cannot drift.
 */
export const STORE_DB_FILENAME = 'exarchos.db';

/**
 * Resolve the absolute event-store database path — the ONE resolver the CLI and
 * plugin MCP surfaces share (DR-11 B-5). Composes the state-dir cascade
 * ({@link resolveStateDir}) with {@link STORE_DB_FILENAME}, so a change to the
 * directory precedence OR the filename lands in exactly one place.
 *
 * Documented precedence (identical on both surfaces): `WORKFLOW_STATE_DIR` env
 * var > Claude-plugin default (`~/.claude/workflow-state`) > `XDG_STATE_HOME`
 * (`$XDG_STATE_HOME/exarchos/state`) > universal default (`~/.exarchos/state`).
 * Because the env var wins in BOTH plugin and non-plugin mode, setting it pins
 * the CLI and the plugin to one store.
 */
export function resolveStorePath(inputs?: StorePathResolutionInputs): string {
  return toPosix(path.join(resolveStateDir(inputs), STORE_DB_FILENAME));
}

/** The CLI-vs-plugin store-path comparison surfaced by the `store-path-divergence` doctor check (DR-11 B-5). */
export interface StorePathDivergence {
  /** Store path the CLI surface (non-plugin) resolves. */
  readonly cliPath: string;
  /** Store path the Claude Code plugin surface resolves. */
  readonly pluginPath: string;
  /** True when the two surfaces resolve DIFFERENT stores (state silently splits). */
  readonly diverges: boolean;
}

/**
 * Compute what the event store resolves to under the CLI surface (non-plugin)
 * vs the Claude Code plugin surface, holding `env` + `homedir` fixed, and report
 * whether they differ (DR-11 B-5).
 *
 * Both surfaces run the SAME {@link resolveStorePath}; they can only diverge on
 * the `pluginMode` branch of the cascade. When they DO differ, workflow state
 * written by one surface is invisible to the other — the defect the
 * `store-path-divergence` doctor check reports. Setting `WORKFLOW_STATE_DIR`
 * collapses the divergence (the env var wins in both modes).
 */
export function computeStorePathDivergence(
  inputs?: Omit<StorePathResolutionInputs, 'pluginMode'>,
): StorePathDivergence {
  const cliPath = resolveStorePath({ ...inputs, pluginMode: false });
  const pluginPath = resolveStorePath({ ...inputs, pluginMode: true });
  return { cliPath, pluginPath, diverges: cliPath !== pluginPath };
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

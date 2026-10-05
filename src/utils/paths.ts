import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommandSync } from './process.js';

/**
 * Convert path separators to POSIX forward slashes.
 *
 * Callers store and compare the paths that this module resolves, so the paths
 * must be identical on every platform. `path.join` emits backslashes on Windows.
 * Node `fs` accepts `/` on Windows, so this form is safe for file access.
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Injectable seams for {@link deriveRepoKey}. The defaults spawn git and call
 * `fs.realpathSync.native`. Tests inject them to cover each branch on a POSIX
 * host without git, and to count calls for the memo.
 */
export interface DeriveRepoKeyDeps {
  /**
   * Returns the absolute git common dir for `cwd`, from `git rev-parse
   * --git-common-dir`. All linked worktrees of one repository share this dir,
   * so they get one key. It must throw when `cwd` is not inside a git repository.
   */
  readonly gitCommonDir?: (cwd: string) => string;
  /** Resolves symlinks and Windows 8.3 short names. Default: `fs.realpathSync.native`. */
  readonly realpath?: (p: string) => string;
}

/**
 * Maximum entries in the repo-key memo. A client can supply `repoRoot` (see
 * `handleViewPipeline`), so an unbounded memo can grow for the life of the process.
 */
const REPO_KEY_MEMO_MAX = 500;
/**
 * Memo of derived repo keys, keyed by the raw input path. Later calls for one path
 * cost a map lookup, not a git spawn. Eviction is oldest-first.
 */
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
 * Clear the repo-key memo. Only tests call this. The memo key is the input path
 * alone, so two tests that use one path with different `deps` can get a stale hit.
 */
export function resetRepoKeyMemo(): void {
  repoKeyMemo.clear();
}

/**
 * Timeout in ms for the synchronous git spawn. A client can supply the path, and
 * a hung spawn on a slow filesystem blocks the event loop for every request. On
 * timeout the spawn throws, and {@link deriveRepoKey} falls back to the input path.
 */
const GIT_COMMON_DIR_TIMEOUT_MS = 5000;

/**
 * Default resolver for the git common dir. It spawns git through the shared
 * `runCommandSync`. `--path-format=absolute` makes git return an absolute path,
 * not a path relative to `cwd`.
 */
function defaultGitCommonDir(cwd: string): string {
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

/**
 * Default canonicalizer. `fs.realpathSync.native` expands Windows 8.3 short names
 * (`RUNNER~1` to `runneradmin`), so test keys and git keys agree on win32.
 * It does not use the shared `defaultRealpath`, because `path-containment.ts`
 * imports {@link toPosix} from this module and that import makes a cycle.
 */
function defaultNativeRealpath(p: string): string {
  return fs.realpathSync.native(p);
}

/**
 * Reduce a path to an absolute, canonical form with POSIX separators.
 *
 * The function normalizes a win32 `C:\…` input with `path.win32`, so the Windows
 * contract is testable on a POSIX host. When `realpath` fails, for example on a path that
 * does not exist yet, the function returns the absolute form and does not throw.
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
 * Derive a stable repository identity key for `inputPath`.
 *
 * The key is the git common root, so the main checkout and its linked worktrees
 * share one key. A bare repository reports its own root as the common dir. Thus
 * the function takes the parent only when the common dir is named `.git`.
 * Outside a git repository, the key is the canonical input path. Keys use POSIX
 * separators and are memoized per input path.
 */
export function deriveRepoKey(inputPath: string, deps: DeriveRepoKeyDeps = {}): string {
  const memoized = repoKeyMemo.get(inputPath);
  if (memoized !== undefined) return memoized;

  const gitCommonDir = deps.gitCommonDir ?? defaultGitCommonDir;
  const realpath = deps.realpath ?? defaultNativeRealpath;

  let key: string;
  try {
    const commonDir = gitCommonDir(inputPath);
    const root =
      path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
    key = normalizeRepoPath(root, realpath);
  } catch {
    key = normalizeRepoPath(inputPath, realpath);
  }

  memoSet(inputPath, key);
  return key;
}

/**
 * Expand a leading `~` to the home directory, because Node `fs` does not expand it.
 * `home` defaults to `os.homedir()`, and tests inject a fixed value. An expanded
 * result uses POSIX separators. Other paths return unchanged.
 */
export function expandTilde(p: string, home: string = os.homedir()): string {
  if (p === '~') return toPosix(home);
  if (p.startsWith('~/')) return toPosix(path.join(home, p.slice(2)));
  return p;
}

/**
 * True when the process runs as a Claude Code plugin, which `CLAUDE_PLUGIN_ROOT`
 * or `EXARCHOS_PLUGIN_ROOT` signals. `env` defaults to the live `process.env`.
 */
export function isClaudeCodePlugin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !!(env['CLAUDE_PLUGIN_ROOT'] || env['EXARCHOS_PLUGIN_ROOT']);
}

/**
 * Injectable inputs for state-dir and store-path resolution.
 *
 * Production leaves every field unset, so the CLI and the plugin MCP server share
 * one resolver over live process state. The `store-path-divergence` doctor check
 * injects them to compute the path that each surface resolves on this machine,
 * without changes to `process.env`.
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
 * Resolve a directory with this precedence:
 *   1. The explicit env var, with `~` expanded.
 *   2. Plugin mode: `~/.claude/<claudeSubdir>`.
 *   3. `XDG_STATE_HOME`: `$XDG_STATE_HOME/exarchos/<exarchosSubdir>`, with `~` expanded.
 *   4. Default: `~/.exarchos/<exarchosSubdir>`.
 *
 * Without the expansion, `XDG_STATE_HOME=~/state` opens a store relative to the cwd.
 * This is the only implementation of the precedence.
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
    return toPosix(path.join(expandTilde(xdgStateHome, home), 'exarchos', exarchosSubdir));
  }

  return toPosix(path.join(home, '.exarchos', exarchosSubdir));
}

/**
 * Resolve the workflow state directory.
 * Env: `WORKFLOW_STATE_DIR` | Claude: `~/.claude/workflow-state` | Default: `~/.exarchos/state`
 */
export function resolveStateDir(inputs?: StorePathResolutionInputs): string {
  return resolveDir('WORKFLOW_STATE_DIR', 'workflow-state', 'state', inputs);
}

/**
 * Event-store SQLite filename. `index.ts` and `atomic-appender.ts` both import it,
 * so their store paths cannot drift.
 */
export const STORE_DB_FILENAME = 'exarchos.db';

/**
 * Run-bundle directory name, under the same state directory as {@link STORE_DB_FILENAME}.
 * The bundle blobs and the ledger that references them must share a state directory.
 * Otherwise a store in one directory reports each digest written under the other as missing.
 */
export const RUN_BUNDLE_DIRNAME = 'run-bundles';

/**
 * Directory of evidence-artifact blobs under the state directory. A reference
 * carries no root. A blob read under the wrong root looks the same as a blob that
 * nobody wrote. The durable-evidence check must tell these cases apart, so one
 * constant names the directory.
 */
export const EVIDENCE_ARTIFACT_DIRNAME = 'admission-evidence';

/**
 * Resolve the absolute event-store database path. The CLI and the plugin MCP server
 * share this one resolver: the precedence of {@link resolveStateDir} plus
 * {@link STORE_DB_FILENAME}. `WORKFLOW_STATE_DIR` wins in plugin and non-plugin
 * mode, so setting it pins the CLI and the plugin to one store.
 */
export function resolveStorePath(inputs?: StorePathResolutionInputs): string {
  return toPosix(path.join(resolveStateDir(inputs), STORE_DB_FILENAME));
}

/** The store paths that the CLI and the plugin resolve, for the `store-path-divergence` doctor check. */
export interface StorePathDivergence {
  /** Store path the CLI surface (non-plugin) resolves. */
  readonly cliPath: string;
  /** Store path the Claude Code plugin surface resolves. */
  readonly pluginPath: string;
  /** True when the two surfaces resolve DIFFERENT stores (state silently splits). */
  readonly diverges: boolean;
}

/**
 * Resolve the store path for the CLI (non-plugin) and for the plugin with the same
 * `env` and `homedir`, and report whether they differ. They can differ only on the
 * plugin-mode branch. When they differ, one surface cannot see the workflow state
 * that the other writes. `WORKFLOW_STATE_DIR` removes the divergence.
 */
export function computeStorePathDivergence(
  inputs?: Omit<StorePathResolutionInputs, 'pluginMode'>,
): StorePathDivergence {
  const cliPath = resolveStorePath({ ...inputs, pluginMode: false });
  const pluginPath = resolveStorePath({ ...inputs, pluginMode: true });
  return { cliPath, pluginPath, diverges: cliPath !== pluginPath };
}

/** Env var by which an operator accepts a divergent store deliberately. */
export const ALLOW_STORE_DIVERGENCE_ENV = 'EXARCHOS_ALLOW_STORE_DIVERGENCE';

/** A divergence that is actually splitting live state, with the evidence for saying so. */
export interface ActiveStoreDivergence extends StorePathDivergence {
  /** The store THIS process will read and write. */
  readonly activePath: string;
  /** The store the OTHER surface resolves. */
  readonly otherPath: string;
  /** True when the store of the other surface exists on disk. */
  readonly otherExists: boolean;
  /** True when the operator opts in to two stores. */
  readonly acknowledged: boolean;
  /**
   * True when state is genuinely splitting: the surfaces diverge, the other
   * store EXISTS, and the operator has not opted in.
   */
  readonly active: boolean;
  /**
   * True when a read must carry the divergence warning. Same condition as
   * {@link active}. The opt-in silences the warning and the refusal, because an
   * operator who sets an ALLOW variable accepts the split. `doctor` still reports it.
   */
  readonly shouldWarn: boolean;
}

/**
 * Decide whether this process writes to a store that the other surface never reads.
 *
 * Divergence alone is not that condition. With `WORKFLOW_STATE_DIR` unset, the CLI
 * resolves `~/.exarchos/state` and the plugin resolves `~/.claude/workflow-state`.
 * Thus each standalone CLI call diverges, even for a user without the plugin. The
 * split is active only when the other store exists and the operator does not opt in.
 * An opt-in value of `0`, `false`, `no`, or `off` keeps the guard armed.
 */
export function detectActiveStoreDivergence(
  inputs?: StorePathResolutionInputs & { readonly storeExists?: (p: string) => boolean },
): ActiveStoreDivergence {
  const env = inputs?.env ?? process.env;
  const pluginMode = inputs?.pluginMode ?? isClaudeCodePlugin(env);
  const exists = inputs?.storeExists ?? ((p: string): boolean => fs.existsSync(p));

  const base = computeStorePathDivergence({
    ...(inputs?.env !== undefined ? { env: inputs.env } : {}),
    ...(inputs?.homedir !== undefined ? { homedir: inputs.homedir } : {}),
  });

  const activePath = pluginMode ? base.pluginPath : base.cliPath;
  const otherPath = pluginMode ? base.cliPath : base.pluginPath;
  const otherExists = base.diverges && exists(otherPath);
  const raw = (env[ALLOW_STORE_DIVERGENCE_ENV] ?? '').trim().toLowerCase();
  const acknowledged = raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';

  return {
    ...base,
    activePath,
    otherPath,
    otherExists,
    acknowledged,
    active: base.diverges && otherExists && !acknowledged,
    shouldWarn: base.diverges && otherExists && !acknowledged,
  };
}

/**
 * Operator-facing message for a live split. It names the store in use and the store
 * that this surface ignores. It also names the env var that pins one store, and the
 * env var that accepts two.
 */
export function describeStoreDivergence(d: ActiveStoreDivergence): string {
  return (
    `Event-store divergence: this surface resolves ${d.activePath} but the other ` +
    `resolves ${d.otherPath}, and that store exists. Workflow state written here is ` +
    `invisible there — reads answer from a different store and downstream gates ` +
    `return confident, wrong verdicts. Set WORKFLOW_STATE_DIR to pin both surfaces ` +
    `to one store (it wins in plugin and non-plugin mode alike), or set ` +
    `${ALLOW_STORE_DIVERGENCE_ENV}=1 to proceed deliberately with two.`
  );
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

/**
 * Resolve the runtime cache directory. The install-identity gate tracks its
 * freshness and blocks a cache that an earlier install left after a binary upgrade.
 * Env: `EXARCHOS_CACHE_DIR` | Claude: `~/.claude/cache` | Default: `~/.exarchos/cache`
 */
export function resolveCacheDir(inputs?: StorePathResolutionInputs): string {
  return resolveDir('EXARCHOS_CACHE_DIR', 'cache', 'cache', inputs);
}

/**
 * Resolve the directory of the recorded install-identity lock.
 *
 * This function does not use {@link resolveDir}. Install freshness is a property
 * of the installed binary, plugin, and cache. Thus the verdict must not change
 * with `WORKFLOW_STATE_DIR` or with the surface that asks. A lock in the event
 * store makes one install fresh in one store and stale in all others.
 */
export function resolveInstallIdentityDir(
  inputs?: Omit<StorePathResolutionInputs, 'pluginMode'>,
): string {
  const env = inputs?.env ?? process.env;
  const home = inputs?.homedir ?? os.homedir();

  const explicit = env['EXARCHOS_INSTALL_STATE_DIR'];
  if (explicit) return toPosix(expandTilde(explicit, home));

  const xdgStateHome = env['XDG_STATE_HOME'];
  if (xdgStateHome) {
    return toPosix(path.join(expandTilde(xdgStateHome, home), 'exarchos', 'install'));
  }

  return toPosix(path.join(home, '.exarchos', 'install'));
}

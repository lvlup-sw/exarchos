import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { FullExarchosConfigSchema, type FullExarchosConfig } from './yaml-schema.js';
import {
  collectConfigDeprecations,
  type ConfigDeprecation,
} from './exarchos-config-schema.js';

const CONFIG_FILENAME = '.exarchos.yml';

export interface LoadResult {
  /**
   * Validated config contents. The unified schema covers the test-runtime keys and
   * the project keys, so a file with keys of either kind validates.
   */
  config: FullExarchosConfig;
  /** Absolute path of the file the config came from. */
  source: string;
  /**
   * Typed deprecations found in the raw document. The schema removes deprecated
   * keys, so `config` cannot report them. `exarchos doctor` uses this list to name
   * the key to delete and its replacement. Empty for a clean config.
   */
  deprecations: ConfigDeprecation[];
}

export interface LoadOptions {
  /**
   * Test hook that returns the git repo root for a path, or `null` outside a git repo.
   * Defaults to {@link walkToRepoRoot}, which starts no process.
   */
  findRepoRoot?: (start: string) => string | null;
}

/** True when `entry` is a `.git` directory, or a `.git` file whose content starts with `gitdir:`. */
function isGitMarker(entry: string): boolean {
  try {
    const info = lstatSync(entry);
    if (info.isDirectory()) return true;
    return info.isFile() && readFileSync(entry, 'utf-8').startsWith('gitdir:');
  } catch {
    return false;
  }
}

/**
 * Returns the top level of the git work tree that holds `start`, or `null` outside one. It starts no process.
 * It walks up from the real path of `start` to the first directory with a `.git` directory or a `gitdir:` file.
 * The result is the real path with forward slashes, the same path that `git rev-parse --show-toplevel` gives.
 * It ignores `GIT_DIR` and `GIT_WORK_TREE` on purpose, so the environment cannot move the config root.
 */
export function walkToRepoRoot(start: string): string | null {
  let dir: string;
  try {
    dir = realpathSync(resolve(start));
  } catch {
    return null;
  }
  for (;;) {
    if (isGitMarker(join(dir, '.git'))) return dir.replace(/\\/g, '/');
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A config file that exists and does not load. `message` names the file and the read, parse or schema error. */
export interface ExarchosConfigLoadFailure {
  /** Absolute path of the file that did not load. */
  readonly source: string;
  readonly message: string;
}

/**
 * The outcome of one config read, as a closed union.
 * - `absent`: no config file in the worktree or at the git repo root.
 * - `loaded`: the file loaded and passed the schema.
 * - `invalid`: the file was found and does not load. The caller decides what that does, and it never reads as `absent`.
 *   A found file that cannot be read is `invalid` too, and `message` holds the read error.
 *   The search uses `existsSync`, which gives false on any error. Thus a file whose check fails, such as a symlink loop, is `absent`.
 */
export type ExarchosConfigOutcome =
  | { readonly kind: 'absent' }
  | { readonly kind: 'loaded'; readonly result: LoadResult }
  | ({ readonly kind: 'invalid' } & ExarchosConfigLoadFailure);

/**
 * Finds the config file for `worktreePath`: the worktree file, or else the file at
 * the git repo root when that root is a different directory. Returns null when
 * neither location has a config file.
 */
function findConfigFile(worktreePath: string, options?: LoadOptions): string | null {
  const findRepoRoot = options?.findRepoRoot ?? walkToRepoRoot;

  const worktreeAbs = resolve(worktreePath);
  const worktreeCfg = resolve(worktreeAbs, CONFIG_FILENAME);

  if (existsSync(worktreeCfg)) {
    return worktreeCfg;
  }

  const repoRoot = findRepoRoot(worktreeAbs);
  if (repoRoot === null) return null;

  const repoRootAbs = resolve(repoRoot);
  if (repoRootAbs === worktreeAbs) {
    return null;
  }

  const repoCfg = resolve(repoRootAbs, CONFIG_FILENAME);
  return existsSync(repoCfg) ? repoCfg : null;
}

/**
 * Loads `.exarchos.yml` from `worktreePath`, or else from the git repo root when
 * that root is a different directory. Returns null when neither location has a
 * config file.
 *
 * Throws on a YAML parse error or a schema violation. The message names the file
 * and lists the violations.
 */
export function loadExarchosConfig(
  worktreePath: string,
  options?: LoadOptions,
): LoadResult | null {
  const file = findConfigFile(worktreePath, options);
  return file === null ? null : readAndValidate(file);
}

/**
 * Reads the config as {@link loadExarchosConfig} does, and returns the outcome as a closed union.
 * It does not throw for a file that does not load. It returns `invalid` with the path and the error.
 * A gate reads the config through this function, so a broken file cannot read as no file.
 *
 * A file that the search finds and then cannot read, for example after `EIO`, `EMFILE` or a delete race, is `invalid` too.
 * Its message holds the read error. Thus a gate that fails on an invalid file also fails on such a file.
 * The search uses `existsSync`, so a file whose existence check fails, such as a symlink loop, is `absent`.
 */
export function loadExarchosConfigOutcome(
  worktreePath: string,
  options?: LoadOptions,
): ExarchosConfigOutcome {
  const file = findConfigFile(worktreePath, options);
  if (file === null) return { kind: 'absent' };
  try {
    return { kind: 'loaded', result: readAndValidate(file) };
  } catch (err) {
    return { kind: 'invalid', source: file, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Reads, parses, and validates one config file. An empty document is an empty
 * config. Deprecations come from the raw document, because the schema removes
 * deprecated keys.
 */
function readAndValidate(path: string): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read .exarchos.yml at ${path}: ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse .exarchos.yml at ${path}: ${msg}`);
  }

  const candidate: unknown = parsed === null || parsed === undefined ? {} : parsed;

  const result = FullExarchosConfigSchema.safeParse(candidate);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const field = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${field}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(`Invalid .exarchos.yml at ${path}: ${details}`);
  }

  return {
    config: result.data,
    source: path,
    deprecations: collectConfigDeprecations(candidate),
  };
}

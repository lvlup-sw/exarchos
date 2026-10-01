import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
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
   * Defaults to `git rev-parse --show-toplevel`.
   */
  findRepoRoot?: (start: string) => string | null;
}

function defaultFindRepoRoot(start: string): string | null {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd: start,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
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
  const findRepoRoot = options?.findRepoRoot ?? defaultFindRepoRoot;

  const worktreeAbs = resolve(worktreePath);
  const worktreeCfg = resolve(worktreeAbs, CONFIG_FILENAME);

  if (existsSync(worktreeCfg)) {
    return readAndValidate(worktreeCfg);
  }

  const repoRoot = findRepoRoot(worktreeAbs);
  if (repoRoot === null) return null;

  const repoRootAbs = resolve(repoRoot);
  if (repoRootAbs === worktreeAbs) {
    return null;
  }

  const repoCfg = resolve(repoRootAbs, CONFIG_FILENAME);
  if (existsSync(repoCfg)) {
    return readAndValidate(repoCfg);
  }

  return null;
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

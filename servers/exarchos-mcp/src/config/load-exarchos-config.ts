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
  /** Validated config contents. The unified schema (#1479) covers every
   * known `.exarchos.yml` key — the test-runtime concern (test/typecheck/
   * install/cli) AND the project concern (agents/review/workflow/...) — so a
   * file with keys from either concern validates here without throwing. */
  config: FullExarchosConfig;
  /** Absolute path of the file the config came from. */
  source: string;
  /**
   * Typed deprecations found in the RAW document (DR-31 / T-43).
   *
   * Deprecated keys are desugared away by the schema, so `config` cannot
   * report them; they are collected pre-parse and surfaced here so operator
   * diagnostics (`exarchos doctor` → invariants-catalog) can tell a consumer
   * exactly which key to delete and what to write instead. Empty for a clean
   * config.
   */
  deprecations: ConfigDeprecation[];
}

export interface LoadOptions {
  /**
   * For testing: inject a function that returns the git repo root for a given
   * path. Defaults to running `git rev-parse --show-toplevel` via execSync.
   * Should return `null` when the start path is not inside a git repo.
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
 * Load `.exarchos.yml` from `worktreePath` first, falling back to the git
 * repo root. Returns null when no config file is present at either location.
 *
 * Throws on YAML parse errors or schema validation failures, with the
 * offending file path and a list of violations included in the message.
 */
export function loadExarchosConfig(
  worktreePath: string,
  options?: LoadOptions,
): LoadResult | null {
  const findRepoRoot = options?.findRepoRoot ?? defaultFindRepoRoot;

  const worktreeAbs = resolve(worktreePath);
  const worktreeCfg = resolve(worktreeAbs, CONFIG_FILENAME);

  // 1. Worktree first.
  if (existsSync(worktreeCfg)) {
    return readAndValidate(worktreeCfg);
  }

  // 2. Fall back to repo root, but only if it differs from the worktree.
  const repoRoot = findRepoRoot(worktreeAbs);
  if (repoRoot === null) return null;

  const repoRootAbs = resolve(repoRoot);
  if (repoRootAbs === worktreeAbs) {
    // Already checked this directory; no second read.
    return null;
  }

  const repoCfg = resolve(repoRootAbs, CONFIG_FILENAME);
  if (existsSync(repoCfg)) {
    return readAndValidate(repoCfg);
  }

  return null;
}

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

  // Treat empty file / null document as empty config.
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
    // Collected from `candidate` (the RAW document), NOT `result.data` — the
    // schema desugars deprecated keys away, so post-parse data cannot report
    // them (DR-31 / T-43).
    deprecations: collectConfigDeprecations(candidate),
  };
}

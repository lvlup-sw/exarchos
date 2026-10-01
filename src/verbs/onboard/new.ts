/**
 * The greenfield scaffold for `onboard --new <name>`.
 *
 * Greenfield and adopt share one pipeline. This helper creates a fresh `<name>/`
 * directory and seeds `.exarchos.yml` and `.gitignore` into it. Then
 * {@link handleOnboard} runs the adopt pipeline against that directory.
 * This helper does not write `CLAUDE.md` or `.claude/`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

import { seedExarchosConfig } from '../init/seed-exarchos-config.js';

/**
 * The `.gitignore` seed. It ignores the per-user Claude Code settings file.
 * The write replaces the file and does not append, because the directory is empty.
 */
const GITIGNORE_SEED = '.claude/settings.local.json\n';

/**
 * File system operations for {@link scaffoldNewRepo}. Tests inject spies to
 * prove that a refusal writes nothing.
 */
export interface ScaffoldNewDeps {
  /** True when `dir` exists and holds at least one entry. */
  readonly isNonEmptyDir: (dir: string) => boolean;
  /**
   * True when the target exists and is not a directory. The scaffold checks this
   * before {@link isNonEmptyDir}, so `readdirSync` does not throw ENOTDIR.
   */
  readonly targetExistsAsFile: (dir: string) => boolean;
  /** Creates `dir` recursively. An existing directory is not an error. */
  readonly mkdir: (dir: string) => void;
  /** Seeds `.exarchos.yml` into `repoRoot`. The seeder never overwrites a file. */
  readonly seed: (repoRoot: string) => void;
  /** Writes the `.gitignore` seed at `gitignorePath`. */
  readonly writeGitignore: (gitignorePath: string) => void;
}

/**
 * Real file system operations. `seed` calls {@link seedExarchosConfig}, the
 * same seeder that the config pipeline step uses.
 */
export function defaultScaffoldDeps(): ScaffoldNewDeps {
  return {
    isNonEmptyDir: (dir) => existsSync(dir) && readdirSync(dir).length > 0,
    targetExistsAsFile: (dir) => existsSync(dir) && !statSync(dir).isDirectory(),
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    seed: (repoRoot) => {
      seedExarchosConfig(repoRoot);
    },
    writeGitignore: (gitignorePath) => {
      writeFileSync(gitignorePath, GITIGNORE_SEED, 'utf8');
    },
  };
}

/** The structured refusal when the scaffold cannot use the target. */
export interface ScaffoldError {
  readonly code:
    | 'ONBOARD_NEW_INVALID_NAME'
    | 'ONBOARD_NEW_TARGET_NONEMPTY'
    | 'ONBOARD_NEW_TARGET_NOT_DIRECTORY';
  readonly message: string;
}

/**
 * The scaffold outcome. On success, `repoRoot` is the new directory for the
 * pipeline. On failure, `error` holds the refusal and nothing is written.
 */
export type ScaffoldNewResult =
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly error: ScaffoldError };

/**
 * Seeds a greenfield repo at `<parentDir>/<name>` and returns its root.
 *
 * `name` must be a bare name, not a path, so the scaffold cannot escape
 * `parentDir`. The function refuses an invalid name, a target that is not a
 * directory, and a directory that is not empty. Every refusal occurs before
 * the first write, so a refused target stays unchanged.
 */
export function scaffoldNewRepo(
  name: string,
  parentDir: string,
  deps: ScaffoldNewDeps = defaultScaffoldDeps(),
): ScaffoldNewResult {
  if (
    name.length === 0 ||
    path.isAbsolute(name) ||
    name.includes('/') ||
    name.includes(path.sep) ||
    name === '.' ||
    name === '..'
  ) {
    return {
      ok: false,
      error: {
        code: 'ONBOARD_NEW_INVALID_NAME',
        message:
          `onboard --new expects a single project name, not a path; received "${name}". ` +
          `Use a bare name (e.g. "my-app") and run from the directory you want it created in.`,
      },
    };
  }

  const repoRoot = path.resolve(parentDir, name);

  if (deps.targetExistsAsFile(repoRoot)) {
    return {
      ok: false,
      error: {
        code: 'ONBOARD_NEW_TARGET_NOT_DIRECTORY',
        message:
          `onboard --new refuses to scaffold over ${repoRoot}: a non-directory ` +
          `file already exists at that path. Pick a fresh name or remove it, then re-run.`,
      },
    };
  }

  if (deps.isNonEmptyDir(repoRoot)) {
    return {
      ok: false,
      error: {
        code: 'ONBOARD_NEW_TARGET_NONEMPTY',
        message:
          `onboard --new refuses to scaffold over ${repoRoot}: the directory ` +
          `exists and is not empty. Pick a fresh name or remove the existing ` +
          `contents, then re-run.`,
      },
    };
  }

  deps.mkdir(repoRoot);
  deps.seed(repoRoot);
  deps.writeGitignore(path.join(repoRoot, '.gitignore'));

  return { ok: true, repoRoot };
}

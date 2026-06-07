/**
 * scaffoldNewRepo — the `onboard --new <name>` greenfield scaffold helper (DR-3).
 *
 * DR-3's whole contract is a SINGLE pipeline: `--new` is the *only* difference
 * between greenfield and adopt. This helper owns that single difference — it
 * seeds the salvageable initial scaffold into a FRESH `<name>/` dir, then hands
 * the dir back so {@link handleOnboard} runs the IDENTICAL DR-2
 * detect→config→generate→install→verify pipeline against it. There is no second
 * pipeline; greenfield is "seed an empty dir, then adopt it".
 *
 * The salvageable scaffold (per DR-3) is exactly three things:
 *   1. the directory `<name>/`,
 *   2. a `.exarchos.yml` seed via the shared {@link seedExarchosConfig} (the
 *      SAME seeder the CONFIG pipeline step uses — never a fork of it), and
 *   3. a `.gitignore` carrying the one entry `new-project` salvageably seeded
 *      (`.claude/settings.local.json`).
 *
 * What this helper deliberately does NOT carry forward from the retired
 * `new-project` handler (task 017 deletes it): the `CLAUDE.md` template copy and
 * the `applyLanguageCustomizations` npm-rewrite. Those are gone — `CLAUDE.md` /
 * `.claude/` are produced by the pipeline's GENERATE writers, and commands come
 * from the resolver (INV-6), not a per-language string rewrite.
 *
 * DR-10 edge case: a target dir that exists and is NON-EMPTY is refused with a
 * clear structured error and NOTHING is written (no partial scaffold over
 * existing files). An empty existing dir is fine (we seed into it).
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

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * The salvageable `.gitignore` seed. Mirrors the single entry `new-project`
 * seeded (`.claude/settings.local.json`) so the greenfield repo ignores the
 * per-user Claude Code settings file the GENERATE writers may create. Kept as a
 * fresh-file write (never an append) because the dir is empty by construction.
 */
const GITIGNORE_SEED = '.claude/settings.local.json\n';

// ─── Injection seam ──────────────────────────────────────────────────────────

/**
 * The injected fs/seam bundle for {@link scaffoldNewRepo}. Production uses the
 * real-fs default ({@link defaultScaffoldDeps}); tests inject in-memory spies to
 * prove the refuse path writes nothing without touching disk.
 */
export interface ScaffoldNewDeps {
  /** Does `dir` exist AND contain at least one entry? (DR-10 refusal probe.) */
  readonly isNonEmptyDir: (dir: string) => boolean;
  /**
   * Does the target path exist as a NON-directory (a file/symlink)? Probed
   * BEFORE {@link isNonEmptyDir} so a file collision returns a structured
   * refusal instead of crashing `readdirSync` with ENOTDIR.
   */
  readonly targetExistsAsFile: (dir: string) => boolean;
  /** Create `dir` (recursive — a no-op if it already exists empty). */
  readonly mkdir: (dir: string) => void;
  /** Seed `.exarchos.yml` into `repoRoot` (the shared, never-overwrite seeder). */
  readonly seed: (repoRoot: string) => void;
  /** Write the salvageable `.gitignore` at `gitignorePath`. */
  readonly writeGitignore: (gitignorePath: string) => void;
}

/** Real-fs scaffold deps. `seed` reuses {@link seedExarchosConfig} verbatim. */
export function defaultScaffoldDeps(): ScaffoldNewDeps {
  return {
    isNonEmptyDir: (dir) => existsSync(dir) && readdirSync(dir).length > 0,
    targetExistsAsFile: (dir) => existsSync(dir) && !statSync(dir).isDirectory(),
    mkdir: (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    // The SAME seeder the CONFIG pipeline step uses — one config-seed source.
    seed: (repoRoot) => {
      seedExarchosConfig(repoRoot);
    },
    writeGitignore: (gitignorePath) => {
      writeFileSync(gitignorePath, GITIGNORE_SEED, 'utf8');
    },
  };
}

// ─── Result shape ────────────────────────────────────────────────────────────

/** The structured refusal carried when a greenfield target cannot be scaffolded. */
export interface ScaffoldError {
  readonly code:
    | 'ONBOARD_NEW_INVALID_NAME'
    | 'ONBOARD_NEW_TARGET_NONEMPTY'
    | 'ONBOARD_NEW_TARGET_NOT_DIRECTORY';
  readonly message: string;
}

/**
 * The scaffold outcome. On success, `repoRoot` is the FRESH dir the caller runs
 * the identical pipeline against. On failure, `error` is a clear structured
 * refusal and nothing was written (DR-10).
 */
export type ScaffoldNewResult =
  | { readonly ok: true; readonly repoRoot: string }
  | { readonly ok: false; readonly error: ScaffoldError };

// ─── Scaffold ────────────────────────────────────────────────────────────────

/**
 * Seed a fresh greenfield repo at `<parentDir>/<name>` and return its root, or
 * refuse cleanly if the target exists and is non-empty (DR-10).
 *
 * `name` is resolved against `parentDir` (the run's cwd in production). The
 * scaffold is the THREE salvageable artifacts (dir + `.exarchos.yml` seed +
 * `.gitignore`); the caller then runs the identical DR-2 pipeline against the
 * returned `repoRoot`, so greenfield and adopt share exactly one code path.
 *
 * Refusal is checked FIRST and writes nothing — the non-empty guard precedes
 * every fs mutation, so a refused target is byte-for-byte untouched.
 */
export function scaffoldNewRepo(
  name: string,
  parentDir: string,
  deps: ScaffoldNewDeps = defaultScaffoldDeps(),
): ScaffoldNewResult {
  // `--new` takes a single project NAME, not a path. Reject anything that could
  // resolve outside `parentDir` (absolute paths, path separators, `.`/`..`) so
  // a stray `--new ../x` or `--new /etc/foo` cannot escape the run's cwd and
  // scaffold (or refuse over) an arbitrary location. Checked BEFORE resolving.
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

  // A pre-existing NON-directory at the target (a file/symlink) would make the
  // non-empty probe's readdirSync throw ENOTDIR — refuse cleanly instead (DR-10:
  // a structured refusal, never a crash, and no partial scaffold).
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

  // DR-10: refuse over a non-empty dir BEFORE any write (no partial scaffold).
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

  // Seed the salvageable scaffold: dir → `.exarchos.yml` → `.gitignore`.
  deps.mkdir(repoRoot);
  deps.seed(repoRoot);
  deps.writeGitignore(path.join(repoRoot, '.gitignore'));

  return { ok: true, repoRoot };
}

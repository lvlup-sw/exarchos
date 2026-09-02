/**
 * Where the censuses look, resolved once.
 *
 * Every census in this package reads the repository it governs, so each one
 * needs the repository root and the root of the subject source tree. Computing
 * those per-module with `path.resolve(__dirname, '../../../..')` — the idiom
 * this package inherited — fails in a way that is worse than a crash: a stale
 * hop count still resolves to a real directory (the parent of the repo, or
 * higher), so the census scans the wrong tree, finds nothing, and reports
 * green. The guard goes vacuous rather than red.
 *
 * So the root is found by searching for a sentinel instead of by counting
 * directory hops, and it is found in exactly one place. Moving a census file
 * between directories cannot change what it scans, and relocating the subject
 * tree is a one-line edit to {@link SUBJECT_SRC_REL} rather than an edit to
 * every module that reads it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `name` of the repository's root manifest. The sentinel we search for. */
const ROOT_PACKAGE_NAME = '@lvlup-sw/exarchos';

/**
 * The subject source tree, relative to the repository root.
 *
 * Task 019 folds `src/` up to `src/`; when it does, this
 * constant is the only line that has to change.
 */
export const SUBJECT_SRC_REL = 'src';

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as { name?: unknown }).name === ROOT_PACKAGE_NAME
        ) {
          return dir;
        }
      } catch {
        // A malformed manifest is not the root we are looking for; keep walking.
      }
    }
    const parent = path.dirname(dir);
    // `path.dirname('/') === '/'` — the filesystem root is the end of the walk.
    if (parent === dir) {
      throw new Error(
        `Could not locate the repository root above ${startDir}: no package.json ` +
          `named "${ROOT_PACKAGE_NAME}" was found on the way up. The conformance ` +
          `censuses cannot run outside the repository they govern.`,
      );
    }
    dir = parent;
  }
}

/** Absolute path to the repository root. */
export const REPO_ROOT: string = findRepoRoot(
  path.dirname(fileURLToPath(import.meta.url)),
);

/** Absolute path to the root of the source tree under inspection. */
export const SUBJECT_SRC_ROOT: string = path.join(REPO_ROOT, SUBJECT_SRC_REL);

/**
 * The package directory containing {@link SUBJECT_SRC_ROOT} — where the subject's
 * own `package.json`, `scripts/` and `tsconfig.json` live.
 *
 * Derived from `SUBJECT_SRC_REL` rather than declared separately, so the two
 * cannot drift: task 019's one-line edit moves both.
 */
export const SUBJECT_PACKAGE_ROOT: string = path.dirname(SUBJECT_SRC_ROOT);

/** Resolve a path relative to the subject's package root. */
export function fromSubjectPackage(...segments: readonly string[]): string {
  return path.join(SUBJECT_PACKAGE_ROOT, ...segments);
}

/** Resolve a path relative to the repository root. */
export function fromRepoRoot(...segments: readonly string[]): string {
  return path.join(REPO_ROOT, ...segments);
}

/** Resolve a path relative to the subject source tree. */
export function fromSubjectSrc(...segments: readonly string[]): string {
  return path.join(SUBJECT_SRC_ROOT, ...segments);
}

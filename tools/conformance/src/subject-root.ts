/**
 * Resolves, in one place, the repository root and the root of the subject source tree.
 *
 * Every census in this package reads the repository it governs. A hop count such as
 * `path.resolve(__dirname, '../../../..')` goes stale when a file moves. A stale count
 * still resolves to a real directory, so the census scans the wrong tree and passes.
 * This module finds the root with a search for a sentinel manifest, not a hop count.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `name` of the repository's root manifest. The sentinel we search for. */
const ROOT_PACKAGE_NAME = '@lvlup-sw/exarchos';

/** The subject source tree, relative to the repository root. In this module, a move of the tree changes only this line. */
export const SUBJECT_SRC_REL = 'src';

/**
 * Walks up from `startDir` to the first `package.json` named {@link ROOT_PACKAGE_NAME}.
 * A malformed manifest does not stop the walk. The function throws at the filesystem root.
 */
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
      }
    }
    const parent = path.dirname(dir);
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
 * The package directory that holds {@link SUBJECT_SRC_ROOT}, with the subject `package.json`, `scripts/` and `tsconfig.json`.
 * It derives from `SUBJECT_SRC_REL`, so the two cannot drift.
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

/**
 * Path containment for worktree boundaries, with symlinks resolved on both sides.
 * A string-prefix test fails on macOS, where `/var/...` is a symlink to `/private/var/...`.
 * The comparison uses `path.relative`, so a sibling such as `/a/bc` is not within `/a/b`.
 * The resolver is injected, so tests can simulate symlinks with no real filesystem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { toPosix } from '../../../utils/paths.js';

/**
 * Canonicalizes a filesystem path to its absolute form with no symlinks.
 */
export type RealpathResolver = (p: string) => string;

/**
 * Whether `err` is a Node filesystem error with the given POSIX `code`.
 */
function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

/**
 * A realpath that accepts a tail that does not exist yet.
 * On `ENOENT` it resolves the longest existing ancestor and appends the remaining segments, so a new path still resolves through a symlinked parent.
 * It rethrows each other error, such as `ENOTDIR`, `ELOOP`, or `EACCES`, because that path is not only missing.
 * It uses `fs.realpathSync.native`, which expands a Windows 8.3 short name such as `RUNNER~1` to the long form that git prints.
 */
export function defaultRealpath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    if (!isErrnoCode(err, 'ENOENT')) {
      throw err;
    }
    const parent = path.dirname(p);
    if (parent === p) {
      return p;
    }
    return path.join(defaultRealpath(parent), path.basename(p));
  }
}

/**
 * Converts a worktree path to its `worktreeId` projection key: absolute, symlink-resolved, and with POSIX separators.
 * Each `worktreeId` derivation must use this function, so the key is byte-identical on each platform.
 * Git prints forward slashes on Windows, but `path.resolve` prints backslashes. Without {@link toPosix}, two keys for one worktree differ.
 */
export function canonicalWorktreeId(
  p: string,
  realpath: RealpathResolver = defaultRealpath,
): string {
  return toPosix(realpath(path.resolve(p)));
}

/**
 * Converts `p` to an absolute path with POSIX separators.
 * An absolute input, POSIX `/x` or win32 `C:\x`, is normalized in place. Only a relative path resolves against the cwd.
 * On Windows, `path.resolve('/var/…')` adds the cwd drive, so an injected resolver keyed on POSIX paths cannot match.
 */
function toAbsolutePosix(p: string): string {
  const posix = toPosix(p);
  if (path.posix.isAbsolute(posix)) return path.posix.normalize(posix);
  if (path.win32.isAbsolute(p)) return toPosix(path.win32.normalize(p));
  return toPosix(path.resolve(p));
}

/**
 * Reduces `p` to the canonical form that containment compares.
 * It makes the path absolute with {@link toAbsolutePosix}, resolves it through `realpath`, and converts separators to POSIX.
 * The default resolver expands symlinks and Windows 8.3 short names.
 */
export function canonicalizeForContainment(
  p: string,
  realpath: RealpathResolver = defaultRealpath,
): string {
  return toPosix(realpath(toAbsolutePosix(p)));
}

/**
 * True when `candidatePath` is the worktree root or a path within it, after the function canonicalizes both sides.
 * A candidate under a symlinked root matches a worktree recorded under the canonical root.
 * The function accesses the filesystem only through the resolver.
 */
export function isPathWithin(
  candidatePath: string,
  worktreePath: string,
  realpath: RealpathResolver = defaultRealpath,
): boolean {
  return isPathWithinCanonical(
    canonicalizeForContainment(candidatePath, realpath),
    canonicalizeForContainment(worktreePath, realpath),
  );
}

/**
 * The containment predicate over paths that are already canonical, with no filesystem access.
 * The relative path must be empty, or not climb out with `..` and not be absolute. So `/a/bc` is not within `/a/b`.
 * Use {@link isPathWithin} when the inputs still need symlink resolution.
 */
export function isPathWithinCanonical(
  canonicalCandidate: string,
  canonicalWorktree: string,
): boolean {
  const rel = path.posix.relative(canonicalWorktree, canonicalCandidate);
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.posix.isAbsolute(rel));
}

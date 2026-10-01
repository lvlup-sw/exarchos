/**
 * Sibling worktree path derivation and the containment guard.
 *
 * A harness launch puts its worktree as a sibling of the base worktree.
 * The worktree is a direct child of the shared parent directory, never inside the base or another sibling.
 * A nested git worktree corrupts `git worktree` bookkeeping and lets a child launch
 * escape the containment of the worktree manager.
 *
 * Paths are POSIX-normalized with {@link toPosix}. The guard resolves symlinks and
 * Windows 8.3 short names through the same {@link RealpathResolver} as the worktree manager.
 * The module re-exports that resolver, so callers can inject a test double.
 */

import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import {
  defaultRealpath,
  isPathWithinCanonical,
  type RealpathResolver,
} from '../../verbs/worktree/pure/path-containment.js';

export { defaultRealpath, type RealpathResolver };

/**
 * Why {@link guardWorktreeContainment} refused a target.
 *
 * - `nested-inside-base`: the target is the base worktree or is inside it.
 * - `escapes-containment`: the target is not a direct child of the parent of the base.
 *   It is outside the parent, deeper than one level, or the parent itself.
 */
export type ContainmentRefusalReason = 'nested-inside-base' | 'escapes-containment';

/** The target is a valid one-level-deep sibling of the base worktree. */
export interface WorktreePathAccepted {
  readonly ok: true;
  /** Canonical, symlink-resolved, POSIX-normalized target path. */
  readonly path: string;
}

/** The target violates the sibling-containment topology and was refused. */
export interface WorktreePathRefused {
  readonly ok: false;
  readonly reason: ContainmentRefusalReason;
  /** The base worktree the target was checked against (as supplied). */
  readonly base: string;
  /** The rejected target (as supplied). */
  readonly target: string;
  /** Human-scannable explanation of the refusal. */
  readonly message: string;
}

/** Discriminated outcome of {@link guardWorktreeContainment}. */
export type WorktreePathGuardResult = WorktreePathAccepted | WorktreePathRefused;

/**
 * Pick the {@link path} sub-API (`posix` or `win32`) that matches the style of `p`.
 * A win32-absolute path, or a path with a backslash, is win32-style. All other paths are POSIX.
 * Without this, `path.dirname` on Linux reads a win32 path as one segment and returns `.`.
 */
function pathApiFor(p: string): typeof path.posix {
  if (path.win32.isAbsolute(p) || p.includes('\\')) return path.win32;
  return path.posix;
}

/**
 * Normalize `p` to an absolute path with POSIX separators. An absolute input
 * (POSIX or win32) is normalized in place. Only a relative path resolves against the cwd.
 * This matches the canonical form of the shared path-containment module.
 */
function toAbsolutePosix(p: string): string {
  const posix = toPosix(p);
  if (path.posix.isAbsolute(posix)) return path.posix.normalize(posix);
  if (path.win32.isAbsolute(p)) return toPosix(path.win32.normalize(p));
  return toPosix(path.resolve(p));
}

/**
 * Canonicalize `p` to its absolute, symlink-resolved, POSIX-normalized form through
 * the injected resolver. The containment decision uses this form.
 * The function has no OS access other than the resolver.
 */
function canonicalPosix(p: string, realpath: RealpathResolver): string {
  return toPosix(realpath(toAbsolutePosix(p)));
}

/**
 * Reject an id that is not a single, safe path segment. A separator or a traversal
 * token (`.` or `..`) can move the derived path deeper than one level or out of the parent.
 *
 * @throws {RangeError} if `id` is empty, a traversal token, or contains a separator.
 */
function assertSingleSegmentId(id: string): void {
  if (id.length === 0 || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw new RangeError(
      `worktree id must be a single path segment, got: ${JSON.stringify(id)}`,
    );
  }
}

/**
 * Derive the sibling worktree path for `id`: the parent directory of `base` joined
 * with `id`, in POSIX form. The function has no filesystem access, so the
 * `--dry-run` path can call it. The dry run and the creation path get the same result.
 *
 * @throws {RangeError} if `id` is empty, a traversal token, or contains a separator.
 */
export function deriveWorktreePath(base: string, id: string): string {
  assertSingleSegmentId(id);
  const api = pathApiFor(base);
  const parent = api.dirname(base);
  return toPosix(api.join(parent, id));
}

function refuse(
  reason: ContainmentRefusalReason,
  base: string,
  target: string,
  message: string,
): WorktreePathRefused {
  return { ok: false, reason, base, target, message };
}

/**
 * Make sure that `target` is a direct sibling of the `base` worktree, before `git worktree add`.
 * The injected `realpath` resolves symlinks and Windows 8.3 short names on both sides first.
 * It is the only filesystem read, and tests inject a simulated resolver.
 * Both checks use this one resolved snapshot.
 * A refused target gives a structured {@link WorktreePathRefused}.
 */
export function guardWorktreeContainment(
  base: string,
  target: string,
  realpath: RealpathResolver = defaultRealpath,
): WorktreePathGuardResult {
  const canonicalBase = canonicalPosix(base, realpath);
  const canonicalTarget = canonicalPosix(target, realpath);
  const canonicalParent = path.posix.dirname(canonicalBase);

  if (isPathWithinCanonical(canonicalTarget, canonicalBase)) {
    return refuse(
      'nested-inside-base',
      base,
      target,
      `target ${canonicalTarget} would nest inside base worktree ${canonicalBase}`,
    );
  }

  const relToParent = path.posix.relative(canonicalParent, canonicalTarget);
  const isDirectChild =
    relToParent !== '' &&
    relToParent !== '..' &&
    !relToParent.startsWith('../') &&
    !path.posix.isAbsolute(relToParent) &&
    !relToParent.includes('/');

  if (!isDirectChild) {
    return refuse(
      'escapes-containment',
      base,
      target,
      `target ${canonicalTarget} is not a one-level-deep sibling under ${canonicalParent}`,
    );
  }

  return { ok: true, path: canonicalTarget };
}

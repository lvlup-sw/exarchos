/**
 * Symlink-resolved path-containment primitive for worktree boundaries.
 *
 * Deciding whether a candidate path lives inside a worktree cannot be a plain
 * string-prefix test: on macOS the per-user temp/worktree root `/var/...` is a
 * symlink to `/private/var/...`, so a candidate reported under one form and a
 * worktree recorded under the other would spuriously fail to match. This module
 * canonicalizes (realpath-resolves) BOTH sides before comparing, and uses
 * `path.relative` rather than `startsWith` so a sibling like `/a/bc` is NOT
 * judged to be within `/a/b`.
 *
 * The resolver is injected so the containment logic is unit-testable with
 * simulated symlink maps and no real filesystem.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// Types
// ============================================================

/**
 * Canonicalizes a filesystem path to its absolute, symlink-free form. Injected
 * so tests can model symlinked roots (e.g. `/var` -> `/private/var`) without
 * touching the real filesystem.
 */
export type RealpathResolver = (p: string) => string;

// ============================================================
// Default resolver
// ============================================================

/**
 * realpath that tolerates a not-yet-existing tail: it resolves the longest
 * existing ancestor and re-appends the remaining segments, so a brand-new path
 * still canonicalizes through any symlinked parent (defeating symlink escape)
 * instead of throwing `ENOENT`.
 */
export function defaultRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) {
      return p; // reached the filesystem root; nothing left to resolve.
    }
    return path.join(defaultRealpath(parent), path.basename(p));
  }
}

// ============================================================
// Pure decision
// ============================================================

/**
 * True when `candidatePath` is the worktree root itself or lives strictly
 * within it, after resolving symlinks on BOTH sides.
 *
 * Both paths are made absolute (`path.resolve`) and then realpath-resolved, so a
 * candidate under a symlinked root matches a worktree recorded under the
 * canonical root (and vice versa). Containment is decided with `path.relative`:
 * the relative path is empty (same path) or does not climb out (`..`) and is not
 * itself absolute — which means a partial-segment sibling such as `/a/bc` is
 * correctly NOT within `/a/b` (its relative path is `../bc`).
 *
 * Pure over the injected {@link RealpathResolver}; performs no OS access of its
 * own beyond what the resolver does.
 */
export function isPathWithin(
  candidatePath: string,
  worktreePath: string,
  realpath: RealpathResolver = defaultRealpath,
): boolean {
  const resolvedCandidate = realpath(path.resolve(candidatePath));
  const resolvedWorktree = realpath(path.resolve(worktreePath));

  const rel = path.relative(resolvedWorktree, resolvedCandidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

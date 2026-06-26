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
import { toPosix } from '../../../utils/paths.js';

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
// Canonical worktreeId key
// ============================================================

/**
 * Canonicalize a real, OS-absolute worktree path to its separator-stable
 * `worktreeId` projection key: make absolute (`path.resolve`), symlink-resolve
 * through the injected resolver, then normalize separators to POSIX
 * forward-slashes (#1620).
 *
 * EVERY `worktreeId` derivation — the {@link WorktreeManager} adopt fold, its
 * `git worktree list` registry re-check, the `worktrees@v1` reducer's
 * remove-event correlation, and the tests that assert against those keys — MUST
 * route through this one helper so the key is byte-identical across platforms.
 * `git worktree list --porcelain` emits forward-slash paths even on Windows,
 * whereas `path.resolve` / `fs.realpathSync` emit backslashes there; without the
 * trailing {@link toPosix} the adopt-derived key and the remove-event-derived
 * key would differ only in separator, the `worktrees@v1` lookup would miss, and
 * the adopt-gate / deletion would silently fold onto the wrong (or no) entry.
 *
 * A strict no-op on POSIX: `path.resolve` keeps `/`-separators and {@link toPosix}
 * leaves an already-`/`-separated path unchanged, so the Linux key is identical
 * before and after this normalization.
 */
export function canonicalWorktreeId(
  p: string,
  realpath: RealpathResolver = defaultRealpath,
): string {
  return toPosix(realpath(path.resolve(p)));
}

// ============================================================
// Pure decision
// ============================================================

/**
 * Resolve `p` to an absolute, POSIX-separator path WITHOUT letting a win32
 * `path.resolve` mangle an already-absolute POSIX input.
 *
 * `isPathWithin` is unit-tested with INJECTED resolvers that key on absolute
 * POSIX paths (e.g. the macOS `/var` → `/private/var` symlink map). On Windows a
 * naive `path.resolve('/var/…')` prepends the cwd drive and rewrites `/`→`\\`,
 * so the injected resolver would never match and containment would wrongly fail.
 * To stay OS-agnostic we resolve in a separator-aware way: an already-absolute
 * input (POSIX `/x` or win32 `C:\x`) is normalized in place and emitted as
 * POSIX; only a genuinely relative path is resolved against the real cwd. A
 * no-op on POSIX for already-absolute inputs (the only shape the named tests and
 * real callers pass).
 */
function toAbsolutePosix(p: string): string {
  const posix = toPosix(p);
  if (path.posix.isAbsolute(posix)) return path.posix.normalize(posix);
  if (path.win32.isAbsolute(p)) return toPosix(path.win32.normalize(p));
  return toPosix(path.resolve(p));
}

/**
 * True when `candidatePath` is the worktree root itself or lives strictly
 * within it, after resolving symlinks on BOTH sides.
 *
 * Both paths are made absolute and then realpath-resolved, so a candidate under
 * a symlinked root matches a worktree recorded under the canonical root (and
 * vice versa). The whole decision is computed with the **POSIX** path API over
 * separator-normalized paths ({@link toPosix}), never the OS-native `path`, so a
 * win32 `path.resolve`/`path.relative`/`path.sep` cannot mangle the POSIX inputs
 * the injected-resolver tests pass (#1620). Containment is decided with
 * `path.posix.relative`: the relative path is empty (same path) or does not
 * climb out (`../`) and is not itself absolute — so a partial-segment sibling
 * such as `/a/bc` is correctly NOT within `/a/b` (its relative path is `../bc`).
 *
 * Pure over the injected {@link RealpathResolver}; performs no OS access of its
 * own beyond what the resolver does.
 */
export function isPathWithin(
  candidatePath: string,
  worktreePath: string,
  realpath: RealpathResolver = defaultRealpath,
): boolean {
  const resolvedCandidate = toPosix(realpath(toAbsolutePosix(candidatePath)));
  const resolvedWorktree = toPosix(realpath(toAbsolutePosix(worktreePath)));

  const rel = path.posix.relative(resolvedWorktree, resolvedCandidate);
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.posix.isAbsolute(rel));
}

/**
 * Sibling worktree path derivation + nesting/containment guard (DR-5).
 *
 * A harness launch places its worktree as a **sibling** of the base worktree —
 * one level deep off the shared parent directory, NEVER nested inside the base
 * (or inside any other sibling worktree). Nesting a git worktree inside another
 * worktree corrupts `git worktree` bookkeeping and lets a child launch escape
 * the WLM's containment envelope, so the topology is enforced structurally:
 *
 *   - {@link deriveWorktreePath} — PURE, no filesystem access: given a base
 *     worktree path and an id, returns the canonical sibling path (a direct
 *     child of the base's parent directory). Reused by both `--dry-run`
 *     (Task 004) and creation (Task 005) so the derived path is identical on
 *     every path.
 *   - {@link guardWorktreeContainment} — validates an ARBITRARY target against
 *     the base and REFUSES (structured result, never a silent pass) anything
 *     that would nest inside the base worktree or otherwise escape the
 *     one-level-deep sibling envelope. Called by the creation task *before*
 *     `git worktree add`.
 *
 * Cross-OS: paths are built with `path.join` and normalized to POSIX
 * forward-slashes via {@link toPosix} (#1620), and the guard resolves symlinks
 * (and Windows 8.3 short names) through the SAME injected {@link RealpathResolver}
 * the worktree manager uses — so a win32 base authored with backslashes and a
 * POSIX-normalized derived sibling compare correctly regardless of host OS.
 */

import * as path from 'node:path';
import { toPosix } from '../../utils/paths.js';
import {
  defaultRealpath,
  isPathWithinCanonical,
  type RealpathResolver,
} from '../../verbs/worktree/pure/path-containment.js';

// Re-export the shared resolver seam so consumers (dry-run / creation) can
// inject a test double without reaching into the worktree-manager internals.
export { defaultRealpath, type RealpathResolver };

// ============================================================
// Types
// ============================================================

/**
 * Why a candidate worktree target was refused by {@link guardWorktreeContainment}.
 *
 * - `nested-inside-base` — the target is the base worktree itself or lives
 *   inside it (`<base>/…`). Creating a worktree here would nest one worktree
 *   inside another.
 * - `escapes-containment` — the target is not a direct sibling of the base: it
 *   climbs out of the base's parent directory, sits deeper than one level
 *   (i.e. nested inside another sibling worktree), or IS the parent directory
 *   itself.
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

// ============================================================
// Internal path helpers (separator-aware, host-OS-agnostic)
// ============================================================

/**
 * Pick the {@link path} sub-API (`posix` vs `win32`) that matches the *style*
 * of `p`, so a win32 path is parsed with the win32 rules even on a POSIX host
 * (and vice versa). A win32-absolute path (drive-letter / UNC) or any path
 * containing a backslash is win32-style; everything else is POSIX. Without this
 * a `path.dirname('C:\\repo\\wt')` on Linux would treat the whole string as one
 * segment and return `.`, silently breaking the derivation for win32 fixtures.
 */
function pathApiFor(p: string): typeof path.posix {
  if (path.win32.isAbsolute(p) || p.includes('\\')) return path.win32;
  return path.posix;
}

/**
 * Normalize `p` to an absolute, POSIX-separator path WITHOUT letting a win32
 * `path.resolve` mangle an already-absolute POSIX input (or vice versa). This
 * mirrors the separator-aware absolutization in the shared path-containment
 * module so the guard's canonical form matches {@link isPathWithin}'s: an
 * already-absolute input (POSIX `/x` or win32 `C:\x`) is normalized in place and
 * emitted as POSIX; only a genuinely relative path is resolved against the cwd.
 */
function toAbsolutePosix(p: string): string {
  const posix = toPosix(p);
  if (path.posix.isAbsolute(posix)) return path.posix.normalize(posix);
  if (path.win32.isAbsolute(p)) return toPosix(path.win32.normalize(p));
  return toPosix(path.resolve(p));
}

/**
 * Canonicalize `p` to its absolute, symlink-resolved, POSIX-normalized form
 * through the injected resolver — the byte-stable representation containment is
 * decided over. Pure over {@link RealpathResolver}; performs no OS access of its
 * own beyond what the resolver does.
 */
function canonicalPosix(p: string, realpath: RealpathResolver): string {
  return toPosix(realpath(toAbsolutePosix(p)));
}

/**
 * Reject an id that is not a single, safe path segment. An id carrying a
 * separator (`/` or `\`) or a traversal token (`.` / `..`) could push the
 * derived path deeper than one level or climb out of the parent — defeating the
 * whole sibling topology — so the derivation fails loudly rather than silently
 * mangling. Throws {@link RangeError} on violation.
 */
function assertSingleSegmentId(id: string): void {
  if (id.length === 0 || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw new RangeError(
      `worktree id must be a single path segment, got: ${JSON.stringify(id)}`,
    );
  }
}

// ============================================================
// Pure derivation
// ============================================================

/**
 * Derive the canonical **sibling** worktree path for `id` off the same parent
 * directory as `base` — one level deep, never nested inside `base`.
 *
 * PURE and side-effect-free: it performs NO filesystem access (no realpath, no
 * stat), so it is safe to call on the `--dry-run` path. The result is the
 * base's parent directory joined with `id`, normalized to POSIX separators
 * ({@link toPosix}). `id` must be a single path segment ({@link assertSingleSegmentId});
 * containment of the returned path is additionally enforceable via
 * {@link guardWorktreeContainment}.
 *
 * @throws {RangeError} if `id` is empty, a traversal token, or contains a separator.
 */
export function deriveWorktreePath(base: string, id: string): string {
  assertSingleSegmentId(id);
  const api = pathApiFor(base);
  const parent = api.dirname(base);
  return toPosix(api.join(parent, id));
}

// ============================================================
// Containment guard
// ============================================================

function refuse(
  reason: ContainmentRefusalReason,
  base: string,
  target: string,
  message: string,
): WorktreePathRefused {
  return { ok: false, reason, base, target, message };
}

/**
 * Validate that `target` is a legal one-level-deep sibling of the `base`
 * worktree, resolving symlinks (and Windows 8.3 short names) on BOTH sides
 * through the injected `realpath` resolver before deciding.
 *
 * Refuses, with a structured {@link WorktreePathRefused}, any target that:
 *   - is the base worktree itself or lives inside it → `nested-inside-base`;
 *   - is not a direct child of the base's parent directory (climbs out, sits
 *     deeper than one level inside another sibling, or IS the parent) →
 *     `escapes-containment`.
 *
 * Pure over the injected {@link RealpathResolver}; the default resolver
 * ({@link defaultRealpath}) performs a real symlink-resolving `realpath` and is
 * the only filesystem read. Tests inject an identity/simulated resolver to keep
 * the decision deterministic and OS-agnostic.
 */
export function guardWorktreeContainment(
  base: string,
  target: string,
  realpath: RealpathResolver = defaultRealpath,
): WorktreePathGuardResult {
  const canonicalBase = canonicalPosix(base, realpath);
  const canonicalTarget = canonicalPosix(target, realpath);
  const canonicalParent = path.posix.dirname(canonicalBase);

  // (1) Nested inside (or equal to) the base worktree — reuse the proven
  // containment predicate over the ALREADY-canonical base/target snapshot
  // (canonicalBase/canonicalTarget above), so this nested check shares one
  // resolved snapshot with the sibling check below instead of re-running realpath
  // on the raw inputs.
  if (isPathWithinCanonical(canonicalTarget, canonicalBase)) {
    return refuse(
      'nested-inside-base',
      base,
      target,
      `target ${canonicalTarget} would nest inside base worktree ${canonicalBase}`,
    );
  }

  // (2) Must be a DIRECT child of the base's parent directory: a single,
  // non-traversing segment below the parent. Anything else — climbing out of
  // the parent, sitting deeper than one level (nested inside another sibling),
  // or being the parent itself — escapes the sibling containment envelope.
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

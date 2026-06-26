/**
 * Pure ownership / heal decisions for the worktree-lifecycle manager (DR-3).
 *
 * The crash-safe reservation story is: a worktree is `reserved` while a live
 * process holds it, and the heal fold (`WorktreeManager.reconcile`) must release
 * any reservation whose owning process has died — without ever releasing a live
 * holder. This module is the pure core of that decision: given the projected
 * {@link WorktreeEntry} records (from `worktrees@v1`) plus an injected
 * {@link ProcessSource}, it returns the reservations whose owner is **provably
 * dead** and must therefore be released.
 *
 * Liveness is delegated to the Task-003 {@link isOwnerAlive} primitive, which
 * pairs the recorded PID with the owning process's create-time fingerprint so a
 * recycled PID is correctly read as a *different* (dead) owner. This module adds
 * only the fold framing — selecting `reserved` entries and coalescing a missing
 * owner descriptor to "dead" — and performs NO OS or filesystem access itself
 * (every probe flows through the injected source). That keeps every heal
 * decision deterministic and table-testable.
 */

import {
  isOwnerAlive,
  type ProcessSource,
} from './process-identity.js';
import type { WorktreeEntry } from '../projections/worktrees.js';

/**
 * Decide whether a `reserved` entry's owner is provably alive.
 *
 * - A reservation with a complete owner descriptor (`ownerPid` AND
 *   `ownerStartedAt` both non-null) is alive iff {@link isOwnerAlive} says so —
 *   i.e. the PID is present AND its create-time still matches.
 * - A reservation missing either owner field cannot be *proven* alive, so it is
 *   treated as dead (fail-closed toward releasing a lease we can't attribute to
 *   a live process). A well-formed `worktree.reserved` always carries both
 *   fields (see `WorktreeReservedData`); this guards a malformed / partial
 *   replay only.
 *
 * Non-`reserved` states never hold a lease, so this returns `false` for them —
 * callers should gate on `state === 'reserved'` before asking.
 *
 * Pure over the injected {@link ProcessSource}; performs no OS access itself.
 */
export function isReservationOwnerAlive(
  entry: WorktreeEntry,
  source: ProcessSource,
): boolean {
  if (entry.state !== 'reserved') return false;
  if (entry.ownerPid === null || entry.ownerStartedAt === null) {
    // Incomplete ownership → liveness unprovable → treat as dead.
    return false;
  }
  return isOwnerAlive(
    { ownerPid: entry.ownerPid, ownerStartedAt: entry.ownerStartedAt },
    source,
  );
}

/**
 * Heal fold: select the `reserved` entries whose owner is provably dead and must
 * be released.
 *
 * Iterates the projected worktree entries and keeps exactly those that are
 * `reserved` with a non-live owner (PID absent OR create-time mismatch OR an
 * incomplete owner descriptor). A live owner (PID present ∧ recorded create-time
 * matches) is NEVER selected, so the manager never releases a worktree still in
 * active use. Non-`reserved` entries are ignored — only a reservation records a
 * holding process.
 *
 * The result is the input set filtered, in iteration order, so the manager can
 * emit one `worktree.released` per returned entry. Pure over the injected
 * {@link ProcessSource}.
 */
export function selectDeadReservations(
  entries: Iterable<WorktreeEntry>,
  source: ProcessSource,
): WorktreeEntry[] {
  const dead: WorktreeEntry[] = [];
  for (const entry of entries) {
    if (entry.state !== 'reserved') continue;
    if (!isReservationOwnerAlive(entry, source)) {
      dead.push(entry);
    }
  }
  return dead;
}

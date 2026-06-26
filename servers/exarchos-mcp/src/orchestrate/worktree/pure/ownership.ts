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
 * Liveness is delegated to the Task-003 {@link ownerLiveness} primitive, which
 * pairs the recorded PID with the owning process's create-time fingerprint so a
 * recycled PID is correctly read as a *different* (dead) owner — and which
 * surfaces a THIRD `'unknown'` state when the owner could not be probed at all.
 * This module adds only the fold framing — selecting `reserved` entries and
 * coalescing a missing owner descriptor to "dead" — and performs NO OS or
 * filesystem access itself (every probe flows through the injected source). That
 * keeps every heal decision deterministic and table-testable.
 */

import {
  ownerLiveness,
  type OwnerLiveness,
  type ProcessSource,
} from './process-identity.js';
import type { WorktreeEntry } from '../projections/worktrees.js';

/**
 * Three-state {@link OwnerLiveness} of a `reserved` entry's owner.
 *
 * - A reservation with a complete owner descriptor (`ownerPid` AND
 *   `ownerStartedAt` both non-null) defers to {@link ownerLiveness}: `'alive'`
 *   (PID present ∧ create-time matches), `'dead'` (PID absent ∨ create-time
 *   mismatch), or `'unknown'` (the owner could not be probed — permission /
 *   missing tool / unsupported platform; the owner may still be live).
 * - A reservation missing either owner field cannot be probed, so it is `'dead'`
 *   (fail-closed toward releasing a lease we can't attribute to a live process).
 *   A well-formed `worktree.reserved` always carries both fields (see
 *   `WorktreeReservedData`); this guards a malformed / partial replay only.
 * - A non-`reserved` state holds no lease, so it is `'dead'` (no live owner to
 *   protect). Callers should still gate on `state === 'reserved'` before asking.
 *
 * `'unknown'` must NEVER be treated as releasable: only `'dead'` reclaims, and
 * an in-use check treats `'unknown'` like `'alive'` (skip). Pure over the
 * injected {@link ProcessSource}; performs no OS access itself.
 */
export function reservationLiveness(
  entry: WorktreeEntry,
  source: ProcessSource,
): OwnerLiveness {
  if (entry.state !== 'reserved') return 'dead';
  if (entry.ownerPid === null || entry.ownerStartedAt === null) {
    // Incomplete ownership → cannot probe → provably no attributable owner → dead.
    return 'dead';
  }
  return ownerLiveness(
    { ownerPid: entry.ownerPid, ownerStartedAt: entry.ownerStartedAt },
    source,
  );
}

/**
 * Heal fold: select the `reserved` entries whose owner is provably dead and must
 * be released.
 *
 * Iterates the projected worktree entries and keeps exactly those that are
 * `reserved` AND `'dead'` per {@link reservationLiveness} (PID absent OR
 * create-time mismatch OR an incomplete owner descriptor). A live owner (PID
 * present ∧ recorded create-time matches) is NEVER selected, and — critically —
 * neither is an `'unknown'` owner whose probe FAILED: a failed probe is not
 * proof of death, so releasing it could free a still-live reservation. Both
 * `'alive'` and `'unknown'` are therefore left intact. Non-`reserved` entries
 * are ignored — only a reservation records a holding process.
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
    if (reservationLiveness(entry, source) === 'dead') {
      dead.push(entry);
    }
  }
  return dead;
}

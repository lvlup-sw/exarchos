/**
 * Pure ownership decisions for the heal fold of the worktree manager.
 *
 * A worktree is `reserved` while a live process holds it.
 * `WorktreeManager.reconcile` must release each reservation whose owner is
 * dead, and never a live holder. This module returns the reservations whose
 * owner is provably dead. {@link ownerLiveness} pairs the PID with the process
 * create time, so a reused PID reads as a dead owner. This module does no OS
 * or file system access. Each probe goes through the injected {@link ProcessSource}.
 */

import {
  ownerLiveness,
  type OwnerLiveness,
  type ProcessSource,
} from './process-identity.js';
import type { WorktreeEntry } from '../projections/worktrees.js';

/**
 * The {@link OwnerLiveness} of the owner of a `reserved` entry.
 *
 * With both `ownerPid` and `ownerStartedAt`, the result comes from
 * {@link ownerLiveness}: `'alive'`, `'dead'`, or `'unknown'` when the probe
 * failed. Without either field, the owner cannot be probed, so the result is
 * `'dead'`. A state other than `reserved` holds no lease, so it is also
 * `'dead'`. Only `'dead'` permits a release, so `'unknown'` is never released.
 */
export function reservationLiveness(
  entry: WorktreeEntry,
  source: ProcessSource,
): OwnerLiveness {
  if (entry.state !== 'reserved') return 'dead';
  if (entry.ownerPid === null || entry.ownerStartedAt === null) {
    return 'dead';
  }
  return ownerLiveness(
    { ownerPid: entry.ownerPid, ownerStartedAt: entry.ownerStartedAt },
    source,
  );
}

/**
 * Returns the `reserved` entries whose owner is `'dead'` per
 * {@link reservationLiveness}, in input order. An `'alive'` or `'unknown'`
 * owner is never selected, because a failed probe does not prove death. The
 * manager emits one `worktree.released` for each returned entry.
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

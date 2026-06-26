import { describe, it, expect } from 'vitest';

import {
  isReservationOwnerAlive,
  selectDeadReservations,
} from './ownership.js';
import type { ProcessSource } from './process-identity.js';
import type { WorktreeEntry, WorktreeState } from '../projections/worktrees.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Build a WorktreeEntry; owner fields default to a live-looking reservation. */
function entry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    worktreeId: '/wt/a',
    path: '/wt/a',
    featureId: 'feat-1',
    state: 'reserved' satisfies WorktreeState,
    ownerPid: 4242,
    ownerStartedAt: 'start-4242',
    ...overrides,
  };
}

/**
 * A ProcessSource backed by a simple PID→create-time map. A PID absent from the
 * map models an exited process (returns `null`); a PID present with a DIFFERENT
 * create-time models PID reuse by a newer process.
 */
function sourceFrom(table: Record<number, string>): ProcessSource {
  return {
    getStartTime(pid: number): string | null {
      return Object.prototype.hasOwnProperty.call(table, pid)
        ? table[pid]
        : null;
    },
  };
}

// ─── isReservationOwnerAlive ─────────────────────────────────────────────────

describe('isReservationOwnerAlive', () => {
  it('LiveOwner_PidPresentAndStartedAtMatches_IsAlive', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({ 100: 'boot-100' });
    expect(isReservationOwnerAlive(e, source)).toBe(true);
  });

  it('DeadOwner_PidAbsent_IsNotAlive', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({}); // PID 100 has exited
    expect(isReservationOwnerAlive(e, source)).toBe(false);
  });

  it('ReusedPid_CreateTimeMismatch_IsNotAlive', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    // PID 100 is live again but with a NEWER create-time → a different process.
    const source = sourceFrom({ 100: 'boot-999' });
    expect(isReservationOwnerAlive(e, source)).toBe(false);
  });

  it('IncompleteOwner_NullPid_IsTreatedAsDead', () => {
    const e = entry({ ownerPid: null, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({ 100: 'boot-100' });
    expect(isReservationOwnerAlive(e, source)).toBe(false);
  });

  it('IncompleteOwner_NullStartedAt_IsTreatedAsDead', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: null });
    const source = sourceFrom({ 100: 'boot-100' });
    expect(isReservationOwnerAlive(e, source)).toBe(false);
  });

  it('NonReservedState_IsNeverAlive', () => {
    const source = sourceFrom({ 100: 'boot-100' });
    for (const state of ['adopted', 'released', 'orphan'] as WorktreeState[]) {
      const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100', state });
      expect(isReservationOwnerAlive(e, source)).toBe(false);
    }
  });
});

// ─── selectDeadReservations ──────────────────────────────────────────────────

describe('selectDeadReservations', () => {
  it('SelectsOnlyDeadReservedEntries_LeavesLiveAndNonReserved', () => {
    const live = entry({
      worktreeId: '/wt/live',
      ownerPid: 1,
      ownerStartedAt: 'b1',
    });
    const dead = entry({
      worktreeId: '/wt/dead',
      ownerPid: 2,
      ownerStartedAt: 'b2',
    });
    const released = entry({ worktreeId: '/wt/released', state: 'released' });
    const adopted = entry({ worktreeId: '/wt/adopted', state: 'adopted' });

    // PID 1 alive (matching); PID 2 exited.
    const source = sourceFrom({ 1: 'b1' });

    const result = selectDeadReservations(
      [live, dead, released, adopted],
      source,
    );

    expect(result.map((e) => e.worktreeId)).toEqual(['/wt/dead']);
  });

  it('LiveOwner_NeverSelected', () => {
    const live = entry({ ownerPid: 7, ownerStartedAt: 'b7' });
    const source = sourceFrom({ 7: 'b7' });
    expect(selectDeadReservations([live], source)).toEqual([]);
  });

  it('PreservesIterationOrder', () => {
    const a = entry({ worktreeId: '/wt/a', ownerPid: 10, ownerStartedAt: 'x' });
    const b = entry({ worktreeId: '/wt/b', ownerPid: 11, ownerStartedAt: 'x' });
    const c = entry({ worktreeId: '/wt/c', ownerPid: 12, ownerStartedAt: 'x' });
    const source = sourceFrom({}); // all exited
    const result = selectDeadReservations([a, b, c], source);
    expect(result.map((e) => e.worktreeId)).toEqual(['/wt/a', '/wt/b', '/wt/c']);
  });

  it('EmptyInput_ReturnsEmpty', () => {
    expect(selectDeadReservations([], sourceFrom({}))).toEqual([]);
  });
});

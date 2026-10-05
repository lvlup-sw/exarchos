import { describe, it, expect } from 'vitest';

import {
  reservationLiveness,
  selectDeadReservations,
} from '../../../../../src/verbs/worktree/pure/ownership.js';
import type { ProcessSource, StartTimeProbe } from '../../../../../src/verbs/worktree/pure/process-identity.js';
import type { WorktreeEntry, WorktreeState } from '../../../../../src/verbs/worktree/projections/worktrees.js';

/** Builds a `WorktreeEntry`. The owner fields default to a live-looking reservation. */
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
 * A `ProcessSource` backed by a map from PID to create time. A PID that is not
 * in the map is an exited process, and its probe is `absent`.
 */
function sourceFrom(table: Record<number, string>): ProcessSource {
  return {
    getStartTime(pid: number): StartTimeProbe {
      return Object.prototype.hasOwnProperty.call(table, pid)
        ? { status: 'present', startedAt: table[pid] }
        : { status: 'absent' };
    },
  };
}

/** A `ProcessSource` whose probe always fails, as with a permission error or a missing tool. */
const UNKNOWN_SOURCE: ProcessSource = {
  getStartTime: (): StartTimeProbe => ({ status: 'unknown' }),
};

describe('reservationLiveness', () => {
  it('LiveOwner_PidPresentAndStartedAtMatches_IsAlive', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({ 100: 'boot-100' });
    expect(reservationLiveness(e, source)).toBe('alive');
  });

  it('DeadOwner_PidAbsent_IsDead', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({});
    expect(reservationLiveness(e, source)).toBe('dead');
  });

  /** A live PID with a different create time belongs to a different process. */
  it('ReusedPid_CreateTimeMismatch_IsDead', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({ 100: 'boot-999' });
    expect(reservationLiveness(e, source)).toBe('dead');
  });

  /**
   * A failed probe does not prove death. The result is `unknown`, so a caller
   * does not reclaim a reservation that can still be live.
   */
  it('ProbeFailed_IsUnknown_NotDead', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    expect(reservationLiveness(e, UNKNOWN_SOURCE)).toBe('unknown');
  });

  it('IncompleteOwner_NullPid_IsTreatedAsDead', () => {
    const e = entry({ ownerPid: null, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({ 100: 'boot-100' });
    expect(reservationLiveness(e, source)).toBe('dead');
  });

  it('IncompleteOwner_NullStartedAt_IsTreatedAsDead', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: null });
    const source = sourceFrom({ 100: 'boot-100' });
    expect(reservationLiveness(e, source)).toBe('dead');
  });

  /**
   * A null owner create time means that no live owner can be matched. The result
   * is `dead` for any probe outcome, so the heal fold releases the reservation.
   */
  it('ReservationLiveness_NullOwnerStartedAt_TreatedFailClosed', () => {
    const nullStart = entry({ ownerPid: 100, ownerStartedAt: null });
    const livePidSource = sourceFrom({ 100: 'boot-100' });
    expect(reservationLiveness(nullStart, livePidSource)).toBe('dead');

    expect(reservationLiveness(nullStart, UNKNOWN_SOURCE)).toBe('dead');

    expect(
      selectDeadReservations([nullStart], livePidSource).map((e) => e.worktreeId),
    ).toEqual([nullStart.worktreeId]);
  });

  it('NonReservedState_IsDead', () => {
    const source = sourceFrom({ 100: 'boot-100' });
    for (const state of ['adopted', 'released', 'orphan'] as WorktreeState[]) {
      const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100', state });
      expect(reservationLiveness(e, source)).toBe('dead');
    }
  });
});

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
    const source = sourceFrom({});
    const result = selectDeadReservations([a, b, c], source);
    expect(result.map((e) => e.worktreeId)).toEqual(['/wt/a', '/wt/b', '/wt/c']);
  });

  it('EmptyInput_ReturnsEmpty', () => {
    expect(selectDeadReservations([], sourceFrom({}))).toEqual([]);
  });

  /**
   * Only a provably dead owner is selected. A reservation whose probe failed
   * stays, because its owner can still be live. An absent PID is selected.
   */
  it('ProbeFailedOwner_IsNotReleased_ButAbsentOwnerIs', () => {
    const unprovable = entry({
      worktreeId: '/wt/unprovable',
      ownerPid: 100,
      ownerStartedAt: 'boot-100',
    });
    const absent = entry({
      worktreeId: '/wt/absent',
      ownerPid: 200,
      ownerStartedAt: 'boot-200',
    });

    const mixedSource: ProcessSource = {
      getStartTime: (pid: number): StartTimeProbe =>
        pid === 100 ? { status: 'unknown' } : { status: 'absent' },
    };

    const result = selectDeadReservations([unprovable, absent], mixedSource);

    expect(result.map((e) => e.worktreeId)).toEqual(['/wt/absent']);
  });
});

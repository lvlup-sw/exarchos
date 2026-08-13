import { describe, it, expect } from 'vitest';

import {
  reservationLiveness,
  selectDeadReservations,
} from '../../../../../src/verbs/worktree/pure/ownership.js';
import type { ProcessSource, StartTimeProbe } from '../../../../../src/verbs/worktree/pure/process-identity.js';
import type { WorktreeEntry, WorktreeState } from '../../../../../src/verbs/worktree/projections/worktrees.js';

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
 * map models an exited process (probe `absent`); a PID present with a DIFFERENT
 * create-time models PID reuse by a newer process.
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

/** A ProcessSource whose probe ALWAYS fails (permission / missing tool). */
const UNKNOWN_SOURCE: ProcessSource = {
  getStartTime: (): StartTimeProbe => ({ status: 'unknown' }),
};

// ─── reservationLiveness ─────────────────────────────────────────────────────

describe('reservationLiveness', () => {
  it('LiveOwner_PidPresentAndStartedAtMatches_IsAlive', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({ 100: 'boot-100' });
    expect(reservationLiveness(e, source)).toBe('alive');
  });

  it('DeadOwner_PidAbsent_IsDead', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    const source = sourceFrom({}); // PID 100 has exited
    expect(reservationLiveness(e, source)).toBe('dead');
  });

  it('ReusedPid_CreateTimeMismatch_IsDead', () => {
    const e = entry({ ownerPid: 100, ownerStartedAt: 'boot-100' });
    // PID 100 is live again but with a NEWER create-time → a different process.
    const source = sourceFrom({ 100: 'boot-999' });
    expect(reservationLiveness(e, source)).toBe('dead');
  });

  it('ProbeFailed_IsUnknown_NotDead', () => {
    // The owner could not be probed at all — NOT proof of death. `unknown` so a
    // caller never reclaims a possibly-live reservation on a probe failure.
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

  it('ReservationLiveness_NullOwnerStartedAt_TreatedFailClosed', () => {
    // DR-5: a reservation whose owner create-time is null (the platform could not
    // resolve it at reserve time — threaded as null, NEVER '') has NO attributable
    // live owner. Liveness fails closed toward reclamation: it is 'dead' (never
    // 'alive'/'unknown'), so the heal fold can free a phantom that can never be
    // matched to a live process — even when the recorded PID is present with a
    // live-looking create-time in the table.
    const nullStart = entry({ ownerPid: 100, ownerStartedAt: null });
    const livePidSource = sourceFrom({ 100: 'boot-100' });
    expect(reservationLiveness(nullStart, livePidSource)).toBe('dead');

    // Independent of the probe outcome: an unprobeable source yields 'dead' too —
    // the null owner descriptor short-circuits before the source is consulted.
    expect(reservationLiveness(nullStart, UNKNOWN_SOURCE)).toBe('dead');

    // And such a reservation is selected for release by the heal fold.
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

  it('ProbeFailedOwner_IsNotReleased_ButAbsentOwnerIs', () => {
    // The owner-liveness probe is three-state: only a PROVABLY dead owner is
    // selected for release. A reservation whose probe FAILED (`unknown`) is left
    // intact — releasing it could free a still-live reservation (the Major bug).
    // A genuinely-absent PID is still selected, so heal still works.
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

    // PID 100 fails to probe (unknown); PID 200 is absent (dead).
    const mixedSource: ProcessSource = {
      getStartTime: (pid: number): StartTimeProbe =>
        pid === 100 ? { status: 'unknown' } : { status: 'absent' },
    };

    const result = selectDeadReservations([unprovable, absent], mixedSource);

    // Only the provably-absent owner is released; the probe-failed one is kept.
    expect(result.map((e) => e.worktreeId)).toEqual(['/wt/absent']);
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  isOwnerAlive,
  defaultProcessSource,
  type OwnerDescriptor,
  type ProcessSource,
} from './process-identity.js';

/** Build a stub ProcessSource whose getStartTime returns a fixed value. */
function sourceReturning(value: string | null): ProcessSource {
  return { getStartTime: vi.fn().mockReturnValue(value) };
}

describe('isOwnerAlive', () => {
  const owner: OwnerDescriptor = { ownerPid: 1234, ownerStartedAt: 'orig-create-time' };

  it('ProcessIdentity_PidAbsentOrStartedAtMismatch_ReportsDead', () => {
    // PID absent: the owning process exited -> dead.
    const absentSource = sourceReturning(null);
    expect(isOwnerAlive(owner, absentSource)).toBe(false);
    expect(absentSource.getStartTime).toHaveBeenCalledWith(1234);

    // PID present but create-time differs: the PID was reused by a newer
    // process (later create-time) -> the original owner is dead.
    const reusedSource = sourceReturning('newer-create-time');
    expect(isOwnerAlive(owner, reusedSource)).toBe(false);
    expect(reusedSource.getStartTime).toHaveBeenCalledWith(1234);
  });

  it('ProcessIdentity_PidPresentAndStartedAtMatches_ReportsAlive', () => {
    // Same PID, same create-time: it is still the original process -> alive.
    const liveSource = sourceReturning('orig-create-time');
    expect(isOwnerAlive(owner, liveSource)).toBe(true);
    expect(liveSource.getStartTime).toHaveBeenCalledWith(1234);
  });

  it('ProcessIdentity_CreateTime_ResolvesOnLinuxMacWindows', () => {
    // The decision must be uniform across each platform's create-time *shape* —
    // the strings are opaque and compared only for equality. For each shimmed
    // platform: a matching create-time is alive; a reused (different) one is
    // dead. No real OS calls — the source is injected per platform.
    const platforms = [
      { name: 'linux', startedAt: '8923145', reused: '9001000' }, // /proc starttime jiffies
      {
        name: 'darwin',
        startedAt: 'Wed Jun 25 10:23:45 2026',
        reused: 'Thu Jun 26 11:00:00 2026',
      }, // ps lstart
      { name: 'win32', startedAt: '133600000000000000', reused: '133700000000000000' }, // FILETIME
    ];

    for (const platform of platforms) {
      const platformOwner: OwnerDescriptor = {
        ownerPid: 4242,
        ownerStartedAt: platform.startedAt,
      };

      // Same process: source reports the recorded create-time -> alive.
      expect(
        isOwnerAlive(platformOwner, sourceReturning(platform.startedAt)),
        `${platform.name}: matching create-time should be alive`,
      ).toBe(true);

      // PID reuse: source reports a different (later) create-time -> dead.
      expect(
        isOwnerAlive(platformOwner, sourceReturning(platform.reused)),
        `${platform.name}: reused PID create-time should be dead`,
      ).toBe(false);

      // PID gone on this platform -> dead.
      expect(
        isOwnerAlive(platformOwner, sourceReturning(null)),
        `${platform.name}: absent PID should be dead`,
      ).toBe(false);
    }
  });
});

describe('defaultProcessSource', () => {
  it('short-circuits non-positive PIDs to null without any OS access', () => {
    // pid <= 0 can never be a live owner; the default source returns null
    // before probing the OS (no spawn, no /proc read) — keeps the unit test
    // free of real OS calls and deterministic on every platform.
    expect(defaultProcessSource.getStartTime(0)).toBeNull();
    expect(defaultProcessSource.getStartTime(-1)).toBeNull();
  });
});

import { describe, it, expect, vi } from 'vitest';
import {
  ownerLiveness,
  resolveStartedAt,
  defaultProcessSource,
  type OwnerDescriptor,
  type ProcessSource,
  type StartTimeProbe,
} from '../../../../../src/verbs/worktree/pure/process-identity.js';

/**
 * A stub `ProcessSource` whose `getStartTime` returns a fixed probe. A string
 * is a present PID with that create time. The value `null` is an exited PID.
 */
function sourceReturning(value: string | null): ProcessSource {
  const probe: StartTimeProbe =
    value === null ? { status: 'absent' } : { status: 'present', startedAt: value };
  return { getStartTime: vi.fn().mockReturnValue(probe) };
}

/** A source whose probe cannot run, so the presence of the PID is not known. */
function sourceUnknown(): ProcessSource {
  return { getStartTime: vi.fn().mockReturnValue({ status: 'unknown' } satisfies StartTimeProbe) };
}

describe('ownerLiveness', () => {
  const owner: OwnerDescriptor = { ownerPid: 1234, ownerStartedAt: 'orig-create-time' };

  /** A present PID with a different create time is a reused PID, so the original owner is dead. */
  it('ProcessIdentity_PidAbsentOrStartedAtMismatch_ReportsDead', () => {
    const absentSource = sourceReturning(null);
    expect(ownerLiveness(owner, absentSource)).toBe('dead');
    expect(absentSource.getStartTime).toHaveBeenCalledWith(1234);

    const reusedSource = sourceReturning('newer-create-time');
    expect(ownerLiveness(owner, reusedSource)).toBe('dead');
    expect(reusedSource.getStartTime).toHaveBeenCalledWith(1234);
  });

  it('ProcessIdentity_PidPresentAndStartedAtMatches_ReportsAlive', () => {
    const liveSource = sourceReturning('orig-create-time');
    expect(ownerLiveness(owner, liveSource)).toBe('alive');
    expect(liveSource.getStartTime).toHaveBeenCalledWith(1234);
  });

  /**
   * A failed probe does not prove death, so the result is `unknown`, not
   * `dead`. Then a probe failure cannot release a reservation that is still live.
   */
  it('ProcessIdentity_ProbeCouldNotRun_ReportsUnknown_NotDead', () => {
    const unknownSource = sourceUnknown();
    expect(ownerLiveness(owner, unknownSource)).toBe('unknown');
    expect(unknownSource.getStartTime).toHaveBeenCalledWith(1234);
  });

  /**
   * The create time is an opaque string, compared only for equality. The cases
   * use the Linux `/proc` `starttime`, the macOS `ps` `lstart`, and the Windows
   * FILETIME shapes, through an injected source with no OS calls.
   */
  it('ProcessIdentity_CreateTime_ResolvesOnLinuxMacWindows', () => {
    const platforms = [
      { name: 'linux', startedAt: '8923145', reused: '9001000' },
      {
        name: 'darwin',
        startedAt: 'Wed Jun 25 10:23:45 2026',
        reused: 'Thu Jun 26 11:00:00 2026',
      },
      { name: 'win32', startedAt: '133600000000000000', reused: '133700000000000000' },
    ];

    for (const platform of platforms) {
      const platformOwner: OwnerDescriptor = {
        ownerPid: 4242,
        ownerStartedAt: platform.startedAt,
      };

      expect(
        ownerLiveness(platformOwner, sourceReturning(platform.startedAt)),
        `${platform.name}: matching create-time should be alive`,
      ).toBe('alive');

      expect(
        ownerLiveness(platformOwner, sourceReturning(platform.reused)),
        `${platform.name}: reused PID create-time should be dead`,
      ).toBe('dead');

      expect(
        ownerLiveness(platformOwner, sourceReturning(null)),
        `${platform.name}: absent PID should be dead`,
      ).toBe('dead');
    }
  });
});

describe('resolveStartedAt', () => {
  /**
   * An absent PID, a failed probe, and an empty create time all give `null`,
   * never an empty string. No liveness probe can match an empty create time.
   */
  it('ResolveStartedAt_UnresolvableOrEmpty_ReturnsNullNeverEmptyString', () => {
    expect(resolveStartedAt(sourceReturning(null), 4242)).toBeNull();

    expect(resolveStartedAt(sourceUnknown(), 4242)).toBeNull();

    const emptyPresent: ProcessSource = {
      getStartTime: vi.fn().mockReturnValue({ status: 'present', startedAt: '' } satisfies StartTimeProbe),
    };
    const empty = resolveStartedAt(emptyPresent, 4242);
    expect(empty).toBeNull();
    expect(empty).not.toBe('');
  });

  it('ResolveStartedAt_PresentNonEmpty_ReturnsCreateTimeVerbatim', () => {
    expect(resolveStartedAt(sourceReturning('8923145'), 4242)).toBe('8923145');
  });
});

describe('defaultProcessSource', () => {
  /** A PID of zero or less cannot be a live owner, so the default source returns `absent` before any OS call. */
  it('short-circuits non-positive PIDs to absent without any OS access', () => {
    expect(defaultProcessSource.getStartTime(0)).toEqual({ status: 'absent' });
    expect(defaultProcessSource.getStartTime(-1)).toEqual({ status: 'absent' });
  });
});

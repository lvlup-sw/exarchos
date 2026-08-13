import { describe, it, expect, vi } from 'vitest';
import {
  ownerLiveness,
  resolveStartedAt,
  defaultProcessSource,
  type OwnerDescriptor,
  type ProcessSource,
  type StartTimeProbe,
} from './process-identity.js';

/**
 * Build a stub ProcessSource whose getStartTime returns a fixed probe. A string
 * models a present PID with that create-time; `null` models an absent (exited)
 * PID. (Probe-failed `unknown` is exercised via {@link sourceUnknown}.)
 */
function sourceReturning(value: string | null): ProcessSource {
  const probe: StartTimeProbe =
    value === null ? { status: 'absent' } : { status: 'present', startedAt: value };
  return { getStartTime: vi.fn().mockReturnValue(probe) };
}

/** A source whose probe COULD NOT RUN — present-or-absent is unknowable. */
function sourceUnknown(): ProcessSource {
  return { getStartTime: vi.fn().mockReturnValue({ status: 'unknown' } satisfies StartTimeProbe) };
}

describe('ownerLiveness', () => {
  const owner: OwnerDescriptor = { ownerPid: 1234, ownerStartedAt: 'orig-create-time' };

  it('ProcessIdentity_PidAbsentOrStartedAtMismatch_ReportsDead', () => {
    // PID absent: the owning process exited -> dead.
    const absentSource = sourceReturning(null);
    expect(ownerLiveness(owner, absentSource)).toBe('dead');
    expect(absentSource.getStartTime).toHaveBeenCalledWith(1234);

    // PID present but create-time differs: the PID was reused by a newer
    // process (later create-time) -> the original owner is dead.
    const reusedSource = sourceReturning('newer-create-time');
    expect(ownerLiveness(owner, reusedSource)).toBe('dead');
    expect(reusedSource.getStartTime).toHaveBeenCalledWith(1234);
  });

  it('ProcessIdentity_PidPresentAndStartedAtMatches_ReportsAlive', () => {
    // Same PID, same create-time: it is still the original process -> alive.
    const liveSource = sourceReturning('orig-create-time');
    expect(ownerLiveness(owner, liveSource)).toBe('alive');
    expect(liveSource.getStartTime).toHaveBeenCalledWith(1234);
  });

  it('ProcessIdentity_ProbeCouldNotRun_ReportsUnknown_NotDead', () => {
    // The create-time probe FAILED (permission / missing ps|PowerShell /
    // unsupported platform). The owner may still be live — it is NOT proven
    // dead — so liveness is `unknown`, distinct from `dead`. This is the seam
    // that stops a probe failure from releasing a still-live reservation.
    const unknownSource = sourceUnknown();
    expect(ownerLiveness(owner, unknownSource)).toBe('unknown');
    expect(unknownSource.getStartTime).toHaveBeenCalledWith(1234);
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
        ownerLiveness(platformOwner, sourceReturning(platform.startedAt)),
        `${platform.name}: matching create-time should be alive`,
      ).toBe('alive');

      // PID reuse: source reports a different (later) create-time -> dead.
      expect(
        ownerLiveness(platformOwner, sourceReturning(platform.reused)),
        `${platform.name}: reused PID create-time should be dead`,
      ).toBe('dead');

      // PID gone on this platform -> dead.
      expect(
        ownerLiveness(platformOwner, sourceReturning(null)),
        `${platform.name}: absent PID should be dead`,
      ).toBe('dead');
    }
  });
});

describe('resolveStartedAt', () => {
  it('ResolveStartedAt_UnresolvableOrEmpty_ReturnsNullNeverEmptyString', () => {
    // DR-5: the create-time-resolution seam coalesces EVERY non-resolvable
    // outcome to null and NEVER returns '' — an empty create-time is a value no
    // liveness probe can equality-match, so persisting it is the invalid class.

    // absent PID → null.
    expect(resolveStartedAt(sourceReturning(null), 4242)).toBeNull();

    // probe could not run (unknown) → null.
    expect(resolveStartedAt(sourceUnknown(), 4242)).toBeNull();

    // present but EMPTY create-time → coalesced to null (never '').
    const emptyPresent: ProcessSource = {
      getStartTime: vi.fn().mockReturnValue({ status: 'present', startedAt: '' } satisfies StartTimeProbe),
    };
    const empty = resolveStartedAt(emptyPresent, 4242);
    expect(empty).toBeNull();
    expect(empty).not.toBe('');
  });

  it('ResolveStartedAt_PresentNonEmpty_ReturnsCreateTimeVerbatim', () => {
    // A resolved, non-empty create-time threads through unchanged (defeats reuse).
    expect(resolveStartedAt(sourceReturning('8923145'), 4242)).toBe('8923145');
  });
});

describe('defaultProcessSource', () => {
  it('short-circuits non-positive PIDs to absent without any OS access', () => {
    // pid <= 0 can never be a live owner; the default source returns an `absent`
    // probe before touching the OS (no spawn, no /proc read) — keeps the unit
    // test free of real OS calls and deterministic on every platform.
    expect(defaultProcessSource.getStartTime(0)).toEqual({ status: 'absent' });
    expect(defaultProcessSource.getStartTime(-1)).toEqual({ status: 'absent' });
  });
});

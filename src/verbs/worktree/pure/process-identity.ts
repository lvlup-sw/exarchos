/**
 * Portable process identity for worktree-lock ownership.
 * The kernel reuses PIDs, so a PID alone cannot prove that a lock owner is the same process.
 * This module pairs the recorded PID with the create-time of the owner process, so a reused PID reads as a different, dead owner.
 *
 * Liveness has three states. `alive`: the PID is present and its create-time matches.
 * `dead`: the PID is absent, or its create-time differs.
 * `unknown`: the create-time probe cannot run, so the caller must not reclaim the lock.
 * The pure decision takes an injected {@link ProcessSource}, so tests need no OS calls.
 */

import { readFileSync } from 'node:fs';
import { isPidAlive } from '../../../utils/process.js';
import { runCommandSync } from '../../../utils/process.js';

/** The process that owns a resource, such as a worktree lock, as recorded at claim time. */
export interface OwnerDescriptor {
  /** The PID recorded when ownership was claimed. */
  ownerPid: number;
  /**
   * The create-time of the owner process at claim time.
   * It is an opaque platform string (Linux clock ticks since boot, macOS `lstart`, Windows FILETIME), compared only for equality.
   */
  ownerStartedAt: string;
}

/** Liveness verdict for a recorded owner. `'unknown'` is not `'dead'`, so a failed probe never lets a caller reclaim a worktree. */
export type OwnerLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Result of a create-time probe for a PID.
 * `present`: a live process holds the PID, and `startedAt` is its create-time.
 * `absent`: no process holds the PID.
 * `unknown`: the create-time did not resolve, for example because of a permission error, a missing `ps` or PowerShell, or an unsupported platform.
 * The process can still be alive, so liveness fails closed.
 */
export type StartTimeProbe =
  | { readonly status: 'present'; readonly startedAt: string }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown' };

/** Injected view of the host process table, so tests of the liveness logic need no OS. The signature has no platform detail. */
export interface ProcessSource {
  /** Probes the process that holds `pid` now. See {@link StartTimeProbe}. */
  getStartTime(pid: number): StartTimeProbe;
}

/**
 * Decides the {@link OwnerLiveness} of `owner` through the injected {@link ProcessSource}.
 * It returns `alive` only when the PID is present and its create-time equals `ownerStartedAt`.
 * A different create-time means that the kernel gave the PID to a new process, so the owner is `dead`.
 * An `unknown` probe returns `unknown`, and the caller must treat the owner as in use.
 */
export function ownerLiveness(owner: OwnerDescriptor, source: ProcessSource): OwnerLiveness {
  const probe = source.getStartTime(owner.ownerPid);
  if (probe.status === 'absent') {
    return 'dead';
  }
  if (probe.status === 'unknown') {
    return 'unknown';
  }
  return probe.startedAt === owner.ownerStartedAt ? 'alive' : 'dead';
}

/**
 * Resolves the create-time of `pid` to a non-empty string, for the `ownerStartedAt` stamp on a reservation.
 * It returns `null` for an `absent` or `unknown` probe, and for an empty create-time.
 * It never returns `''`, because no probe can match an empty value, and the event schema rejects it.
 * `WorktreeReservedData.ownerStartedAt` accepts `null`, which reads as no live owner.
 */
export function resolveStartedAt(source: ProcessSource, pid: number): string | null {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' && probe.startedAt.length > 0
    ? probe.startedAt
    : null;
}

/**
 * Reads the create-time of a live PID for the platform, or returns `null` when it does not resolve.
 * On Linux it reads field 22 (`starttime`) of `/proc/<pid>/stat`. The command field can hold spaces and parentheses, so it splits after the last `)`.
 * The split starts at field 3, so field 22 is `tail[19]`.
 * On macOS it reads `ps -o lstart=`.
 * On Windows it reads the PowerShell create-time as a FILETIME through `runCommandSync`, which handles the shim and quoting.
 */
function readCreateTime(pid: number, platform: NodeJS.Platform): string | null {
  try {
    if (platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const starttime = tail[19];
      return starttime && /^\d+$/.test(starttime) ? starttime : null;
    }

    if (platform === 'darwin') {
      const out = runCommandSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const value = (typeof out === 'string' ? out : out.toString('utf8')).trim();
      return value || null;
    }

    if (platform === 'win32') {
      const out = runCommandSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const value = (typeof out === 'string' ? out : out.toString('utf8')).trim();
      return value || null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Default {@link ProcessSource} for the real OS. It checks the PID with the signal-0 probe `isPidAlive` first.
 * An absent PID returns `absent` and starts no child process.
 * A present PID with an unreadable create-time returns `unknown`, not `absent`, so the caller fails closed.
 */
export const defaultProcessSource: ProcessSource = {
  getStartTime(pid: number): StartTimeProbe {
    if (pid <= 0 || !isPidAlive(pid)) {
      return { status: 'absent' };
    }
    const startedAt = readCreateTime(pid, process.platform);
    return startedAt === null
      ? { status: 'unknown' }
      : { status: 'present', startedAt };
  },
};

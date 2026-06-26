/**
 * Portable process-identity primitive for worktree-lock ownership.
 *
 * A PID alone cannot decide whether the process that claimed a worktree lock is
 * still the same one: the kernel recycles PIDs once its counter wraps, so a
 * stale lock's PID may have been reassigned to an unrelated live process. This
 * module pairs the recorded PID with the owning process's **create-time**
 * fingerprint — the future-work that `utils/process.ts#isPidAlive` flags — so a
 * reused PID is correctly read as a *different* (dead) owner.
 *
 * The pure decision (`isOwnerAlive`) takes an injected {@link ProcessSource} so
 * the liveness logic is unit-testable with platform-shimmed create-times and no
 * real OS calls. The default real source ({@link defaultProcessSource})
 * resolves create-time portably across linux / macOS / Windows behind that same
 * platform-agnostic signature.
 */

import { readFileSync } from 'node:fs';
import { isPidAlive } from '../../../utils/process.js';
import { runCommandSync } from '../../../utils/process.js';

// ============================================================
// Types
// ============================================================

/**
 * Identifies the process that owns a resource (e.g. a worktree lock), captured
 * at claim time.
 */
export interface OwnerDescriptor {
  /** The PID recorded when ownership was claimed. */
  ownerPid: number;
  /**
   * The owning process's create-time, captured at claim time. An opaque,
   * platform-defined string (Linux jiffies-since-boot, macOS `lstart`, Windows
   * FILETIME) — compared only for equality, never parsed.
   */
  ownerStartedAt: string;
}

/**
 * Abstraction over the host process table. Injected so the liveness logic is
 * testable without touching the real OS. The signature is deliberately
 * platform-agnostic — no syscall shape leaks through it.
 */
export interface ProcessSource {
  /**
   * The create-time of the process currently holding `pid`, or `null` when no
   * process holds that PID (it has exited). The returned string is opaque and
   * only ever compared for equality against a recorded `ownerStartedAt`.
   */
  getStartTime(pid: number): string | null;
}

// ============================================================
// Pure decision
// ============================================================

/**
 * Decide whether `owner` is still alive.
 *
 * - **Alive** iff the PID is present AND its create-time equals the recorded
 *   `ownerStartedAt`.
 * - **Dead** iff the PID is absent (the process exited) OR the create-time
 *   differs. A later create-time on the same PID means the kernel handed that
 *   PID to a *new* process (PID reuse) — the original owner is gone. The
 *   create-time equality check is what defeats reuse misattribution.
 *
 * Pure over its injected {@link ProcessSource}; performs no OS access itself.
 */
export function isOwnerAlive(owner: OwnerDescriptor, source: ProcessSource): boolean {
  const currentStartTime = source.getStartTime(owner.ownerPid);
  if (currentStartTime === null) {
    return false; // PID absent -> the owning process exited -> dead.
  }
  // PID present: alive only if it is the SAME process (same create-time).
  // A mismatch means the PID was reused by a newer process -> owner is dead.
  return currentStartTime === owner.ownerStartedAt;
}

// ============================================================
// Default real source (portable; thin)
// ============================================================

/**
 * Read the create-time fingerprint for a live PID, per platform. Returns `null`
 * when it cannot be resolved (absent PID, permission error, or unsupported
 * platform). Kept thin — the testable logic lives in {@link isOwnerAlive}; this
 * is exercised only through {@link defaultProcessSource}.
 */
function readCreateTime(pid: number, platform: NodeJS.Platform): string | null {
  try {
    if (platform === 'linux') {
      // /proc/<pid>/stat field 22 (1-indexed) is `starttime` — clock ticks
      // since boot, stable for the life of the process. The comm field (2) is
      // wrapped in parens and may itself contain spaces/parens, so split the
      // tail AFTER the final ')'. After comm, tail[0] is `state` (field 3),
      // so starttime is tail[22 - 3] = tail[19].
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const starttime = tail[19];
      return starttime && /^\d+$/.test(starttime) ? starttime : null;
    }

    if (platform === 'darwin') {
      // macOS has no /proc; `ps -o lstart=` prints the process start timestamp
      // (e.g. "Wed Jun 25 10:23:45 2026"), empty/erroring when the PID is gone.
      const out = runCommandSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const value = (typeof out === 'string' ? out : out.toString('utf8')).trim();
      return value || null;
    }

    if (platform === 'win32') {
      // PowerShell exposes the create-time as a FILETIME — a monotonically
      // increasing 64-bit integer, so a reused PID yields a strictly larger
      // value. `runCommandSync` keeps the shim/quoting handling consistent with
      // the rest of the codebase (#1623).
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
 * Default {@link ProcessSource} backed by the real OS.
 *
 * Liveness is probed with the portable signal-0 check (`isPidAlive`); only when
 * the PID is present is the create-time read (so an absent PID short-circuits to
 * `null` without spawning a child process). The create-time read branches by
 * `process.platform` internally — the platform detail never reaches the
 * {@link ProcessSource} signature.
 */
export const defaultProcessSource: ProcessSource = {
  getStartTime(pid: number): string | null {
    if (pid <= 0 || !isPidAlive(pid)) {
      return null;
    }
    return readCreateTime(pid, process.platform);
  },
};

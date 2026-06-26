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
 * The pure decision (`ownerLiveness`) takes an injected {@link ProcessSource} so
 * the liveness logic is unit-testable with platform-shimmed create-times and no
 * real OS calls. The default real source ({@link defaultProcessSource})
 * resolves create-time portably across linux / macOS / Windows behind that same
 * platform-agnostic signature.
 *
 * ## Liveness is THREE-state, not a boolean
 *
 * A PID probe has three outcomes, and collapsing the last two into "dead" can
 * release a still-live owner:
 *
 *   - **alive**   — the PID is present AND its create-time matches the recorded
 *                   fingerprint (provably the same process).
 *   - **dead**    — the PID is absent (the process exited) OR a present PID's
 *                   create-time differs (PID reuse by a newer process).
 *   - **unknown** — the create-time probe could not be RUN at all (permission
 *                   error, missing `ps` / PowerShell, unsupported platform). The
 *                   process may well still be alive; we just could not prove it
 *                   either way, so the caller MUST treat it as "do not reclaim"
 *                   (fail-closed) rather than as dead.
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
 * Three-state liveness verdict for a recorded owner. `'unknown'` (the probe
 * could not run) is DISTINCT from `'dead'` (the process provably exited / was
 * reused) so callers never reclaim a worktree whose owner merely failed to
 * probe. See the module header.
 */
export type OwnerLiveness = 'alive' | 'dead' | 'unknown';

/**
 * Outcome of probing a PID's create-time:
 *
 *   - `present` — the PID is held by a live process; `startedAt` is its opaque
 *     create-time fingerprint (compared only for equality).
 *   - `absent`  — no process holds that PID (it has exited).
 *   - `unknown` — the create-time could NOT be resolved (permission error,
 *     missing `ps`/PowerShell, unsupported platform). The process may still be
 *     alive — distinct from `absent` precisely so liveness can fail closed.
 */
export type StartTimeProbe =
  | { readonly status: 'present'; readonly startedAt: string }
  | { readonly status: 'absent' }
  | { readonly status: 'unknown' };

/**
 * Abstraction over the host process table. Injected so the liveness logic is
 * testable without touching the real OS. The signature is deliberately
 * platform-agnostic — no syscall shape leaks through it.
 */
export interface ProcessSource {
  /**
   * Probe the process currently holding `pid` — see {@link StartTimeProbe}. The
   * `present` create-time string is opaque and only ever compared for equality
   * against a recorded `ownerStartedAt`.
   */
  getStartTime(pid: number): StartTimeProbe;
}

// ============================================================
// Pure decision
// ============================================================

/**
 * Decide the three-state {@link OwnerLiveness} of `owner`.
 *
 * - **alive** iff the PID is present AND its create-time equals the recorded
 *   `ownerStartedAt`.
 * - **dead** iff the PID is absent (the process exited) OR the create-time
 *   differs. A later create-time on the same PID means the kernel handed that
 *   PID to a *new* process (PID reuse) — the original owner is gone. The
 *   create-time equality check is what defeats reuse misattribution.
 * - **unknown** iff the create-time could not be probed at all. The owner may
 *   still be live, so callers MUST fail closed (treat as in-use, never release).
 *
 * Pure over its injected {@link ProcessSource}; performs no OS access itself.
 */
export function ownerLiveness(owner: OwnerDescriptor, source: ProcessSource): OwnerLiveness {
  const probe = source.getStartTime(owner.ownerPid);
  if (probe.status === 'absent') {
    return 'dead'; // PID absent -> the owning process exited -> dead.
  }
  if (probe.status === 'unknown') {
    return 'unknown'; // probe could not run -> NOT proven dead -> fail closed.
  }
  // PID present: alive only if it is the SAME process (same create-time).
  // A mismatch means the PID was reused by a newer process -> owner is dead.
  return probe.startedAt === owner.ownerStartedAt ? 'alive' : 'dead';
}

// ============================================================
// Default real source (portable; thin)
// ============================================================

/**
 * Read the create-time fingerprint for a live PID, per platform. Returns `null`
 * when it cannot be resolved (absent PID, permission error, or unsupported
 * platform). Kept thin — the testable logic lives in {@link ownerLiveness};
 * this is exercised only through {@link defaultProcessSource}, which maps a
 * `null` (probe-could-not-run) here onto the `unknown` {@link StartTimeProbe}
 * status when the PID is otherwise present.
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
 * `absent` without spawning a child process). A present PID whose create-time
 * cannot be read (permission / missing `ps`/PowerShell / unsupported platform)
 * resolves to `unknown` — NOT `absent` — so the caller fails closed instead of
 * reclaiming a possibly-live owner. The create-time read branches by
 * `process.platform` internally — the platform detail never reaches the
 * {@link ProcessSource} signature.
 */
export const defaultProcessSource: ProcessSource = {
  getStartTime(pid: number): StartTimeProbe {
    if (pid <= 0 || !isPidAlive(pid)) {
      return { status: 'absent' };
    }
    const startedAt = readCreateTime(pid, process.platform);
    return startedAt === null
      ? { status: 'unknown' } // PID present but create-time unreadable -> unknown.
      : { status: 'present', startedAt };
  },
};

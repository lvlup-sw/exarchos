/**
 * DR-5 — protected-ancestry, read-only ground-truth process probe for the
 * worktree-lifecycle manager.
 *
 * The reservation bookkeeping (`worktrees@v1`) records WHICH process claimed a
 * worktree, but the only authoritative answer to "is this worktree actually in
 * use right now?" is the live process table: a process whose cwd resolves inside
 * the worktree is using it, regardless of what the ledger says. This module is
 * that ground-truth probe. It is strictly **read-only** — it enumerates, it
 * resolves, it RETURNS findings; it NEVER terminates a process and NEVER mutates
 * state. There is no background loop, interval, or daemon: every function runs
 * only when called (INV-15).
 *
 * Three properties make the probe safe to act on:
 *
 *   1. **Injected enumeration.** The host process table is reached only through
 *      an injected {@link ProcessTableSource}, so the decision logic is fully
 *      unit-testable with a fake table and zero OS calls — and the macOS /
 *      Windows enumeration paths (DR-11, deferred to #1579) stay open behind the
 *      same seam instead of being foreclosed by a hard-coded `ps`/native call.
 *
 *   2. **Symlink-canonicalized containment.** Whether a process cwd lives inside
 *      a worktree is decided by {@link isPathWithin}, which realpath-resolves
 *      BOTH sides — so a cwd reported under `/private/var/...` still matches a
 *      worktree recorded under the `/var/...` symlink (and vice versa), and a
 *      partial-segment sibling like `/a/bc` is never mistaken for inside `/a/b`.
 *
 *   3. **Protected-ancestry subtraction (the load-bearing requirement).** The
 *      orchestrator's own shell can drift its cwd into an agent worktree; if that
 *      self-rooted cwd counted, the orchestrator would forever see its own
 *      worktrees as in-use and never reclaim them. So the current process's FULL
 *      parent-PID chain (`pid -> ppid -> ...`) is computed and excluded from the
 *      occupant set — not just the leaf PID, the entire ancestry.
 *
 * Owner liveness reuses the {@link ownerLiveness} primitive (PID presence paired
 * with a create-time fingerprint, so a recycled PID reads as a *different* — and
 * therefore dead — owner). A worktree is a release / orphan candidate only when
 * its recorded owner is provably gone AND no live, non-ancestry process occupies
 * it: ground-truth occupancy vetoes a stale "owner dead" ledger verdict.
 */

import * as fs from 'node:fs';
import {
  isPathWithin,
  defaultRealpath,
  type RealpathResolver,
} from './path-containment.js';
import {
  ownerLiveness,
  type OwnerLiveness,
  type ProcessSource,
  type StartTimeProbe,
} from './process-identity.js';

// ============================================================
// Types
// ============================================================

/**
 * A single process as seen by the host. `startTime` is an opaque, platform-
 * defined create-time fingerprint (Linux jiffies-since-boot, macOS `lstart`,
 * Windows FILETIME) — compared only for equality, never parsed — so a PID reused
 * by a newer process is distinguishable from the original holder.
 */
export interface ProcessRecord {
  /** The process id. */
  readonly pid: number;
  /** The parent process id (used to walk the protected ancestry chain). */
  readonly ppid: number;
  /** The process's current working directory (resolved against worktree roots). */
  readonly cwd: string;
  /** Opaque create-time fingerprint; equality-compared to defeat PID reuse. */
  readonly startTime: string;
}

/**
 * Abstraction over the host process table. Injected so the probe logic is
 * testable without touching the real OS, and so non-Linux enumeration (DR-11,
 * #1579) can be supplied later without changing the core. The signature is
 * deliberately platform-agnostic — no syscall shape leaks through it.
 */
export interface ProcessTableSource {
  /** Snapshot every visible process. A point-in-time read, never a live stream. */
  list(): readonly ProcessRecord[];
}

/** A worktree path plus the current PID whose entire ancestry is protected. */
export interface WorktreeUsageQuery {
  /** Worktree roots to test for live, non-ancestry occupancy. */
  readonly worktreePaths: readonly string[];
  /**
   * The current ("self") process whose FULL parent-PID chain is excluded from
   * the in-use set, so a self-rooted cwd never marks a worktree in-use.
   */
  readonly selfPid: number;
}

/** Per-worktree occupancy finding from {@link probeWorktreeUsage}. */
export interface WorktreeUsage {
  readonly worktreePath: string;
  /** True iff at least one non-ancestry process has its cwd inside the worktree. */
  readonly inUse: boolean;
  /** The PIDs (excluding the protected ancestry) rooted inside the worktree. */
  readonly occupantPids: readonly number[];
}

/** A recorded reservation owner to probe for liveness against the process table. */
export interface ReservationOwner {
  readonly worktreePath: string;
  /** PID recorded when the worktree was reserved. */
  readonly ownerPid: number;
  /** Create-time fingerprint recorded at reservation time (equality-compared). */
  readonly ownerStartedAt: string;
}

/** Per-reservation liveness finding from {@link probeReservations}. */
export interface ReservationFinding {
  readonly worktreePath: string;
  /** Owner liveness: `'dead'` (gone or PID-reused) is the only releasable state. */
  readonly liveness: OwnerLiveness;
  /** True iff the owner is provably `'dead'`; `'alive'`/`'unknown'` are held. */
  readonly releasable: boolean;
}

/** A worktree plus its recorded reservation owner (null when unreserved). */
export interface WorktreeReservationTarget {
  readonly worktreePath: string;
  readonly owner: { readonly ownerPid: number; readonly ownerStartedAt: string } | null;
}

/** Inputs to the composite {@link probeWorktrees} finding. */
export interface WorktreeProbeQuery {
  readonly targets: readonly WorktreeReservationTarget[];
  readonly selfPid: number;
}

/** Composite per-worktree finding combining occupancy and owner liveness. */
export interface WorktreeProbeFinding {
  readonly worktreePath: string;
  /** A live, non-ancestry process is rooted inside this worktree right now. */
  readonly inUse: boolean;
  readonly occupantPids: readonly number[];
  /** Liveness of the recorded reservation owner; `'none'` when unreserved. */
  readonly ownerLiveness: OwnerLiveness | 'none';
  /**
   * Releasable / orphan-candidate: the recorded owner is provably gone AND no
   * live non-ancestry process occupies the worktree. Ground-truth occupancy
   * VETOES a stale "owner dead" verdict, so a worktree a live process has
   * re-entered is never reclaimed.
   */
  readonly releasable: boolean;
}

// ============================================================
// Pure decisions
// ============================================================

/** Index a process snapshot by PID for O(1) parent/owner lookups. */
function indexByPid(records: readonly ProcessRecord[]): Map<number, ProcessRecord> {
  const byPid = new Map<number, ProcessRecord>();
  for (const record of records) byPid.set(record.pid, record);
  return byPid;
}

/**
 * Compute the protected ancestry: the FULL parent-PID chain of `selfPid`
 * (`selfPid -> ppid -> ppid' -> ...`), which must be excluded from every
 * worktree's occupant set.
 *
 * `selfPid` is always included even when absent from the table (so a self-rooted
 * cwd is protected regardless). The walk then follows each record's `ppid` until
 * it leaves the table, reaches PID 0 (no parent / the kernel), or revisits a PID
 * — the visited-set guard makes a malformed or cyclic `ppid` graph terminate
 * instead of looping forever. Pure over its inputs; performs no OS access.
 */
export function protectedAncestry(
  selfPid: number,
  byPid: ReadonlyMap<number, ProcessRecord>,
): ReadonlySet<number> {
  const chain = new Set<number>();
  let cursor = selfPid;
  while (cursor > 0 && !chain.has(cursor)) {
    chain.add(cursor);
    const record = byPid.get(cursor);
    if (record === undefined) break; // selfPid stays protected even if unlisted.
    cursor = record.ppid;
  }
  return chain;
}

/**
 * The PIDs whose cwd resolves inside `worktreePath`, excluding the protected
 * ancestry. Containment is symlink-canonicalized on both sides via
 * {@link isPathWithin}. Pure over the injected {@link RealpathResolver}.
 */
function occupantsOf(
  worktreePath: string,
  records: readonly ProcessRecord[],
  protectedPids: ReadonlySet<number>,
  realpath: RealpathResolver,
): number[] {
  const occupants: number[] = [];
  for (const record of records) {
    if (protectedPids.has(record.pid)) continue; // self + ancestry never count.
    if (isPathWithin(record.cwd, worktreePath, realpath)) {
      occupants.push(record.pid);
    }
  }
  return occupants;
}

/**
 * Adapt a point-in-time {@link ProcessTableSource} snapshot into the per-PID
 * {@link ProcessSource} that {@link ownerLiveness} consumes.
 *
 * A full ground-truth snapshot resolves to `present` / `absent` only — never the
 * per-PID probe's `unknown`: there is no separate create-time probe that could
 * fail to run, the process is simply in the enumerated table or it is not. So
 * owner liveness over a snapshot is two-valued (`alive` / `dead`); the `unknown`
 * fail-closed branch belongs to the live per-PID `defaultProcessSource`, not here.
 */
function tableAsProcessSource(byPid: ReadonlyMap<number, ProcessRecord>): ProcessSource {
  return {
    getStartTime(pid: number): StartTimeProbe {
      const record = byPid.get(pid);
      return record === undefined
        ? { status: 'absent' }
        : { status: 'present', startedAt: record.startTime };
    },
  };
}

/**
 * Probe which worktrees are in use by a live, non-ancestry process.
 *
 * For each requested worktree, returns the occupant PIDs (cwd resolves inside,
 * after symlink canonicalization on both sides) with the current process's
 * entire ancestry chain subtracted. `inUse` is true iff that occupant set is
 * non-empty. Pure over the injected {@link ProcessTableSource} and
 * {@link RealpathResolver}; performs no OS access of its own.
 */
export function probeWorktreeUsage(
  query: WorktreeUsageQuery,
  source: ProcessTableSource,
  realpath: RealpathResolver = defaultRealpath,
): WorktreeUsage[] {
  const records = source.list();
  const protectedPids = protectedAncestry(query.selfPid, indexByPid(records));

  return query.worktreePaths.map((worktreePath) => {
    const occupantPids = occupantsOf(worktreePath, records, protectedPids, realpath);
    return { worktreePath, inUse: occupantPids.length > 0, occupantPids };
  });
}

/**
 * Probe each recorded reservation owner's liveness against the process table.
 *
 * An owner is `releasable` only when {@link ownerLiveness} reports `'dead'` — the
 * PID is absent, or present but with a mismatched create-time (PID reuse). A live
 * owner (PID present AND create-time matches) is never releasable. Pure over the
 * injected {@link ProcessTableSource}.
 */
export function probeReservations(
  reservations: readonly ReservationOwner[],
  source: ProcessTableSource,
): ReservationFinding[] {
  const processSource = tableAsProcessSource(indexByPid(source.list()));
  return reservations.map((reservation) => {
    const liveness = ownerLiveness(
      { ownerPid: reservation.ownerPid, ownerStartedAt: reservation.ownerStartedAt },
      processSource,
    );
    return {
      worktreePath: reservation.worktreePath,
      liveness,
      releasable: liveness === 'dead',
    };
  });
}

/**
 * Composite probe: classify each worktree as in-use, owner-live, or
 * releasable / orphan-candidate.
 *
 * Combines the occupancy lens ({@link probeWorktreeUsage}) with the owner-
 * liveness lens ({@link probeReservations}) over a single process snapshot. A
 * worktree is releasable only when its recorded owner is provably `'dead'` AND it
 * is NOT in use by any live non-ancestry process — live occupancy is the ground
 * truth that vetoes a stale "owner dead" ledger verdict. Pure over the injected
 * {@link ProcessTableSource} and {@link RealpathResolver}.
 */
export function probeWorktrees(
  query: WorktreeProbeQuery,
  source: ProcessTableSource,
  realpath: RealpathResolver = defaultRealpath,
): WorktreeProbeFinding[] {
  const records = source.list();
  const byPid = indexByPid(records);
  const protectedPids = protectedAncestry(query.selfPid, byPid);
  const processSource = tableAsProcessSource(byPid);

  return query.targets.map((target) => {
    const occupantPids = occupantsOf(target.worktreePath, records, protectedPids, realpath);
    const inUse = occupantPids.length > 0;
    const ownerVerdict: OwnerLiveness | 'none' =
      target.owner === null
        ? 'none'
        : ownerLiveness(
            { ownerPid: target.owner.ownerPid, ownerStartedAt: target.owner.ownerStartedAt },
            processSource,
          );
    return {
      worktreePath: target.worktreePath,
      inUse,
      occupantPids,
      ownerLiveness: ownerVerdict,
      releasable: !inUse && ownerVerdict === 'dead',
    };
  });
}

// ============================================================
// Default real source (thin; unix)
// ============================================================

/** A `/proc` entry that is a numeric PID directory. */
const PID_DIR = /^\d+$/;

/**
 * Read one Linux process from `/proc/<pid>`: `ppid` and `starttime` from the
 * `stat` line, `cwd` from the `cwd` symlink. Field parsing matches
 * `process-identity.ts` — the `comm` field (2) is parenthesized and may itself
 * contain spaces/parens, so the tail is split AFTER the final `')'`; in that tail
 * index 0 is `state` (field 3), index 1 is `ppid` (field 4), index 19 is
 * `starttime` (field 22). Returns `null` when the process vanished mid-scan or is
 * unreadable (EACCES) so the enumerator simply skips it.
 */
function readProcRecord(pid: number): ProcessRecord | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const tail = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppidRaw = tail[1];
    const startRaw = tail[19];
    if (ppidRaw === undefined || startRaw === undefined) return null;
    if (!/^\d+$/.test(ppidRaw) || !/^\d+$/.test(startRaw)) return null;
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    return { pid, ppid: Number(ppidRaw), cwd, startTime: startRaw };
  } catch {
    return null;
  }
}

/** Enumerate every readable process via `/proc` (Linux ground truth). */
function enumerateProcLinux(): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return records;
  }
  for (const entry of entries) {
    if (!PID_DIR.test(entry)) continue;
    const record = readProcRecord(Number(entry));
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * Default {@link ProcessTableSource} backed by the real OS.
 *
 * Linux ground truth is read from `/proc`. macOS / Windows enumeration is
 * deferred to DR-11 (#1579); the injected-source seam keeps those platforms open
 * without foreclosing here. A consumer that receives an empty table on an
 * unsupported platform MUST fail closed — treat "cannot enumerate" as "cannot
 * prove free" and never release — mirroring the `unknown` fail-closed contract of
 * the per-PID `defaultProcessSource`. Never exercised by the unit tests (those
 * inject a fake table), so the probe core stays free of real OS calls.
 */
export const defaultProcessTableSource: ProcessTableSource = {
  list(): readonly ProcessRecord[] {
    return process.platform === 'linux' ? enumerateProcLinux() : [];
  },
};

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
 *      unit-testable with a fake table and zero OS calls. Linux (`/proc`) and
 *      win32 (`Get-CimInstance Win32_Process` + best-effort PEB cwd, DR-5) are
 *      the real enumerators; the macOS path (DR-11, #1579) stays open behind the
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
import { runCommandSync } from '../../../utils/process.js';
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
  /**
   * Whether this platform's process enumeration is actually SUPPORTED — i.e.
   * whether an empty `list()` means "no processes" (provably) or "could not
   * enumerate" (unknown). This is the load-bearing distinction the fail-closed
   * contract rests on: on a platform without a real enumerator (macOS before
   * DR-11, #1579) `list()` returns `[]`, and treating that `[]` as "every PID is
   * absent → every owner is provably dead" would reclaim LIVE holders (DR-7
   * corruption). When `isSupported()` is `false`, a PID lookup is `'unknown'`
   * (NOT `'dead'`), so every reclaim consumer fails closed — mirroring the
   * `unknown` three-state contract of {@link ProcessSource} in
   * `process-identity.ts`.
   *
   * OPTIONAL purely for backward-compatibility with in-memory test doubles that
   * supply a concrete records list: an absent predicate is read as `true`
   * (supported) by {@link isTableSupported}, because such a double IS asserting
   * a real enumerated table. The real {@link defaultProcessTableSource} declares
   * it explicitly: `false` on every platform without an enumerator, and on
   * Linux / win32 (both COMPLETE enumerations, DR-5) it reflects whether the
   * most recent `list()` snapshot actually ENUMERATED — a transiently failed
   * enumeration (e.g. a `Get-CimInstance` spawn error yielding `[]`) reads as
   * unsupported/indeterminate rather than "every owner provably dead"
   * (fail-open→fail-closed, DR-17 / #1641).
   */
  isSupported?(): boolean;
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

/**
 * A recorded in-flight launcher launch to probe for holder liveness (DR-6).
 *
 * The `holderPid` is the launcher/**supervisor** PID — the long-lived process
 * responsible for writing the `launch.executed` terminal — NOT the spawned child
 * PID. That distinction is load-bearing: on an uncatchable death (`SIGKILL` /
 * host loss) the supervisor never runs its teardown, so no terminal is ever
 * written and the launch would fold as a PERMANENT in-flight phantom. A provably
 * dead holder is therefore the signal that the terminal will never arrive on its
 * own and must be reconciled. `holderStartedAt` is the create-time fingerprint,
 * equality-compared to defeat PID reuse.
 */
export interface LaunchHolder {
  /** Canonical `worktrees@v1` key of the launch top-level worktree. */
  readonly worktreeId: string;
  /** Supervisor PID recorded at launch, or `null` when the emitter did not capture it. */
  readonly holderPid: number | null;
  /** Supervisor create-time fingerprint (equality-compared), or `null` when uncaptured. */
  readonly holderStartedAt: string | null;
}

/** Per-launch liveness finding from {@link probeLaunchHolders}. */
export interface LaunchFinding {
  readonly worktreeId: string;
  /** Holder liveness: `'dead'` (gone or PID-reused) is the only reconcilable state. */
  readonly liveness: OwnerLiveness;
  /**
   * True iff the holder is provably `'dead'` — the terminal will never be
   * written, so the launch is reconcilable to a `launch.executed`. `'alive'` and
   * `'unknown'` (incl. an uncaptured `null` holder identity) are held in-flight,
   * failing closed so a live supervisor's launch is never reconciled away.
   */
  readonly reconcilable: boolean;
}

/**
 * Probe each in-flight launch's SUPERVISOR-holder liveness against the process
 * table (DR-6). The dead-holder analog of {@link probeReservations}, keyed to the
 * launcher liveness pair (`holderPid` / `holderStartedAt`) rather than a
 * reservation owner.
 *
 * A launch is `reconcilable` only when {@link ownerLiveness} reports `'dead'` —
 * the supervisor PID is absent from a SUPPORTED table, or present with a
 * mismatched create-time (PID reuse). A live holder (PID present AND create-time
 * matches) is never reconcilable. A holder with an uncaptured (`null`) PID or
 * create-time cannot be proven dead, so it is `'unknown'` and held; and on an
 * UNSUPPORTED table every holder is `'unknown'` (NOT `'dead'`) so nothing is
 * reconciled — fail closed, exactly mirroring the reservation probe. Pure over
 * the injected {@link ProcessTableSource}; performs no OS access of its own and
 * registers NO timer/interval — it runs only when called (INV-10/15).
 */
export function probeLaunchHolders(
  holders: readonly LaunchHolder[],
  source: ProcessTableSource,
): LaunchFinding[] {
  const processSource = tableAsProcessSource(
    indexByPid(source.list()),
    isTableSupported(source),
  );
  return holders.map((holder) => {
    if (holder.holderPid === null || holder.holderStartedAt === null) {
      // Holder identity was never captured — cannot prove death → fail closed.
      return { worktreeId: holder.worktreeId, liveness: 'unknown', reconcilable: false };
    }
    const liveness = ownerLiveness(
      { ownerPid: holder.holderPid, ownerStartedAt: holder.holderStartedAt },
      processSource,
    );
    return {
      worktreeId: holder.worktreeId,
      liveness,
      reconcilable: liveness === 'dead',
    };
  });
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
 * Whether a {@link ProcessTableSource}'s enumeration is supported. An absent
 * `isSupported` predicate is read as supported (`true`) — see the field doc:
 * an in-memory double that supplies a concrete records list IS a real table, so
 * "PID absent → provably dead" still holds for it. Only a source that explicitly
 * reports `false` (the real off-Linux {@link defaultProcessTableSource}) flips
 * lookups to `'unknown'`.
 */
function isTableSupported(source: ProcessTableSource): boolean {
  return source.isSupported?.() ?? true;
}

/**
 * Adapt a point-in-time {@link ProcessTableSource} snapshot into the per-PID
 * {@link ProcessSource} that {@link ownerLiveness} consumes — THREE-valued.
 *
 * When the table is SUPPORTED (`supported === true`), a PID present in the
 * enumerated snapshot resolves to `present` and an absent one to `absent`: the
 * absence is authoritative (the process is provably gone), so owner liveness is
 * two-valued (`alive` / `dead`) over a real enumeration.
 *
 * When the table is UNSUPPORTED (`supported === false` — e.g. macOS before
 * DR-11, where `list()` returns `[]` because there is no enumerator), a PID
 * lookup CANNOT distinguish "absent" from "unenumerated", so it resolves to
 * `'unknown'` for EVERY pid. That propagates through {@link ownerLiveness} to
 * an `'unknown'` verdict, and every reclaim consumer fails closed (never treats
 * the holder as provably dead) — mirroring the `unknown` fail-closed branch of
 * the live per-PID `defaultProcessSource`. This is the fix for the
 * off-supported-platform dead-holder-reclaim hole that would otherwise free a
 * LIVE merge holder.
 */
function tableAsProcessSource(
  byPid: ReadonlyMap<number, ProcessRecord>,
  supported: boolean,
): ProcessSource {
  return {
    getStartTime(pid: number): StartTimeProbe {
      if (!supported) {
        // Unsupported enumeration: an empty/partial table cannot prove a PID
        // absent, so every lookup is `unknown` → callers fail closed.
        return { status: 'unknown' };
      }
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
 * PID is absent from a SUPPORTED table, or present but with a mismatched
 * create-time (PID reuse). A live owner (PID present AND create-time matches) is
 * never releasable, and on an UNSUPPORTED table every owner is `'unknown'` (NOT
 * `'dead'`) so nothing is releasable — fail closed. Pure over the injected
 * {@link ProcessTableSource}.
 */
export function probeReservations(
  reservations: readonly ReservationOwner[],
  source: ProcessTableSource,
): ReservationFinding[] {
  const processSource = tableAsProcessSource(
    indexByPid(source.list()),
    isTableSupported(source),
  );
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
 * truth that vetoes a stale "owner dead" ledger verdict. On an UNSUPPORTED
 * process table the owner verdict is `'unknown'` (never `'dead'`), so nothing is
 * releasable and nothing is an orphan candidate — fail closed. Pure over the
 * injected {@link ProcessTableSource} and {@link RealpathResolver}.
 */
export function probeWorktrees(
  query: WorktreeProbeQuery,
  source: ProcessTableSource,
  realpath: RealpathResolver = defaultRealpath,
): WorktreeProbeFinding[] {
  const records = source.list();
  const byPid = indexByPid(records);
  const protectedPids = protectedAncestry(query.selfPid, byPid);
  const processSource = tableAsProcessSource(byPid, isTableSupported(source));

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

// ============================================================
// Default real source (thin; win32 — DR-5)
// ============================================================

/**
 * Reads the raw win32 process-table enumeration (the stdout of
 * {@link WIN32_PROCESS_TABLE_COMMAND}). Injected so the win32 enumeration branch
 * is unit-testable on the POSIX CI host — there is no Windows runner in this
 * repo's default CI, so the win32 tests are shape-based against this seam and the
 * pure {@link parseWin32ProcessTable}, never the real PowerShell.
 */
export type Win32ProcessTableReader = () => string;

/** Tab separator between the four emitted fields (`\t` can never appear in a Windows path). */
const WIN32_FIELD_SEP = '\t';

/**
 * One-shot PowerShell that enumerates the win32 process table as TAB-separated
 * `pid<TAB>ppid<TAB>createTime<TAB>cwd` lines — one process per line, `cwd` LAST
 * because it is the only field that can be empty or contain spaces (a Windows
 * path never contains a TAB or a newline). `createTime` is the process FILETIME
 * (`CreationDate.ToFileTimeUtc()`): an opaque, monotonically-increasing 64-bit
 * integer compared only for equality, so a reused PID yields a strictly larger
 * value — exactly the create-time fingerprint the per-PID source in
 * `process-identity.ts` uses.
 *
 * pid / ppid / createTime come from `Get-CimInstance Win32_Process`, a COMPLETE
 * and authoritative enumeration, so a PID absent from the parsed table is
 * provably gone — the soundness `isSupported() === true` on win32 rests on. `cwd`
 * is resolved BEST-EFFORT by reading the process PEB
 * (`ProcessParameters->CurrentDirectory`); a process whose PEB is not readable
 * (a different user's process, a denied handle) emits an EMPTY cwd rather than
 * dropping the record — so the enumeration stays complete for owner-liveness
 * while occupancy containment degrades to best-effort for those processes
 * (mirroring the `/proc/<pid>/cwd` EACCES skip on Linux). The inline PEB read is
 * the real, CI-UNVERIFIED win32 edge (no Windows host in default CI); it FAILS
 * SOFT to an empty cwd on any error (denied handle, unexpected offset), so it can
 * never crash the probe or corrupt the pid/create-time fields. Uses `[char]`
 * codes for TAB (9), NUL (0) and backslash (92) so the script embeds cleanly with
 * no shell/JS escaping.
 */
const WIN32_PROCESS_TABLE_COMMAND = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$sep = [string][char]9',
  "$src = @'",
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class WlmCwd {',
  '  [StructLayout(LayoutKind.Sequential)] struct PBI {',
  '    public IntPtr ExitStatus; public IntPtr PebBaseAddress; public IntPtr AffinityMask;',
  '    public IntPtr BasePriority; public IntPtr UniqueProcessId; public IntPtr InheritedFromUniqueProcessId; }',
  '  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int l, ref int r);',
  '  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int pid);',
  '  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);',
  '  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int s, out int read);',
  '  static long ReadPtr(IntPtr h, long addr) {',
  '    byte[] b = new byte[IntPtr.Size]; int r;',
  '    if (!ReadProcessMemory(h, (IntPtr)addr, b, b.Length, out r) || r != b.Length) return 0;',
  '    return IntPtr.Size == 8 ? BitConverter.ToInt64(b, 0) : (long)BitConverter.ToInt32(b, 0); }',
  '  public static string Get(int pid) {',
  '    IntPtr h = OpenProcess(0x0410, false, pid); if (h == IntPtr.Zero) return "";',
  '    try {',
  '      PBI pbi = new PBI(); int ret = 0;',
  '      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), ref ret) != 0) return "";',
  '      long peb = (long)pbi.PebBaseAddress; if (peb == 0) return "";',
  '      long pp = ReadPtr(h, peb + (IntPtr.Size == 8 ? 0x20 : 0x10)); if (pp == 0) return "";',
  '      int cdOff = IntPtr.Size == 8 ? 0x38 : 0x24;',
  '      byte[] us = new byte[IntPtr.Size == 8 ? 16 : 8]; int r;',
  '      if (!ReadProcessMemory(h, (IntPtr)(pp + cdOff), us, us.Length, out r) || r != us.Length) return "";',
  '      ushort len = BitConverter.ToUInt16(us, 0);',
  '      long buf = IntPtr.Size == 8 ? BitConverter.ToInt64(us, 8) : (long)BitConverter.ToInt32(us, 4);',
  '      if (len == 0 || buf == 0 || len > 0x7FFF) return "";',
  '      byte[] s = new byte[len];',
  '      if (!ReadProcessMemory(h, (IntPtr)buf, s, len, out r) || r == 0) return "";',
  '      return Encoding.Unicode.GetString(s, 0, r);',
  '    } catch { return ""; } finally { CloseHandle(h); } } }',
  "'@",
  'Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue | Out-Null',
  'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {',
  '  $ft = 0; try { if ($_.CreationDate) { $ft = $_.CreationDate.ToFileTimeUtc() } } catch { $ft = 0 }',
  '  if ($ft -le 0) { return }',
  "  $cwd = ''; try { $cwd = [WlmCwd]::Get([int]$_.ProcessId) } catch { $cwd = '' }",
  '  if ($cwd) { $cwd = $cwd.TrimEnd([char]0).TrimEnd([char]92) }',
  '  @([int]$_.ProcessId, [int]$_.ParentProcessId, $ft, $cwd) -join $sep',
  '}',
].join('\n');

/**
 * Parse the win32 process-table enumeration ({@link WIN32_PROCESS_TABLE_COMMAND}
 * output) into {@link ProcessRecord}s. Pure: no OS access, so the win32 shape is
 * unit-testable on the POSIX CI host.
 *
 * Each non-blank line is TAB-separated `pid<TAB>ppid<TAB>createTime<TAB>cwd`.
 * pid / ppid / createTime must each be a run of digits (createTime is a FILETIME
 * integer, opaque and equality-compared); a line missing any of them — a process
 * that vanished mid-enumeration, or a malformed row — is skipped, mirroring the
 * `/proc` reader's null-skip. `cwd` is field 4 onward (rejoined defensively
 * though a path never contains a TAB) and preserved VERBATIM; containment
 * canonicalization (the launcher's realpath / 8.3 handling) happens later, in
 * `path-containment` (DR-5). A record with an empty cwd is kept — its PID/
 * create-time still anchor owner-liveness — it simply never matches a worktree
 * root, so occupancy stays best-effort for PEB-unreadable processes.
 */
export function parseWin32ProcessTable(raw: string): ProcessRecord[] {
  const records: ProcessRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const fields = line.split(WIN32_FIELD_SEP);
    if (fields.length < 3) continue;
    const pidRaw = fields[0]?.trim() ?? '';
    const ppidRaw = fields[1]?.trim() ?? '';
    const startRaw = fields[2]?.trim() ?? '';
    if (!/^\d+$/.test(pidRaw) || !/^\d+$/.test(ppidRaw) || !/^\d+$/.test(startRaw)) continue;
    const cwd = fields.length >= 4 ? fields.slice(3).join(WIN32_FIELD_SEP).trim() : '';
    records.push({ pid: Number(pidRaw), ppid: Number(ppidRaw), cwd, startTime: startRaw });
  }
  return records;
}

/** The real win32 reader: run the enumeration PowerShell through the #1623-safe shim. */
function defaultWin32ProcessTableReader(): string {
  // `powershell` is a real binary (not a `.cmd` shim), so `runCommandSync` is a
  // thin pass-through here — but going through it keeps the INV-16 idiom uniform
  // (never a direct shim spawn, #1623). A busy host's full table can exceed the
  // default 1 MiB buffer, so widen it.
  const out = runCommandSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', WIN32_PROCESS_TABLE_COMMAND],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
  );
  return typeof out === 'string' ? out : out.toString('utf8');
}

/**
 * Enumerate the win32 process table; a failed spawn/parse yields an empty
 * table, which {@link makeDefaultProcessTableSource} reads as an INDETERMINATE
 * snapshot (`isSupported() === false`) — never as "no processes" (DR-17/#1641).
 */
function enumerateWin32(read: Win32ProcessTableReader): ProcessRecord[] {
  try {
    return parseWin32ProcessTable(read());
  } catch {
    return [];
  }
}

// ============================================================
// Default real source (linux + win32; injectable platform seam)
// ============================================================

/** Injectable seams for {@link makeDefaultProcessTableSource} (default → host platform / real PowerShell). */
export interface ProcessTableSourceDeps {
  /** Host platform to resolve the enumerator for; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Win32 raw-table reader; defaults to the real PowerShell enumeration. Injected in tests. */
  readonly readWin32ProcessTable?: Win32ProcessTableReader;
}

/**
 * Build the real-OS {@link ProcessTableSource} for a platform (DR-5).
 *
 * Enumeration ground truth per platform:
 *   - **linux** — `/proc` (`enumerateProcLinux`).
 *   - **win32** — `Get-CimInstance Win32_Process` + best-effort PEB cwd
 *     ({@link enumerateWin32}), behind the injectable {@link Win32ProcessTableReader}.
 *   - **every other platform** — no enumerator yet (DR-11 / #1579): `list()`
 *     returns `[]` AND `isSupported()` returns `false`, so the empty table reads
 *     as "cannot enumerate" (every PID `'unknown'`) — NOT "every owner provably
 *     dead". That is the fail-closed contract preventing a LIVE-merge-holder
 *     reclaim off the supported platforms (DR-7), mirroring the `unknown` branch
 *     of the per-PID `defaultProcessSource`.
 *
 * `isSupported()` is `true` on linux AND win32 because BOTH enumerations are
 * complete: a PID absent from the parsed table is provably gone, so owner
 * liveness is authoritative (`alive`/`dead`) there — **but only when the
 * enumeration actually ran** (DR-17 / #1641). A supported platform's enumerator
 * can transiently FAIL (a `Get-CimInstance` spawn error, an unreadable `/proc`)
 * and yield `[]`; a static `isSupported() === true` would then read that empty
 * snapshot as "every PID provably absent → every owner dead" and reclaim LIVE
 * holders — a silent fail-open in the single-writer-lease liveness path. So
 * `isSupported()` reflects the outcome of the MOST RECENT `list()` snapshot:
 * an INDETERMINATE enumeration (zero records) flips it to `false`, every PID
 * lookup resolves `'unknown'`, and every reclaim consumer fails closed. The
 * zero-records predicate is sound because a REAL enumeration can never be
 * empty — the enumerating process itself is always visible (its own `/proc`
 * entry on Linux; the PowerShell child plus System processes in
 * `Win32_Process` on win32) — so `[]` always means "could not enumerate",
 * never "no processes". A later successful `list()` restores the supported /
 * authoritative verdict. Every probe consumer snapshots `list()` and THEN
 * reads `isSupported()` within one synchronous pass, so the verdict is always
 * coupled to the snapshot it describes.
 *
 * The platform/reader seams keep the real OS calls out of the unit tests — the
 * pure probe core is never exercised against a real table.
 */
export function makeDefaultProcessTableSource(deps: ProcessTableSourceDeps = {}): ProcessTableSource {
  const platform = deps.platform ?? process.platform;
  const readWin32 = deps.readWin32ProcessTable ?? defaultWin32ProcessTableReader;
  // DR-17 / #1641 fail-closed conversion: `true` after a snapshot that
  // provably enumerated; `true` initially (no snapshot yet — consumers always
  // list() before reading the verdict); flipped `false` by an indeterminate
  // (empty) snapshot so its absences are never read as authoritative deaths.
  let lastSnapshotIndeterminate = false;
  return {
    list(): readonly ProcessRecord[] {
      if (platform === 'linux' || platform === 'win32') {
        const records =
          platform === 'linux' ? enumerateProcLinux() : enumerateWin32(readWin32);
        // Zero records from a supported platform ⇒ the enumeration FAILED
        // (the enumerating process itself is always visible in a real table).
        lastSnapshotIndeterminate = records.length === 0;
        return records;
      }
      return [];
    },
    isSupported(): boolean {
      return (platform === 'linux' || platform === 'win32') && !lastSnapshotIndeterminate;
    },
  };
}

/** Default {@link ProcessTableSource} backed by the real OS (linux `/proc` + win32 CIM/PEB). */
export const defaultProcessTableSource: ProcessTableSource = makeDefaultProcessTableSource();

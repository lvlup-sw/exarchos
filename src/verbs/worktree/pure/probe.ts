/**
 * A read-only probe of the live process table for the worktree-lifecycle manager.
 * The `worktrees@v1` ledger records which process claimed a worktree. The process table tells whether a process uses the worktree now.
 * The probe never terminates a process and never changes state. It has no background loop, so each function runs only when called.
 *
 * Three properties make the probe safe to act on:
 * - The process table comes only through an injected {@link ProcessTableSource}. Linux and win32 have real enumerators.
 * - {@link isPathWithin} decides containment with symlinks resolved on both sides.
 * - Each occupant set excludes the full parent-PID chain of the current process. Otherwise an orchestrator shell with its cwd in an agent worktree marks that worktree in use forever.
 *
 * A worktree is a release candidate only when its owner is provably dead and no live process outside the ancestry occupies it.
 * {@link ownerLiveness} pairs PID presence with a create-time fingerprint, so a reused PID reads as a dead owner.
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

/**
 * One process as the host sees it.
 * `startTime` is an opaque create-time fingerprint, compared only for equality, so a reused PID differs from the original holder.
 */
export interface ProcessRecord {
  /** The process id. */
  readonly pid: number;
  /** The parent process id (used to walk the protected ancestry chain). */
  readonly ppid: number;
  /** The process's current working directory (resolved against worktree roots). */
  readonly cwd: string;
  /** The opaque create-time fingerprint, compared for equality to detect PID reuse. */
  readonly startTime: string;
}

/**
 * The host process table. It is injected, so tests of the probe need no OS access.
 * The signature carries no platform syscall shape.
 */
export interface ProcessTableSource {
  /** Snapshot every visible process. A point-in-time read, never a live stream. */
  list(): readonly ProcessRecord[];
  /**
   * Whether the last `list()` snapshot is a complete enumeration, so a PID absent from it is provably gone.
   * When it is `false`, each PID lookup is `'unknown'` and each reclaim consumer fails closed. Read it after `list()`.
   * An absent predicate reads as `true`, because an in-memory double with a concrete records list asserts a real table.
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
  /** True when the owner is provably `'dead'`. An `'alive'` or `'unknown'` owner is held. */
  readonly releasable: boolean;
}

/**
 * A recorded in-flight launch to probe for holder liveness.
 * `holderPid` is the supervisor PID that writes the `launch.executed` terminal, not the PID of the spawned child.
 * After a `SIGKILL` or a host loss, the supervisor writes no terminal, so the launch stays in flight forever.
 * A provably dead holder shows that the launch needs reconciliation.
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
   * True when the holder is provably `'dead'`, so the launch can reconcile to a `launch.executed`.
   * An `'alive'` or `'unknown'` holder, which includes a `null` holder identity, stays in flight.
   */
  readonly reconcilable: boolean;
}

/**
 * Probes the liveness of the supervisor of each in-flight launch, as {@link probeReservations} does for reservation owners.
 * A launch is `reconcilable` only when {@link ownerLiveness} reports `'dead'`.
 * A holder with a `null` PID or create-time cannot be proven dead, so it is `'unknown'`.
 * On an unsupported table, each holder is `'unknown'`.
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
  /** The liveness of the recorded reservation owner, or `'none'` when the worktree has no reservation. */
  readonly ownerLiveness: OwnerLiveness | 'none';
  /**
   * True when the recorded owner is provably dead and no live process outside the ancestry occupies the worktree.
   * Live occupancy vetoes a stale owner-dead verdict.
   */
  readonly releasable: boolean;
}

/** Index a process snapshot by PID for O(1) parent/owner lookups. */
function indexByPid(records: readonly ProcessRecord[]): Map<number, ProcessRecord> {
  const byPid = new Map<number, ProcessRecord>();
  for (const record of records) byPid.set(record.pid, record);
  return byPid;
}

/**
 * The protected ancestry: the full parent-PID chain of `selfPid`, which each occupant set excludes.
 * A positive `selfPid` is always in the set, even when the table does not list it.
 * The walk stops when it leaves the table, reaches PID 0, or revisits a PID, so a cyclic `ppid` graph terminates.
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
    if (record === undefined) break;
    cursor = record.ppid;
  }
  return chain;
}

/**
 * The PIDs whose cwd resolves inside `worktreePath`, without the protected ancestry.
 */
function occupantsOf(
  worktreePath: string,
  records: readonly ProcessRecord[],
  protectedPids: ReadonlySet<number>,
  realpath: RealpathResolver,
): number[] {
  const occupants: number[] = [];
  for (const record of records) {
    if (protectedPids.has(record.pid)) continue;
    if (isPathWithin(record.cwd, worktreePath, realpath)) {
      occupants.push(record.pid);
    }
  }
  return occupants;
}

/**
 * Whether the enumeration of a source is supported. An absent `isSupported` predicate reads as `true`.
 * Only a source that reports `false` turns lookups into `'unknown'`.
 */
function isTableSupported(source: ProcessTableSource): boolean {
  return source.isSupported?.() ?? true;
}

/**
 * Adapts a table snapshot into the per-PID {@link ProcessSource} that {@link ownerLiveness} reads.
 * On a supported table, a listed PID is `present` and an unlisted PID is `absent`, because the absence is authoritative.
 * On an unsupported table, each lookup is `'unknown'`, because an empty or partial table cannot prove a PID absent.
 * Then each reclaim consumer fails closed and cannot free a live merge holder.
 */
function tableAsProcessSource(
  byPid: ReadonlyMap<number, ProcessRecord>,
  supported: boolean,
): ProcessSource {
  return {
    getStartTime(pid: number): StartTimeProbe {
      if (!supported) {
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
 * Probes which worktrees a live process outside the protected ancestry uses.
 * For each worktree it returns the PIDs whose cwd is inside it. `inUse` is true when that set is not empty.
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
 * Probes the liveness of each recorded reservation owner.
 * An owner is `releasable` only when {@link ownerLiveness} reports `'dead'`: the PID is absent from a supported table, or its create-time differs.
 * On an unsupported table, each owner is `'unknown'`, so nothing is releasable.
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
 * Classifies each worktree by occupancy and owner liveness, over one process snapshot.
 * A worktree is releasable only when its owner is provably `'dead'` and no live process outside the ancestry uses it.
 * On an unsupported table, the owner verdict is `'unknown'`, so nothing is releasable.
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

/** A `/proc` entry that is a numeric PID directory. */
const PID_DIR = /^\d+$/;

/**
 * Reads one Linux process from `/proc/<pid>`: `ppid` and `starttime` from `stat`, and `cwd` from the `cwd` symlink.
 * The `comm` field can hold spaces and parentheses, so the parser splits the text after the last `)`.
 * In that tail, index 1 is `ppid` and index 19 is `starttime`. The function returns `null` for a process that is gone or unreadable.
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
 * Reads the raw output of {@link WIN32_PROCESS_TABLE_COMMAND}.
 * It is injected, so tests of the win32 branch run on a POSIX host without the real PowerShell.
 */
export type Win32ProcessTableReader = () => string;

/** Tab separator between the four emitted fields (`\t` can never appear in a Windows path). */
const WIN32_FIELD_SEP = '\t';

/**
 * A PowerShell script that prints the win32 process table as `pid<TAB>ppid<TAB>createTime<TAB>cwd` lines, one process on each line.
 * `cwd` is last, because only it can be empty or hold spaces. `createTime` is the FILETIME of the process, compared only for equality.
 * `Get-CimInstance Win32_Process` gives a complete enumeration, so a PID absent from a non-empty table is provably gone.
 *
 * The script reads `cwd` from the process PEB. When it cannot read the PEB, it prints an empty `cwd` and keeps the record.
 * No Windows host tests the PEB read. Each error gives an empty `cwd`, so the read cannot corrupt the other fields.
 * `[char]` codes for TAB, NUL, and backslash keep the script free of shell and JS escapes.
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
 * Parses the output of {@link WIN32_PROCESS_TABLE_COMMAND} into {@link ProcessRecord}s, with no OS access.
 * The parser skips a line whose pid, ppid, or createTime is not a run of digits.
 * It keeps `cwd` as it is, and `path-containment` canonicalizes it later.
 * It keeps a record with an empty `cwd`, because its PID and create-time still serve owner liveness.
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

/**
 * The real win32 reader. It runs the PowerShell enumeration through `runCommandSync`.
 * The buffer is 64 MiB, because the full table of a busy host can exceed the 1 MiB default.
 */
function defaultWin32ProcessTableReader(): string {
  const out = runCommandSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', WIN32_PROCESS_TABLE_COMMAND],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
  );
  return typeof out === 'string' ? out : out.toString('utf8');
}

/**
 * Enumerate the win32 process table. A failed spawn or parse yields an empty
 * table, which the source reads as unsupported.
 */
function enumerateWin32(read: Win32ProcessTableReader): ProcessRecord[] {
  try {
    return parseWin32ProcessTable(read());
  } catch {
    return [];
  }
}

/** Injectable seams for {@link makeDefaultProcessTableSource} (default → host platform / real PowerShell). */
export interface ProcessTableSourceDeps {
  /** The host platform that selects the enumerator. The default is `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** The win32 raw-table reader. The default is the real PowerShell enumeration. */
  readonly readWin32ProcessTable?: Win32ProcessTableReader;
}

/**
 * Builds the real {@link ProcessTableSource}. Linux reads `/proc`, win32 uses {@link Win32ProcessTableReader}, and each other platform lists `[]`.
 * `isSupported()` is `true` only on Linux or win32, and only when the last `list()` returned a record.
 * A real enumeration always sees its own process, so an empty snapshot means that the enumeration failed.
 */
export function makeDefaultProcessTableSource(deps: ProcessTableSourceDeps = {}): ProcessTableSource {
  const platform = deps.platform ?? process.platform;
  const readWin32 = deps.readWin32ProcessTable ?? defaultWin32ProcessTableReader;
  const hasEnumerator = platform === 'linux' || platform === 'win32';
  let lastSnapshotEnumerated = false;
  return {
    list(): readonly ProcessRecord[] {
      const records =
        platform === 'linux'
          ? enumerateProcLinux()
          : platform === 'win32'
            ? enumerateWin32(readWin32)
            : [];
      lastSnapshotEnumerated = records.length > 0;
      return records;
    },
    isSupported(): boolean {
      return hasEnumerator && lastSnapshotEnumerated;
    },
  };
}

/** Default {@link ProcessTableSource} backed by the real OS (linux `/proc` + win32 CIM/PEB). */
export const defaultProcessTableSource: ProcessTableSource = makeDefaultProcessTableSource();

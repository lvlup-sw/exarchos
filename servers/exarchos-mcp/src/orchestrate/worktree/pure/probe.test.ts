import { describe, it, expect } from 'vitest';
import {
  protectedAncestry,
  probeWorktreeUsage,
  probeReservations,
  probeWorktrees,
  probeLaunchHolders,
  makeDefaultProcessTableSource,
  parseWin32ProcessTable,
  type ProcessRecord,
  type ProcessTableSource,
} from './probe.js';
import type { RealpathResolver } from './path-containment.js';

/**
 * A fixed-snapshot, SUPPORTED ProcessTableSource over an in-memory process
 * table — `list()` is authoritative, so a PID absent from it is provably gone.
 * (No `isSupported`; the probe reads an absent predicate as supported.)
 */
function tableSource(records: readonly ProcessRecord[]): ProcessTableSource {
  return { list: () => records };
}

/**
 * An UNSUPPORTED ProcessTableSource — the off-Linux shape where enumeration is
 * not implemented (DR-11/#1579). `list()` returns `[]` but `isSupported()` is
 * `false`, so an absent PID is `'unknown'`, NEVER provably dead. Mirrors the
 * real `defaultProcessTableSource` off-Linux.
 */
const UNSUPPORTED_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => false,
};

/** Identity resolver: no symlinks, paths pass through unchanged. */
const identity: RealpathResolver = (p) => p;

describe('protectedAncestry', () => {
  it('walks the full pid -> ppid chain and terminates at a cycle', () => {
    // 100 -> 90 -> 80 -> (ppid 0). A self-referential ppid (200 -> 200) must not
    // loop forever — the visited-set guard makes the walk total.
    const records: ProcessRecord[] = [
      { pid: 100, ppid: 90, cwd: '/x', startTime: 'a' },
      { pid: 90, ppid: 80, cwd: '/x', startTime: 'b' },
      { pid: 80, ppid: 0, cwd: '/x', startTime: 'c' },
      { pid: 200, ppid: 200, cwd: '/x', startTime: 'd' },
    ];
    const byPid = new Map(records.map((r) => [r.pid, r]));

    expect([...protectedAncestry(100, byPid)]).toEqual([100, 90, 80]);
    expect([...protectedAncestry(200, byPid)]).toEqual([200]); // cycle terminates.
    // selfPid absent from the table is still protected (just can't walk further).
    expect([...protectedAncestry(999, byPid)]).toEqual([999]);
  });
});

describe('probeWorktreeUsage', () => {
  it('Probe_SelfRootedCwd_ExcludedFromInUseSet', () => {
    // The orchestrator's OWN shell (selfPid) has drifted its cwd into worktree W.
    // A self-rooted cwd must NEVER mark a worktree in-use, or the orchestrator
    // would forever see its own worktrees as occupied and never reclaim them.
    const W = '/repo/.worktrees/W';
    const records: ProcessRecord[] = [
      { pid: 4242, ppid: 1, cwd: `${W}/src`, startTime: 'self-ct' }, // self, inside W
    ];

    const [usage] = probeWorktreeUsage(
      { worktreePaths: [W], selfPid: 4242 },
      tableSource(records),
      identity,
    );

    expect(usage!.inUse).toBe(false);
    expect(usage!.occupantPids).toEqual([]);
  });

  it('Probe_OwnerAncestryChain_FullyProtected', () => {
    // The WHOLE parent chain of selfPid is excluded, not just the leaf. Here the
    // self process (300) sits outside W, but its grandparent (100) — the
    // orchestrator shell whose cwd drifted into W — is in the ancestry chain and
    // must also be subtracted. An unrelated process (500) inside W still counts.
    const W = '/repo/.worktrees/W';
    const records: ProcessRecord[] = [
      { pid: 300, ppid: 200, cwd: '/elsewhere', startTime: 's' }, // self, outside W
      { pid: 200, ppid: 100, cwd: `${W}/a`, startTime: 'p' }, // parent, inside W
      { pid: 100, ppid: 0, cwd: `${W}/b`, startTime: 'g' }, // grandparent, inside W
      { pid: 500, ppid: 1, cwd: `${W}/c`, startTime: 'u' }, // unrelated, inside W
    ];

    const [usage] = probeWorktreeUsage(
      { worktreePaths: [W], selfPid: 300 },
      tableSource(records),
      identity,
    );

    // Parent (200) and grandparent (100) are protected; only the unrelated 500
    // marks W in-use.
    expect(usage!.occupantPids).toEqual([500]);
    expect(usage!.inUse).toBe(true);
  });

  it('Probe_SymlinkedWorktreePath_ContainmentMatches', () => {
    // A process cwd reported under the macOS `/var` symlink must match a worktree
    // recorded under its canonical `/private/var` realpath (and vice versa).
    // Resolving symlinks on BOTH sides canonicalizes them to the same root.
    const symlinkMap: Record<string, string> = {
      '/var/folders/abc/W': '/private/var/folders/abc/W',
      '/var/folders/abc/W/agent': '/private/var/folders/abc/W/agent',
      '/private/var/folders/abc/W': '/private/var/folders/abc/W',
    };
    const symlinkRealpath: RealpathResolver = (p) => symlinkMap[p] ?? p;

    const records: ProcessRecord[] = [
      { pid: 700, ppid: 1, cwd: '/var/folders/abc/W/agent', startTime: 'x' }, // via /var
    ];

    // Worktree recorded under the canonical /private/var form; process cwd under
    // the /var symlink form — both-sides realpath resolution still contains it.
    const [usage] = probeWorktreeUsage(
      { worktreePaths: ['/private/var/folders/abc/W'], selfPid: 1 },
      tableSource(records),
      symlinkRealpath,
    );

    expect(usage!.inUse).toBe(true);
    expect(usage!.occupantPids).toEqual([700]);
  });
});

describe('probeReservations', () => {
  it('Probe_DeadOwner_ReportedReleasable', () => {
    // A reservation is releasable iff its owner is provably gone: PID absent from
    // the table, OR present but with a mismatched create-time (PID reuse). A live
    // owner (PID present AND create-time matches) is NEVER releasable.
    const records: ProcessRecord[] = [
      { pid: 11, ppid: 1, cwd: '/x', startTime: 'live-ct' }, // live owner of W-live
      { pid: 22, ppid: 1, cwd: '/x', startTime: 'reused-ct' }, // PID 22 REUSED by newer proc
    ];

    const findings = probeReservations(
      [
        { worktreePath: '/wt/live', ownerPid: 11, ownerStartedAt: 'live-ct' }, // alive
        { worktreePath: '/wt/reused', ownerPid: 22, ownerStartedAt: 'orig-ct' }, // reuse -> dead
        { worktreePath: '/wt/gone', ownerPid: 33, ownerStartedAt: 'gone-ct' }, // absent -> dead
      ],
      tableSource(records),
    );

    const byPath = Object.fromEntries(findings.map((f) => [f.worktreePath, f]));

    // Live owner: present AND create-time matches -> never releasable.
    expect(byPath['/wt/live']!.liveness).toBe('alive');
    expect(byPath['/wt/live']!.releasable).toBe(false);

    // PID present but create-time differs (reuse) -> dead -> releasable.
    expect(byPath['/wt/reused']!.liveness).toBe('dead');
    expect(byPath['/wt/reused']!.releasable).toBe(true);

    // PID absent from a SUPPORTED table (owner exited) -> dead -> releasable.
    // (The table is non-empty / enumerated, so absence is authoritative.)
    expect(byPath['/wt/gone']!.liveness).toBe('dead');
    expect(byPath['/wt/gone']!.releasable).toBe(true);
  });

  it('Probe_UnsupportedPlatformTable_FailsClosed_NeverReleasable', () => {
    // The off-Linux hole (REV-H1): an UNSUPPORTED table cannot prove a PID
    // absent, so an owner that LOOKS gone (its pid is not in the empty list) must
    // read as 'unknown', NOT 'dead' — and therefore is NEVER releasable. The old
    // two-valued mapping classified this owner 'dead' and let `waitForFreeSlot`
    // reclaim a LIVE merge holder; this pins the fail-closed contract.
    const findings = probeReservations(
      [
        { worktreePath: '/wt/a', ownerPid: 4242, ownerStartedAt: 'boot-4242' },
        { worktreePath: '/wt/b', ownerPid: 7, ownerStartedAt: 'boot-7' },
      ],
      UNSUPPORTED_TABLE,
    );

    for (const finding of findings) {
      expect(finding.liveness).toBe('unknown'); // cannot prove dead off-Linux.
      expect(finding.releasable).toBe(false); // fail closed — never reclaim.
    }
  });
});

describe('probeWorktrees (composite)', () => {
  it('live occupancy vetoes a dead-owner release (orphan-candidate only when truly free)', () => {
    // The recorded owner of W is gone (dead), but an UNRELATED live process has
    // re-entered W. Ground-truth occupancy must veto the stale "owner dead"
    // verdict: W is NOT releasable while a live non-ancestry process occupies it.
    const W = '/repo/.worktrees/W';
    const records: ProcessRecord[] = [
      { pid: 4242, ppid: 1, cwd: '/elsewhere', startTime: 'self' }, // self, outside W
      { pid: 808, ppid: 1, cwd: `${W}/x`, startTime: 'intruder' }, // live, inside W
    ];

    const [occupied] = probeWorktrees(
      {
        targets: [{ worktreePath: W, owner: { ownerPid: 99, ownerStartedAt: 'long-gone' } }],
        selfPid: 4242,
      },
      tableSource(records),
      identity,
    );

    expect(occupied!.ownerLiveness).toBe('dead'); // owner PID 99 absent -> dead
    expect(occupied!.inUse).toBe(true); // but 808 is rooted inside
    expect(occupied!.releasable).toBe(false); // occupancy vetoes release

    // With no live occupant, the same dead-owner worktree IS an orphan candidate.
    const [free] = probeWorktrees(
      {
        targets: [{ worktreePath: W, owner: { ownerPid: 99, ownerStartedAt: 'long-gone' } }],
        selfPid: 4242,
      },
      tableSource([records[0]]), // only self remains
      identity,
    );
    expect(free!.inUse).toBe(false);
    expect(free!.releasable).toBe(true);
  });

  it('Probe_UnsupportedTable_OwnerUnknown_NotReleasableNorOrphan', () => {
    // On an UNSUPPORTED table the composite probe must classify a reserved
    // worktree as neither releasable NOR an orphan candidate: ownerLiveness is
    // 'unknown' (not 'dead'), so manager.probeAndReclaim — which emits
    // worktree.released only when `releasable` and worktree.orphan_detected only
    // when `ownerLiveness === 'dead' && inUse` — emits NOTHING. Fail closed.
    const W = '/repo/.worktrees/W';
    const [finding] = probeWorktrees(
      {
        targets: [{ worktreePath: W, owner: { ownerPid: 555, ownerStartedAt: 'boot-555' } }],
        selfPid: 999999,
      },
      UNSUPPORTED_TABLE,
      identity,
    );

    expect(finding!.ownerLiveness).toBe('unknown'); // cannot prove dead off-Linux.
    expect(finding!.releasable).toBe(false); // no worktree.released.
    expect(finding!.inUse).toBe(false); // empty list → no occupant either.
    // Neither emit branch fires: not releasable, and ownerLiveness !== 'dead'.
    expect(finding!.ownerLiveness === 'dead' && finding!.inUse).toBe(false);
  });

  it('reports ownerLiveness "none" for an unreserved worktree', () => {
    const [finding] = probeWorktrees(
      { targets: [{ worktreePath: '/wt/free', owner: null }], selfPid: 1 },
      tableSource([]),
      identity,
    );
    expect(finding!.ownerLiveness).toBe('none');
    expect(finding!.inUse).toBe(false);
    expect(finding!.releasable).toBe(false); // 'none' is not 'dead' -> not releasable
  });
});

describe('probeLaunchHolders (DR-6)', () => {
  it('reconciles a dead supervisor holder, holds a live one', () => {
    // The `holderPid` is the launcher/SUPERVISOR PID responsible for writing the
    // `launch.executed` terminal. A launch is reconcilable iff that holder is
    // provably dead (PID absent, OR present with a mismatched create-time = PID
    // reuse) — the terminal will otherwise never be written. A live holder (PID
    // present AND create-time matches) is NEVER reconcilable.
    const records: ProcessRecord[] = [
      { pid: 11, ppid: 1, cwd: '/x', startTime: 'live-ct' }, // live supervisor of launch-live
      { pid: 22, ppid: 1, cwd: '/x', startTime: 'reused-ct' }, // PID 22 REUSED by newer proc
    ];

    const findings = probeLaunchHolders(
      [
        { worktreeId: '/wt/launch-live', holderPid: 11, holderStartedAt: 'live-ct' }, // alive
        { worktreeId: '/wt/launch-reused', holderPid: 22, holderStartedAt: 'orig-ct' }, // reuse -> dead
        { worktreeId: '/wt/launch-gone', holderPid: 33, holderStartedAt: 'gone-ct' }, // absent -> dead
      ],
      tableSource(records),
    );

    const byId = Object.fromEntries(findings.map((f) => [f.worktreeId, f]));

    expect(byId['/wt/launch-live']!.liveness).toBe('alive');
    expect(byId['/wt/launch-live']!.reconcilable).toBe(false);

    expect(byId['/wt/launch-reused']!.liveness).toBe('dead');
    expect(byId['/wt/launch-reused']!.reconcilable).toBe(true);

    expect(byId['/wt/launch-gone']!.liveness).toBe('dead');
    expect(byId['/wt/launch-gone']!.reconcilable).toBe(true);
  });

  it('holds a launch whose holder identity was never captured (null)', () => {
    // A `launch.executing_started` whose emitter could not capture the holder
    // PID/create-time cannot be proven dead → 'unknown' → NEVER reconcilable
    // (fail closed), even against a SUPPORTED table.
    const findings = probeLaunchHolders(
      [
        { worktreeId: '/wt/no-pid', holderPid: null, holderStartedAt: 'boot-x' },
        { worktreeId: '/wt/no-ct', holderPid: 44, holderStartedAt: null },
      ],
      tableSource([]),
    );

    for (const finding of findings) {
      expect(finding.liveness).toBe('unknown');
      expect(finding.reconcilable).toBe(false);
    }
  });

  it('Probe_UnsupportedPlatformTable_FailsClosed_NeverReconcilable', () => {
    // Off-Linux the process table is UNSUPPORTED: a holder that LOOKS gone (its
    // pid is not in the empty list) reads as 'unknown', NOT 'dead', so NOTHING is
    // reconciled — mirroring the reservation probe's fail-closed contract so a
    // live supervisor's launch is never reclaimed on a platform we cannot probe.
    const findings = probeLaunchHolders(
      [
        { worktreeId: '/wt/a', holderPid: 4242, holderStartedAt: 'boot-4242' },
        { worktreeId: '/wt/b', holderPid: 7, holderStartedAt: 'boot-7' },
      ],
      UNSUPPORTED_TABLE,
    );

    for (const finding of findings) {
      expect(finding.liveness).toBe('unknown');
      expect(finding.reconcilable).toBe(false);
    }
  });
});

describe('makeDefaultProcessTableSource (win32 process source — DR-5)', () => {
  // The exact TAB-separated `pid<TAB>ppid<TAB>FILETIME<TAB>cwd` shape
  // `WIN32_PROCESS_TABLE_COMMAND` emits, fed through the injected reader so NO
  // real PowerShell runs — the win32 test is shape-based (there is no Windows
  // host in CI). FILETIMEs are opaque, equality-compared create-times.
  const WIN32_RAW = [
    '4242\t1000\t133600000000000000\tC:\\repo\\.worktrees\\W\\agent',
    '5555\t4242\t133600000000000001\tC:\\repo\\.worktrees\\W\\agent\\src',
    '77\t1\t133700000000000000\t', // PEB-unreadable → empty cwd, still enumerated
    '', // blank line ignored
    'not\ta\tprocess\trow', // non-numeric pid/ppid/createtime → skipped
  ].join('\n');

  it('ProcessSource_Win32_ResolvesCwdAndCreateTime', () => {
    // Behind the SAME injected process-source seam the pure probe already uses,
    // the win32 source resolves each process's cwd AND create-time from the
    // shimmed enumeration — no OS access on the POSIX CI host.
    const source = makeDefaultProcessTableSource({
      platform: 'win32',
      readWin32ProcessTable: () => WIN32_RAW,
    });

    // `Get-CimInstance Win32_Process` is a COMPLETE enumeration → authoritative,
    // so an absent PID is provably gone: win32 is a SUPPORTED table.
    expect(source.isSupported?.()).toBe(true);

    // Malformed/blank rows dropped; the three well-formed processes each resolve
    // BOTH cwd (verbatim, spaces/backslashes preserved) and create-time.
    expect(source.list()).toEqual([
      {
        pid: 4242,
        ppid: 1000,
        cwd: 'C:\\repo\\.worktrees\\W\\agent',
        startTime: '133600000000000000',
      },
      {
        pid: 5555,
        ppid: 4242,
        cwd: 'C:\\repo\\.worktrees\\W\\agent\\src',
        startTime: '133600000000000001',
      },
      { pid: 77, ppid: 1, cwd: '', startTime: '133700000000000000' },
    ]);

    // The resolved create-time DRIVES owner-liveness over the win32 table: a
    // matching FILETIME is alive; a reused (mismatched) one is dead; a PID absent
    // from the complete enumeration is provably dead (never 'unknown').
    const findings = probeReservations(
      [
        { worktreePath: '/wt/live', ownerPid: 4242, ownerStartedAt: '133600000000000000' },
        { worktreePath: '/wt/reused', ownerPid: 5555, ownerStartedAt: '133500000000000000' },
        { worktreePath: '/wt/gone', ownerPid: 999, ownerStartedAt: 'boot-999' },
      ],
      source,
    );
    const byPath = Object.fromEntries(findings.map((f) => [f.worktreePath, f]));
    expect(byPath['/wt/live']!.liveness).toBe('alive');
    expect(byPath['/wt/reused']!.liveness).toBe('dead'); // create-time mismatch (PID reuse)
    expect(byPath['/wt/gone']!.liveness).toBe('dead'); // absent from a supported table
  });

  it('ProcessSource_UnsupportedPlatform_ReturnsUnknownFailClosed', () => {
    // A platform with no enumerator (freebsd here; equally macOS / #1579): list()
    // is empty AND isSupported() is false, so a PID that LOOKS gone reads as
    // 'unknown' (NOT 'dead') and is NEVER releasable — fail closed (DR-7). The
    // win32 reader is only consulted on win32.
    let readerCalls = 0;
    const source = makeDefaultProcessTableSource({
      platform: 'freebsd',
      readWin32ProcessTable: () => {
        readerCalls += 1;
        return WIN32_RAW;
      },
    });

    expect(source.isSupported?.()).toBe(false);
    expect(source.list()).toEqual([]);
    expect(readerCalls).toBe(0); // off-win32 never runs the win32 enumeration

    const findings = probeReservations(
      [{ worktreePath: '/wt/a', ownerPid: 4242, ownerStartedAt: 'boot-4242' }],
      source,
    );
    expect(findings[0]!.liveness).toBe('unknown');
    expect(findings[0]!.releasable).toBe(false);
  });

  it('WinLiveness_IndeterminateEnum_FailsClosed', () => {
    // DR-17 / #1641: a TRANSIENTLY failed win32 enumeration must never read as
    // "every owner provably dead". Both indeterminate shapes — the reader
    // THROWING (PowerShell spawn failure) and the reader returning EMPTY
    // stdout (`Get-CimInstance` silent failure under SilentlyContinue) — must
    // flip the snapshot to unsupported, so every liveness verdict over it is
    // 'unknown' (a structured fail-closed outcome), NEVER 'dead'. The old
    // static `isSupported() === platform === 'win32'` read the empty table as
    // authoritative and would have reclaimed a LIVE holder's worktree.
    const liveHolder = { worktreePath: '/wt/live-holder', ownerPid: 4242, ownerStartedAt: 'ct-4242' };

    for (const readWin32ProcessTable of [
      (): string => {
        throw new Error('transient CIM enumeration failure');
      },
      (): string => '', // spawn succeeded, enumeration silently produced nothing
    ]) {
      const source = makeDefaultProcessTableSource({ platform: 'win32', readWin32ProcessTable });

      // The snapshot is empty AND flagged indeterminate — not a real table.
      expect(source.list()).toEqual([]);
      expect(source.isSupported?.()).toBe(false);

      // Reservation probe: the holder LOOKS absent, but absence off an
      // indeterminate snapshot is not proof of death → unknown, never released.
      const [reservation] = probeReservations([liveHolder], source);
      expect(reservation!.liveness).toBe('unknown');
      expect(reservation!.releasable).toBe(false);

      // Launch-holder probe (DR-6): same fail-closed contract — never reconciled.
      const [launch] = probeLaunchHolders(
        [{ worktreeId: '/wt/launch', holderPid: 4242, holderStartedAt: 'ct-4242' }],
        source,
      );
      expect(launch!.liveness).toBe('unknown');
      expect(launch!.reconcilable).toBe(false);

      // Composite probe: neither releasable nor an orphan candidate.
      const [composite] = probeWorktrees(
        {
          targets: [{ worktreePath: '/wt/w', owner: { ownerPid: 4242, ownerStartedAt: 'ct-4242' } }],
          selfPid: 999999,
        },
        source,
        identity,
      );
      expect(composite!.ownerLiveness).toBe('unknown');
      expect(composite!.releasable).toBe(false);
    }
  });

  it('WinLiveness_TransientFailure_RecoversToDeterminateVerdicts', () => {
    // The indeterminate verdict is PER-SNAPSHOT, not sticky: after a failed
    // enumeration (probe 1 → 'unknown'), a subsequent SUCCESSFUL `list()`
    // restores the authoritative supported table — a live FILETIME match reads
    // 'alive' and an absent PID is again provably 'dead'.
    let calls = 0;
    const source = makeDefaultProcessTableSource({
      platform: 'win32',
      readWin32ProcessTable: () => {
        calls += 1;
        if (calls === 1) throw new Error('transient CIM enumeration failure');
        return WIN32_RAW;
      },
    });

    const owners = [
      { worktreePath: '/wt/live', ownerPid: 4242, ownerStartedAt: '133600000000000000' },
      { worktreePath: '/wt/gone', ownerPid: 999, ownerStartedAt: 'boot-999' },
    ];

    // Probe 1: enumeration fails → both owners 'unknown', nothing releasable.
    for (const finding of probeReservations(owners, source)) {
      expect(finding.liveness).toBe('unknown');
      expect(finding.releasable).toBe(false);
    }

    // Probe 2: enumeration succeeds → determinate verdicts return.
    const byPath = Object.fromEntries(
      probeReservations(owners, source).map((f) => [f.worktreePath, f]),
    );
    expect(byPath['/wt/live']!.liveness).toBe('alive');
    expect(byPath['/wt/live']!.releasable).toBe(false);
    expect(byPath['/wt/gone']!.liveness).toBe('dead'); // absent from a REAL table
    expect(byPath['/wt/gone']!.releasable).toBe(true);
  });

  it('Win32ProcessTable_Parses_SkipsMalformed_KeepsEmptyCwd_PreservesSpaces', () => {
    // Parser contract: numeric pid/ppid/createTime required (else the row is a
    // vanished/malformed process → skipped); cwd is field 4 onward, preserved
    // VERBATIM (spaces/backslashes intact) for the later realpath canonicalizer;
    // a row with no cwd field keeps cwd '' so its PID/create-time still anchor
    // owner-liveness.
    const raw = [
      '10\t2\t133600000000000000\tC:\\a b\\wt', // spaces in cwd preserved
      '   ', // whitespace-only ignored
      'x\t2\t3\tC:\\bad', // non-numeric pid → skipped
      '11\ty\t3\tC:\\bad', // non-numeric ppid → skipped
      '12\t2\tnope\tC:\\bad', // non-numeric createtime → skipped
      '13\t2\t7', // no cwd field → cwd '' kept
    ].join('\n');

    expect(parseWin32ProcessTable(raw)).toEqual([
      { pid: 10, ppid: 2, cwd: 'C:\\a b\\wt', startTime: '133600000000000000' },
      { pid: 13, ppid: 2, cwd: '', startTime: '7' },
    ]);
  });
});

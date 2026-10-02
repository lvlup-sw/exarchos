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
} from '../../../../../src/verbs/worktree/pure/probe.js';
import type { RealpathResolver } from '../../../../../src/verbs/worktree/pure/path-containment.js';

/**
 * A supported `ProcessTableSource` over a fixed in-memory table. It has no
 * `isSupported`, so the probe reads it as supported, and a PID absent from
 * `list()` is provably gone.
 */
function tableSource(records: readonly ProcessRecord[]): ProcessTableSource {
  return { list: () => records };
}

/**
 * An unsupported `ProcessTableSource`, as on a platform with no enumerator.
 * `list()` returns `[]` and `isSupported()` is `false`, so an absent PID is
 * `'unknown'`, not provably dead.
 */
const UNSUPPORTED_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => false,
};

/** A resolver with no symlinks. Each path passes through unchanged. */
const identity: RealpathResolver = (p) => p;

describe('protectedAncestry', () => {
  /**
   * The chain 100, 90, 80 ends at `ppid` 0. The PID 200 is its own parent, and
   * the walk must stop there. A `selfPid` that is not in the table is still in the set.
   */
  it('walks the full pid -> ppid chain and terminates at a cycle', () => {
    const records: ProcessRecord[] = [
      { pid: 100, ppid: 90, cwd: '/x', startTime: 'a' },
      { pid: 90, ppid: 80, cwd: '/x', startTime: 'b' },
      { pid: 80, ppid: 0, cwd: '/x', startTime: 'c' },
      { pid: 200, ppid: 200, cwd: '/x', startTime: 'd' },
    ];
    const byPid = new Map(records.map((r) => [r.pid, r]));

    expect([...protectedAncestry(100, byPid)]).toEqual([100, 90, 80]);
    expect([...protectedAncestry(200, byPid)]).toEqual([200]);
    expect([...protectedAncestry(999, byPid)]).toEqual([999]);
  });
});

describe('probeWorktreeUsage', () => {
  /**
   * The `selfPid` process has its cwd inside the worktree. That cwd must not
   * mark the worktree as in use. Otherwise the orchestrator sees its own
   * worktrees as occupied and never reclaims them.
   */
  it('Probe_SelfRootedCwd_ExcludedFromInUseSet', () => {
    const W = '/repo/.worktrees/W';
    const records: ProcessRecord[] = [
      { pid: 4242, ppid: 1, cwd: `${W}/src`, startTime: 'self-ct' },
    ];

    const [usage] = probeWorktreeUsage(
      { worktreePaths: [W], selfPid: 4242 },
      tableSource(records),
      identity,
    );

    expect(usage.inUse).toBe(false);
    expect(usage.occupantPids).toEqual([]);
  });

  /**
   * The full parent chain of `selfPid` is excluded, not only the leaf. The self
   * process 300 is outside W. Its parent 200 and grandparent 100 are inside W
   * and are excluded. The unrelated process 500 inside W still counts.
   */
  it('Probe_OwnerAncestryChain_FullyProtected', () => {
    const W = '/repo/.worktrees/W';
    const records: ProcessRecord[] = [
      { pid: 300, ppid: 200, cwd: '/elsewhere', startTime: 's' },
      { pid: 200, ppid: 100, cwd: `${W}/a`, startTime: 'p' },
      { pid: 100, ppid: 0, cwd: `${W}/b`, startTime: 'g' },
      { pid: 500, ppid: 1, cwd: `${W}/c`, startTime: 'u' },
    ];

    const [usage] = probeWorktreeUsage(
      { worktreePaths: [W], selfPid: 300 },
      tableSource(records),
      identity,
    );

    expect(usage.occupantPids).toEqual([500]);
    expect(usage.inUse).toBe(true);
  });

  /**
   * A process cwd under the macOS `/var` symlink must match a worktree recorded
   * under the `/private/var` realpath. The probe resolves symlinks on both sides.
   */
  it('Probe_SymlinkedWorktreePath_ContainmentMatches', () => {
    const symlinkMap: Record<string, string> = {
      '/var/folders/abc/W': '/private/var/folders/abc/W',
      '/var/folders/abc/W/agent': '/private/var/folders/abc/W/agent',
      '/private/var/folders/abc/W': '/private/var/folders/abc/W',
    };
    const symlinkRealpath: RealpathResolver = (p) => symlinkMap[p] ?? p;

    const records: ProcessRecord[] = [
      { pid: 700, ppid: 1, cwd: '/var/folders/abc/W/agent', startTime: 'x' },
    ];

    const [usage] = probeWorktreeUsage(
      { worktreePaths: ['/private/var/folders/abc/W'], selfPid: 1 },
      tableSource(records),
      symlinkRealpath,
    );

    expect(usage.inUse).toBe(true);
    expect(usage.occupantPids).toEqual([700]);
  });
});

describe('probeReservations', () => {
  /**
   * A reservation is releasable only when its owner is provably gone. The PID
   * is absent from a supported table, or present with a different create time
   * because of PID reuse. A live owner is not releasable.
   */
  it('Probe_DeadOwner_ReportedReleasable', () => {
    const records: ProcessRecord[] = [
      { pid: 11, ppid: 1, cwd: '/x', startTime: 'live-ct' },
      { pid: 22, ppid: 1, cwd: '/x', startTime: 'reused-ct' },
    ];

    const findings = probeReservations(
      [
        { worktreePath: '/wt/live', ownerPid: 11, ownerStartedAt: 'live-ct' },
        { worktreePath: '/wt/reused', ownerPid: 22, ownerStartedAt: 'orig-ct' },
        { worktreePath: '/wt/gone', ownerPid: 33, ownerStartedAt: 'gone-ct' },
      ],
      tableSource(records),
    );

    const byPath = Object.fromEntries(findings.map((f) => [f.worktreePath, f]));

    expect(byPath['/wt/live'].liveness).toBe('alive');
    expect(byPath['/wt/live'].releasable).toBe(false);

    expect(byPath['/wt/reused'].liveness).toBe('dead');
    expect(byPath['/wt/reused'].releasable).toBe(true);

    expect(byPath['/wt/gone'].liveness).toBe('dead');
    expect(byPath['/wt/gone'].releasable).toBe(true);
  });

  /**
   * An unsupported table cannot prove a PID absent. An owner that is not in the
   * empty list must read as `'unknown'`, not `'dead'`, and is not releasable.
   * Otherwise `waitForFreeSlot` can reclaim a live merge holder.
   */
  it('Probe_UnsupportedPlatformTable_FailsClosed_NeverReleasable', () => {
    const findings = probeReservations(
      [
        { worktreePath: '/wt/a', ownerPid: 4242, ownerStartedAt: 'boot-4242' },
        { worktreePath: '/wt/b', ownerPid: 7, ownerStartedAt: 'boot-7' },
      ],
      UNSUPPORTED_TABLE,
    );

    for (const finding of findings) {
      expect(finding.liveness).toBe('unknown');
      expect(finding.releasable).toBe(false);
    }
  });
});

describe('probeWorktrees (composite)', () => {
  /**
   * The recorded owner 99 of W is dead, but the unrelated live process 808 is
   * inside W. Live occupancy must veto the release. With only the self process
   * left in the table, the same worktree is releasable.
   */
  it('live occupancy vetoes a dead-owner release (orphan-candidate only when truly free)', () => {
    const W = '/repo/.worktrees/W';
    const records: ProcessRecord[] = [
      { pid: 4242, ppid: 1, cwd: '/elsewhere', startTime: 'self' },
      { pid: 808, ppid: 1, cwd: `${W}/x`, startTime: 'intruder' },
    ];

    const [occupied] = probeWorktrees(
      {
        targets: [{ worktreePath: W, owner: { ownerPid: 99, ownerStartedAt: 'long-gone' } }],
        selfPid: 4242,
      },
      tableSource(records),
      identity,
    );

    expect(occupied.ownerLiveness).toBe('dead');
    expect(occupied.inUse).toBe(true);
    expect(occupied.releasable).toBe(false);

    const [free] = probeWorktrees(
      {
        targets: [{ worktreePath: W, owner: { ownerPid: 99, ownerStartedAt: 'long-gone' } }],
        selfPid: 4242,
      },
      tableSource([records[0]]),
      identity,
    );
    expect(free.inUse).toBe(false);
    expect(free.releasable).toBe(true);
  });

  /**
   * On an unsupported table, `ownerLiveness` is `'unknown'`. The worktree is not
   * releasable and not an orphan candidate. `manager.probeAndReclaim` emits
   * `worktree.released` only when `releasable`, and `worktree.orphan_detected`
   * only when `ownerLiveness === 'dead' && inUse`, so it emits nothing.
   */
  it('Probe_UnsupportedTable_OwnerUnknown_NotReleasableNorOrphan', () => {
    const W = '/repo/.worktrees/W';
    const [finding] = probeWorktrees(
      {
        targets: [{ worktreePath: W, owner: { ownerPid: 555, ownerStartedAt: 'boot-555' } }],
        selfPid: 999999,
      },
      UNSUPPORTED_TABLE,
      identity,
    );

    expect(finding.ownerLiveness).toBe('unknown');
    expect(finding.releasable).toBe(false);
    expect(finding.inUse).toBe(false);
    expect(finding.ownerLiveness === 'dead' && finding.inUse).toBe(false);
  });

  it('reports ownerLiveness "none" for an unreserved worktree', () => {
    const [finding] = probeWorktrees(
      { targets: [{ worktreePath: '/wt/free', owner: null }], selfPid: 1 },
      tableSource([]),
      identity,
    );
    expect(finding.ownerLiveness).toBe('none');
    expect(finding.inUse).toBe(false);
    expect(finding.releasable).toBe(false);
  });
});

describe('probeLaunchHolders (DR-6)', () => {
  /**
   * The `holderPid` is the supervisor that writes the `launch.executed`
   * terminal. A launch is reconcilable only when that holder is provably dead,
   * because the terminal then never arrives. A live holder is not reconcilable.
   */
  it('reconciles a dead supervisor holder, holds a live one', () => {
    const records: ProcessRecord[] = [
      { pid: 11, ppid: 1, cwd: '/x', startTime: 'live-ct' },
      { pid: 22, ppid: 1, cwd: '/x', startTime: 'reused-ct' },
    ];

    const findings = probeLaunchHolders(
      [
        { worktreeId: '/wt/launch-live', holderPid: 11, holderStartedAt: 'live-ct' },
        { worktreeId: '/wt/launch-reused', holderPid: 22, holderStartedAt: 'orig-ct' },
        { worktreeId: '/wt/launch-gone', holderPid: 33, holderStartedAt: 'gone-ct' },
      ],
      tableSource(records),
    );

    const byId = Object.fromEntries(findings.map((f) => [f.worktreeId, f]));

    expect(byId['/wt/launch-live'].liveness).toBe('alive');
    expect(byId['/wt/launch-live'].reconcilable).toBe(false);

    expect(byId['/wt/launch-reused'].liveness).toBe('dead');
    expect(byId['/wt/launch-reused'].reconcilable).toBe(true);

    expect(byId['/wt/launch-gone'].liveness).toBe('dead');
    expect(byId['/wt/launch-gone'].reconcilable).toBe(true);
  });

  /**
   * A holder with a `null` PID or create time cannot be proven dead. It is
   * `'unknown'` and not reconcilable, even on a supported table.
   */
  it('holds a launch whose holder identity was never captured (null)', () => {
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

  /**
   * On an unsupported table, a holder that is not in the empty list reads as
   * `'unknown'`, not `'dead'`. No launch reconciles, as with reservations.
   */
  it('Probe_UnsupportedPlatformTable_FailsClosed_NeverReconcilable', () => {
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

/**
 * Tests the win32 process source through an injected reader, so no PowerShell
 * runs. `WIN32_RAW` holds rows in the tab-separated `pid`, `ppid`, FILETIME,
 * `cwd` shape, plus a row with an empty `cwd`, a blank line, and a non-numeric
 * row. `LIVE_HOLDER` is alive in `WIN32_RAW`. `throwingReader` fails as a
 * PowerShell spawn error does. `expectLiveHolderHeld` asserts that the source
 * reads as unsupported and that no probe releases or reconciles the live holder.
 */
describe('makeDefaultProcessTableSource (win32 process source — DR-5)', () => {
  const WIN32_RAW = [
    '4242\t1000\t133600000000000000\tC:\\repo\\.worktrees\\W\\agent',
    '5555\t4242\t133600000000000001\tC:\\repo\\.worktrees\\W\\agent\\src',
    '77\t1\t133700000000000000\t',
    '',
    'not\ta\tprocess\trow',
  ].join('\n');

  /**
   * The win32 source drops the blank and malformed rows. It keeps the cwd of
   * each process as it is, with its create time. A matching FILETIME is alive,
   * a different one is dead, and a PID absent from the table is dead.
   */
  it('ProcessSource_Win32_ResolvesCwdAndCreateTime', () => {
    const source = makeDefaultProcessTableSource({
      platform: 'win32',
      readWin32ProcessTable: () => WIN32_RAW,
    });

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
    expect(source.isSupported?.()).toBe(true);

    const findings = probeReservations(
      [
        { worktreePath: '/wt/live', ownerPid: 4242, ownerStartedAt: '133600000000000000' },
        { worktreePath: '/wt/reused', ownerPid: 5555, ownerStartedAt: '133500000000000000' },
        { worktreePath: '/wt/gone', ownerPid: 999, ownerStartedAt: 'boot-999' },
      ],
      source,
    );
    const byPath = Object.fromEntries(findings.map((f) => [f.worktreePath, f]));
    expect(byPath['/wt/live'].liveness).toBe('alive');
    expect(byPath['/wt/reused'].liveness).toBe('dead');
    expect(byPath['/wt/gone'].liveness).toBe('dead');
  });

  /**
   * On a platform with no enumerator, such as freebsd, `list()` is empty and
   * `isSupported()` is `false`. An absent PID reads as `'unknown'` and is not
   * releasable. The source does not call the win32 reader.
   */
  it('ProcessSource_UnsupportedPlatform_ReturnsUnknownFailClosed', () => {
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
    expect(readerCalls).toBe(0);

    const findings = probeReservations(
      [{ worktreePath: '/wt/a', ownerPid: 4242, ownerStartedAt: 'boot-4242' }],
      source,
    );
    expect(findings[0].liveness).toBe('unknown');
    expect(findings[0].releasable).toBe(false);
  });

  const LIVE_HOLDER: { readonly pid: number; readonly startedAt: string } = {
    pid: 4242,
    startedAt: '133600000000000000',
  };

  function throwingReader(): string {
    throw new Error('transient CIM enumeration failure');
  }

  function expectLiveHolderHeld(source: ProcessTableSource): void {
    expect(source.list()).toEqual([]);
    expect(source.isSupported?.()).toBe(false);

    const [reservation] = probeReservations(
      [{ worktreePath: '/wt/live', ownerPid: LIVE_HOLDER.pid, ownerStartedAt: LIVE_HOLDER.startedAt }],
      source,
    );
    expect(reservation?.liveness).toBe('unknown');
    expect(reservation?.releasable).toBe(false);

    const [launch] = probeLaunchHolders(
      [{ worktreeId: '/wt/live', holderPid: LIVE_HOLDER.pid, holderStartedAt: LIVE_HOLDER.startedAt }],
      source,
    );
    expect(launch?.liveness).toBe('unknown');
    expect(launch?.reconcilable).toBe(false);

    const [composite] = probeWorktrees(
      {
        targets: [
          {
            worktreePath: '/wt/live',
            owner: { ownerPid: LIVE_HOLDER.pid, ownerStartedAt: LIVE_HOLDER.startedAt },
          },
        ],
        selfPid: 999999,
      },
      source,
      identity,
    );
    expect(composite?.ownerLiveness).toBe('unknown');
    expect(composite?.releasable).toBe(false);
  }

  it('WinLiveness_BeforeFirstList_IsUnsupported', () => {
    let readerCalls = 0;
    const source = makeDefaultProcessTableSource({
      platform: 'win32',
      readWin32ProcessTable: () => {
        readerCalls += 1;
        return WIN32_RAW;
      },
    });

    expect(source.isSupported?.()).toBe(false);
    expect(readerCalls).toBe(0);
  });

  it('WinLiveness_ReaderThrows_FailsClosed', () => {
    expectLiveHolderHeld(
      makeDefaultProcessTableSource({ platform: 'win32', readWin32ProcessTable: throwingReader }),
    );
  });

  it('WinLiveness_ReaderReturnsNoRows_FailsClosed', () => {
    expectLiveHolderHeld(
      makeDefaultProcessTableSource({ platform: 'win32', readWin32ProcessTable: () => '' }),
    );
  });

  it('WinLiveness_SupportFollowsMostRecentSnapshot', () => {
    const reads: Array<() => string> = [
      throwingReader,
      () => WIN32_RAW,
      () => '',
    ];
    let call = 0;
    const source = makeDefaultProcessTableSource({
      platform: 'win32',
      readWin32ProcessTable: () => {
        const read = reads[call] ?? ((): string => WIN32_RAW);
        call += 1;
        return read();
      },
    });
    const owners = [
      { worktreePath: '/wt/live', ownerPid: LIVE_HOLDER.pid, ownerStartedAt: LIVE_HOLDER.startedAt },
      { worktreePath: '/wt/gone', ownerPid: 999, ownerStartedAt: 'boot-999' },
    ];

    const failed = probeReservations(owners, source);
    expect(source.isSupported?.()).toBe(false);
    expect(failed.map((f) => [f.liveness, f.releasable])).toEqual([
      ['unknown', false],
      ['unknown', false],
    ]);

    const recovered = probeReservations(owners, source);
    expect(source.isSupported?.()).toBe(true);
    expect(recovered.map((f) => [f.liveness, f.releasable])).toEqual([
      ['alive', false],
      ['dead', true],
    ]);

    const failedAgain = probeReservations(owners, source);
    expect(source.isSupported?.()).toBe(false);
    expect(failedAgain.map((f) => [f.liveness, f.releasable])).toEqual([
      ['unknown', false],
      ['unknown', false],
    ]);
  });

  /**
   * The parser skips a row with a non-numeric pid, ppid, or create time. It keeps
   * the cwd, from field 4 onward, as it is, with spaces and backslashes. A row
   * with no cwd field keeps an empty cwd, because its PID and create time still
   * serve owner liveness.
   */
  it('Win32ProcessTable_Parses_SkipsMalformed_KeepsEmptyCwd_PreservesSpaces', () => {
    const raw = [
      '10\t2\t133600000000000000\tC:\\a b\\wt',
      '   ',
      'x\t2\t3\tC:\\bad',
      '11\ty\t3\tC:\\bad',
      '12\t2\tnope\tC:\\bad',
      '13\t2\t7',
    ].join('\n');

    expect(parseWin32ProcessTable(raw)).toEqual([
      { pid: 10, ppid: 2, cwd: 'C:\\a b\\wt', startTime: '133600000000000000' },
      { pid: 13, ppid: 2, cwd: '', startTime: '7' },
    ]);
  });
});

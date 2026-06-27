import { describe, it, expect } from 'vitest';
import {
  protectedAncestry,
  probeWorktreeUsage,
  probeReservations,
  probeWorktrees,
  type ProcessRecord,
  type ProcessTableSource,
} from './probe.js';
import type { RealpathResolver } from './path-containment.js';

/** A fixed-snapshot ProcessTableSource over an in-memory process table. */
function tableSource(records: readonly ProcessRecord[]): ProcessTableSource {
  return { list: () => records };
}

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

    expect(usage.inUse).toBe(false);
    expect(usage.occupantPids).toEqual([]);
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
    expect(usage.occupantPids).toEqual([500]);
    expect(usage.inUse).toBe(true);
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

    expect(usage.inUse).toBe(true);
    expect(usage.occupantPids).toEqual([700]);
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
    expect(byPath['/wt/live'].liveness).toBe('alive');
    expect(byPath['/wt/live'].releasable).toBe(false);

    // PID present but create-time differs (reuse) -> dead -> releasable.
    expect(byPath['/wt/reused'].liveness).toBe('dead');
    expect(byPath['/wt/reused'].releasable).toBe(true);

    // PID absent from the table (owner exited) -> dead -> releasable.
    expect(byPath['/wt/gone'].liveness).toBe('dead');
    expect(byPath['/wt/gone'].releasable).toBe(true);
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

    expect(occupied.ownerLiveness).toBe('dead'); // owner PID 99 absent -> dead
    expect(occupied.inUse).toBe(true); // but 808 is rooted inside
    expect(occupied.releasable).toBe(false); // occupancy vetoes release

    // With no live occupant, the same dead-owner worktree IS an orphan candidate.
    const [free] = probeWorktrees(
      {
        targets: [{ worktreePath: W, owner: { ownerPid: 99, ownerStartedAt: 'long-gone' } }],
        selfPid: 4242,
      },
      tableSource([records[0]]), // only self remains
      identity,
    );
    expect(free.inUse).toBe(false);
    expect(free.releasable).toBe(true);
  });

  it('reports ownerLiveness "none" for an unreserved worktree', () => {
    const [finding] = probeWorktrees(
      { targets: [{ worktreePath: '/wt/free', owner: null }], selfPid: 1 },
      tableSource([]),
      identity,
    );
    expect(finding.ownerLiveness).toBe('none');
    expect(finding.inUse).toBe(false);
    expect(finding.releasable).toBe(false); // 'none' is not 'dead' -> not releasable
  });
});

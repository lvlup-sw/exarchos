// ─── Launcher teardown safety + recovery/crash/cwd-drift/origin edges (DR-6) ──
//
// HIGH-tier, boundary-touching suite for Task 012. Every test drives the REAL
// EventStore / SQLite substrate and (where a git target is probed) a REAL git
// repo in per-test tmp dirs, with the WLM release / process-table / git seams
// injected so the teardown-safety contract is asserted deterministically:
//
//   - teardown NEVER `git reset --hard`s and preserves uncommitted work;
//   - an unclean WLM release surfaces the INV-14 `recoveryError` discriminator;
//   - the guaranteed `launch.executed` terminal rides EVERY catchable teardown
//     path via the idempotent Task-006 seam (at-most-once even after a signal);
//   - a crash mid-spawn leaves no orphaned half-created worktree that escapes GC;
//   - the launcher's OWN cwd drift is excluded from the in-use set (#1577
//     protected-ancestry), so teardown never refuses over its own cwd;
//   - a non-git target / unreachable origin fails CLOSED with a structured error.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  defaultGitRunner,
  type GitRunner,
  type ReleaseResult,
  type ReservationOwner,
} from '../orchestrate/worktree/manager.js';
import { canonicalWorktreeId } from '../orchestrate/worktree/pure/path-containment.js';
import type {
  ProcessRecord,
  ProcessTableSource,
} from '../orchestrate/worktree/pure/probe.js';
import type {
  AsyncSpawnRequest,
  ChildHandle,
  SpawnExit,
} from '../utils/process.js';
import { emitLaunchExecuted, LAUNCH_EXECUTED } from './liveness.js';
import { deriveWorktreePath } from './topology.js';
import {
  createLauncherWorktree,
  CREATE_REQUESTED,
  CREATE_EXECUTED,
} from './create-worktree.js';
import { runLifecycle, type SpawnHarnessChildFn } from './lifecycle-core.js';
import type { ResolvedLaunch } from './verb.js';
import {
  teardownLaunch,
  makeLifecycleTeardown,
  recoverCrashedLaunch,
  defaultOriginReachable,
  ORIGIN_PROBE_TIMEOUT_MS,
  type TeardownOutcome,
} from './teardown.js';
import {
  installSignalHandlers,
  type SignalChild,
  type SignalListener,
  type SignalRegistrar,
  type TrappedSignal,
} from './signals.js';

// ─── git + event-store helpers (mirror lifecycle.test.ts) ─────────────────────

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'work']);
  git(dir, ['config', 'user.email', 'teardown@example.com']);
  git(dir, ['config', 'user.name', 'Teardown Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# launcher teardown test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync(base);
}

function worktreeEvents(store: EventStore): WorkflowEvent[] {
  return store.getReadBackend().queryEvents(WORKTREES_STREAM);
}

function terminalsFor(store: EventStore, worktreeId: string): WorkflowEvent[] {
  return worktreeEvents(store).filter(
    (e) => e.type === LAUNCH_EXECUTED && e.data?.worktreeId === worktreeId,
  );
}

// ─── Injectable seam doubles ──────────────────────────────────────────────────

/** A git runner that records every arg vector while delegating to real git. */
function recordingGit(): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = {
    run(args, cwd) {
      calls.push([...args]);
      return defaultGitRunner.run(args, cwd);
    },
  };
  return { runner, calls };
}

/** A fully scripted git runner (no real git) keyed on the arg vector. */
function scriptedGit(
  route: (args: readonly string[]) => { status: number; stdout?: string },
): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = {
    run(args) {
      calls.push([...args]);
      const r = route(args);
      return { status: r.status, stdout: r.stdout ?? '' };
    },
  };
  return { runner, calls };
}

/** A release seam double recording its calls and returning a fixed verdict. */
function fakeRelease(result: ReleaseResult): {
  fn: (worktreeId: string, owner?: ReservationOwner) => Promise<ReleaseResult>;
  calls: Array<{ worktreeId: string; owner?: ReservationOwner }>;
} {
  const calls: Array<{ worktreeId: string; owner?: ReservationOwner }> = [];
  return {
    calls,
    fn: async (worktreeId, owner) => {
      calls.push({ worktreeId, ...(owner !== undefined ? { owner } : {}) });
      return result;
    },
  };
}

/** An in-memory, SUPPORTED process table over a fixed record set. */
function fakeTable(records: ProcessRecord[]): ProcessTableSource {
  return { list: () => records, isSupported: () => true };
}

/** No git call in the recorded set is a destructive `git reset --hard`. */
function noResetHard(calls: string[][]): boolean {
  return !calls.some((a) => a[0] === 'reset' && a.includes('--hard'));
}

/** No git call in the recorded set is a `reset` OR a `worktree remove`. */
function noDestructiveGit(calls: string[][]): boolean {
  return !calls.some(
    (a) => a[0] === 'reset' || (a[0] === 'worktree' && a[1] === 'remove'),
  );
}

// ─── Controllable fake spawn (mirror lifecycle.test.ts) ───────────────────────

function makeFakeSpawn(exit: SpawnExit, pid = 44444): SpawnHarnessChildFn {
  return async (request: AsyncSpawnRequest) => {
    void request;
    const handle: ChildHandle = {
      pid,
      exit: Promise.resolve(exit),
      kill: () => true,
    };
    return handle;
  };
}

/** A spawn primitive that rejects — the spawn-never-started catchable path. */
const throwingSpawn: SpawnHarnessChildFn = async () => {
  throw new Error('spawn failed to start');
};

const HOLDER = {
  holderPid: process.pid,
  holderStartedAt: 'teardown-boot-fingerprint',
} as const;

// ─── Deterministic signal-registration fake (drives installSignalHandlers) ────

/**
 * A {@link SignalRegistrar} that captures listeners in-memory so a test drives
 * the trap by calling {@link fire} — no real signal is delivered to the vitest
 * process. `fire` awaits each listener so the async trap body (forward → terminal
 * → reap → teardown) is fully settled before the test asserts.
 */
function makeFakeRegistrar(): {
  registrar: SignalRegistrar;
  fire(signal: TrappedSignal): Promise<void>;
} {
  const listeners = new Map<TrappedSignal, SignalListener[]>();
  return {
    registrar: {
      add(signal, listener) {
        listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
      },
      remove(signal, listener) {
        listeners.set(
          signal,
          (listeners.get(signal) ?? []).filter((l) => l !== listener),
        );
      },
    },
    async fire(signal) {
      await Promise.all((listeners.get(signal) ?? []).map((l) => l(signal)));
    },
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('teardownLaunch — launcher teardown safety + recovery (DR-6)', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;
  let ctx: DispatchContext;
  let repo: string;
  let base: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'launcher-teardown-state-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'launcher-teardown-work-'));
    store = new EventStore(stateDir);
    await store.initialize();
    ctx = { stateDir, eventStore: store, enableTelemetry: false };
    repo = await initRepo(path.join(workdir, 'repo'));
    base = await addBaseWorktree(repo, workdir);
  });

  afterEach(async () => {
    store.close();
    await rmrfAsync(stateDir);
    await rmrfAsync(workdir);
  });

  /** Create a REAL launcher worktree on disk (reserved), returning its ids. */
  async function makeRealWorktree(
    id: string,
    branch: string,
  ): Promise<{ worktreeId: string; worktreePath: string }> {
    const created = await createLauncherWorktree(
      store,
      { baseWorktree: base, id, featureId: null, newBranch: branch, repoRoot: repo },
      { selfPid: process.pid, selfStartedAt: 'crashed-owner-fingerprint' },
    );
    if (!created.ok) throw new Error(`worktree setup failed: ${created.reason}`);
    return { worktreeId: created.worktreeId, worktreePath: created.worktreePath };
  }

  function makeParams(seg: string): ResolvedLaunch {
    return {
      harness: 'claude-code',
      runtimeId: 'claude',
      feature: null,
      base,
      worktreeId: seg,
      worktreePath: deriveWorktreePath(base, seg),
    } satisfies ResolvedLaunch;
  }

  it('Teardown_NeverResetHard_PreservesUncommitted', async () => {
    const { worktreeId, worktreePath } = await makeRealWorktree(
      'exarchos-preserve',
      'launch-preserve',
    );
    // Uncommitted work in the launch worktree — must survive teardown.
    const dirty = path.join(worktreePath, 'UNCOMMITTED.txt');
    writeFileSync(dirty, 'work in progress — never discard\n');

    const gitRec = recordingGit();
    const outcome = await teardownLaunch(
      { eventStore: store, worktreeId, worktreePath, exitCode: 0 },
      {
        gitRunner: gitRec.runner,
        processTableSource: fakeTable([]), // nobody occupies it → releasable.
        selfPid: process.pid,
        owner: { ownerPid: process.pid, ownerStartedAt: 'crashed-owner-fingerprint' },
      },
    );

    // A clean release, and the guaranteed terminal was written.
    expect(outcome.released).toBe(true);
    expect(outcome.recoveryError).toBeUndefined();
    expect(outcome.originError).toBeUndefined();
    expect(terminalsFor(store, worktreeId)).toHaveLength(1);
    // Teardown ran NO `git reset --hard` (the data-loss command it forbids)...
    expect(noResetHard(gitRec.calls)).toBe(true);
    expect(gitRec.calls.some((a) => a[0] === 'reset')).toBe(false);
    // ...and the uncommitted file is still on disk (event-only release).
    expect(existsSync(dirty)).toBe(true);
  }, 20_000);

  it('Teardown_UncleanRelease_RecoveryError', async () => {
    const { worktreeId, worktreePath } = await makeRealWorktree(
      'exarchos-unclean',
      'launch-unclean',
    );
    // The WLM refuses to free the reservation (a different live owner holds it) —
    // reuse its release discriminator, surfaced as the INV-14 `recoveryError`.
    const release = fakeRelease({ released: false, rejectedForeignOwner: true });
    const gitRec = recordingGit();

    const outcome = await teardownLaunch(
      { eventStore: store, worktreeId, worktreePath, exitCode: 0 },
      {
        release: release.fn,
        gitRunner: gitRec.runner,
        processTableSource: fakeTable([]),
        selfPid: process.pid,
      },
    );

    expect(outcome.released).toBe(false);
    expect(outcome.recoveryError).toBe('release-rejected-foreign-owner');
    expect(outcome.recoveryErrorDetail).toBeTruthy();
    // Terminal still rides an unclean-release path...
    expect(outcome.terminalAppended).toBe(true);
    expect(terminalsFor(store, worktreeId)).toHaveLength(1);
    // ...and NOTHING destructive ran — work is preserved on disk.
    expect(noResetHard(gitRec.calls)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
  }, 20_000);

  it('Teardown_EveryCatchablePath_EmitsLaunchExecuted', async () => {
    const release = fakeRelease({ released: true, rejectedForeignOwner: false });

    // (a) Direct teardown, normal exit — THIS call writes the terminal.
    const directGit = scriptedGit((args) =>
      args[0] === 'rev-parse' ? { status: 0, stdout: 'true' } : { status: 1 },
    );
    const direct = await teardownLaunch(
      { eventStore: store, worktreeId: 'wt-direct', worktreePath: '/does/not/matter', exitCode: 0 },
      { release: release.fn, gitRunner: directGit.runner, processTableSource: fakeTable([]) },
    );
    expect(direct.terminalAppended).toBe(true);
    expect(terminalsFor(store, 'wt-direct')).toHaveLength(1);

    // (b) Normal-exit path THROUGH runLifecycle, teardown injected.
    const normalWt = canonicalWorktreeId(deriveWorktreePath(base, 'exarchos-catch-n'));
    const rNormal = await runLifecycle(makeParams('exarchos-catch-n'), {
      ctx,
      spawnChild: makeFakeSpawn({ code: 0, signal: null }),
      teardown: makeLifecycleTeardown({
        release: release.fn,
        processTableSource: fakeTable([]),
        selfPid: process.pid,
      }),
      newBranch: 'launch-catch-n',
      repoRoot: repo,
      ...HOLDER,
    });
    expect(rNormal.success).toBe(true);
    expect(terminalsFor(store, normalWt)).toHaveLength(1);

    // (c) Spawn-never-started path THROUGH runLifecycle — teardown still fires.
    const failWt = canonicalWorktreeId(deriveWorktreePath(base, 'exarchos-catch-f'));
    const rFail = await runLifecycle(makeParams('exarchos-catch-f'), {
      ctx,
      spawnChild: throwingSpawn,
      teardown: makeLifecycleTeardown({
        release: release.fn,
        processTableSource: fakeTable([]),
        selfPid: process.pid,
      }),
      newBranch: 'launch-catch-f',
      repoRoot: repo,
      ...HOLDER,
    });
    expect(rFail.success).toBe(false);
    expect(terminalsFor(store, failWt)).toHaveLength(1);

    // (d) Idempotent: a signal path (Task 011) already fired the terminal —
    //     teardown observes it and appends NOTHING (still exactly one row).
    await emitLaunchExecuted(store, { worktreeId: 'wt-idem', exitCode: 0 });
    const idem = await teardownLaunch(
      { eventStore: store, worktreeId: 'wt-idem', worktreePath: '/does/not/matter', exitCode: 0 },
      { release: release.fn, gitRunner: directGit.runner, processTableSource: fakeTable([]) },
    );
    expect(idem.terminalAppended).toBe(false);
    expect(terminalsFor(store, 'wt-idem')).toHaveLength(1);
  }, 30_000);

  it('Recovery_CrashMidSpawn_NoOrphanWorktree', async () => {
    const gitRec = recordingGit();
    const DEAD_PID = 4242424; // a provably-absent (crashed) launcher PID.
    const seg = 'exarchos-crash';
    const worktreePath = deriveWorktreePath(base, seg);
    const worktreeId = canonicalWorktreeId(worktreePath);
    const op = 'crash-op-1';

    // The manager the crash + recovery share: a SUPPORTED fake process table
    // whose only live process is self (cwd OUTSIDE the worktree), so the crashed
    // launcher's DEAD_PID reservation reads as provably dead.
    const selfRec: ProcessRecord = {
      pid: process.pid,
      ppid: 1,
      cwd: repo,
      startTime: 'self',
    };
    const mgr = new WorktreeManager({
      eventStore: store,
      gitRunner: gitRec.runner,
      processTableSource: fakeTable([selfRec]),
    });

    // ── Simulate the crash mid-spawn ──────────────────────────────────────────
    // reserve-FIRST records ownership BEFORE the worktree exists on disk.
    await mgr.reserve({
      worktreeId,
      path: worktreePath,
      featureId: null,
      ownerPid: DEAD_PID,
      ownerStartedAt: 'crashed',
    });
    // The worktree is created on disk...
    git(repo, ['worktree', 'add', worktreePath, '-b', 'crashed-launch']);
    // ...but the launcher crashed BEFORE emitting the INV-13 create terminal
    // (a dangling `worktree.create.requested`) and before any launch event.
    await store.append(
      WORKTREES_STREAM,
      { type: CREATE_REQUESTED, data: { operationId: op, worktreePath, worktreeId } },
      { idempotencyKey: `${CREATE_REQUESTED}:${op}` },
    );

    // The half-created worktree is TRACKED (reserved) — it never escaped GC's
    // view even mid-crash (reserve-first), so it is NOT a silent on-disk orphan.
    const before = (await mgr.list()).find((e) => e.worktreeId === worktreeId);
    expect(before?.state).toBe('reserved');

    // ── Recover ───────────────────────────────────────────────────────────────
    const result = await recoverCrashedLaunch(store, repo, {
      manager: mgr,
      gitRunner: gitRec.runner,
      selfPid: process.pid,
    });

    // DR-2 precheck finished the half-created worktree: the create pair is 1:1.
    expect(result.recoveredCreations).toHaveLength(1);
    expect(result.recoveredCreations[0].operationId).toBe(op);
    expect(
      worktreeEvents(store).some(
        (e) => e.type === CREATE_EXECUTED && e.data?.operationId === op,
      ),
    ).toBe(true);

    // The dead-owner reservation was reclaimed → the entry is now `released`.
    expect(result.reclaimed).toContain(worktreeId);
    const after = (await mgr.list()).find((e) => e.worktreeId === worktreeId);
    expect(after?.state).toBe('released');

    // GC now SEES it as a candidate — no orphan escapes the pruner...
    const pruneReport = await mgr.prune({ repoRoot: repo });
    expect(pruneReport.candidates.some((c) => c.worktreeId === worktreeId)).toBe(true);
    // ...and recovery preserved the worktree (no reset --hard, still on disk).
    expect(noResetHard(gitRec.calls)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
  }, 30_000);

  it('Recovery_CwdDriftSelfAncestry_Excluded', async () => {
    const { worktreeId, worktreePath } = await makeRealWorktree(
      'exarchos-cwddrift',
      'launch-cwddrift',
    );
    const gitRec = recordingGit();

    // (A) The launcher's OWN process drifted its cwd INTO the worktree. Because
    //     self-ancestry is subtracted, this must NOT count as in-use → release.
    const selfDrift: ProcessRecord = {
      pid: process.pid,
      ppid: 1,
      cwd: worktreePath,
      startTime: 'self',
    };
    const releaseA = fakeRelease({ released: true, rejectedForeignOwner: false });
    const outcomeA = await teardownLaunch(
      { eventStore: store, worktreeId, worktreePath, exitCode: 0 },
      {
        release: releaseA.fn,
        gitRunner: gitRec.runner,
        processTableSource: fakeTable([selfDrift]),
        selfPid: process.pid,
      },
    );
    expect(outcomeA.recoveryError).toBeUndefined();
    expect(outcomeA.released).toBe(true);
    expect(releaseA.calls).toHaveLength(1); // release actually attempted.

    // (B) Contrast: a live NON-ancestry process rooted in the worktree DOES hold
    //     it — teardown refuses to free it and never attempts the release.
    const foreign: ProcessRecord = {
      pid: 555555,
      ppid: 1,
      cwd: worktreePath,
      startTime: 'foreign',
    };
    const releaseB = fakeRelease({ released: true, rejectedForeignOwner: false });
    const outcomeB = await teardownLaunch(
      { eventStore: store, worktreeId, worktreePath, exitCode: 0 },
      {
        release: releaseB.fn,
        gitRunner: gitRec.runner,
        processTableSource: fakeTable([foreign]),
        selfPid: process.pid,
      },
    );
    expect(outcomeB.recoveryError).toBe('worktree-in-use');
    expect(outcomeB.released).toBe(false);
    expect(outcomeB.occupantPids).toContain(555555);
    expect(releaseB.calls).toHaveLength(0); // never freed a live-occupied worktree.
  }, 20_000);

  it('Recovery_OriginUnreachable_FailsClosed', async () => {
    const release = fakeRelease({ released: true, rejectedForeignOwner: false });

    // (A) Non-git target: `git rev-parse` fails → fail closed, no reclaim.
    const nonGit = scriptedGit(() => ({ status: 128 }));
    const outcomeA = await teardownLaunch(
      { eventStore: store, worktreeId: 'wt-nongit', worktreePath: '/not/a/repo', exitCode: 0 },
      { release: release.fn, gitRunner: nonGit.runner, processTableSource: fakeTable([]) },
    );
    expect(outcomeA.originError).toBe('non-git-target');
    expect(outcomeA.released).toBe(false);
    // The guaranteed terminal STILL rode this catchable path...
    expect(terminalsFor(store, 'wt-nongit')).toHaveLength(1);
    // ...but nothing destructive ran and the release was never attempted.
    expect(noDestructiveGit(nonGit.calls)).toBe(true);
    expect(release.calls).toHaveLength(0);

    // (B) Origin configured but UNREACHABLE. The reachability check rides the
    // async, NON-BLOCKING `originReachable` seam (never a blocking sync `ls-remote`
    // on the teardown event loop) — injected here to resolve `false` deterministically.
    const unreachable = scriptedGit((args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'true' };
      if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'git@x:y.git' };
      return { status: 0 };
    });
    const outcomeB = await teardownLaunch(
      { eventStore: store, worktreeId: 'wt-origin', worktreePath: '/some/worktree', exitCode: 0 },
      {
        release: release.fn,
        gitRunner: unreachable.runner,
        originReachable: async () => false,
        processTableSource: fakeTable([]),
      },
    );
    expect(outcomeB.originError).toBe('origin-unreachable');
    expect(outcomeB.released).toBe(false);
    expect(terminalsFor(store, 'wt-origin')).toHaveLength(1);
    expect(noDestructiveGit(unreachable.calls)).toBe(true);
    // The sync runner NEVER ran the network `ls-remote` — that is the async seam's job.
    expect(unreachable.calls.some((a) => a[0] === 'ls-remote')).toBe(false);
    expect(release.calls).toHaveLength(0);
  }, 20_000);

  // ── Teardown_OriginProbe_NonBlocking (#1635, DR-6) ────────────────────────────
  //
  // The origin-reachability probe is the one NETWORK round-trip in the fail-closed
  // gate. It MUST run through the async, non-blocking seam so a slow/hanging origin
  // never freezes the launcher's teardown event loop (its signal handling +
  // terminal emission). A controllable deferred `originReachable` proves teardown
  // YIELDS to the loop — it stays pending while the probe is in flight, and only
  // completes once the async probe resolves. A regression to a blocking sync
  // `ls-remote` would settle the gate synchronously (the injected sync runner even
  // reports REACHABLE), so teardown would already be settled by the next macrotask.
  it('Teardown_OriginProbe_NonBlocking', async () => {
    const release = fakeRelease({ released: true, rejectedForeignOwner: false });
    // rev-parse ok + origin CONFIGURED; a sync `ls-remote` (the blocking path this
    // fix removes) would report status 0 = REACHABLE and skip the async seam.
    const gitRec = scriptedGit((args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'true' };
      if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'git@x:y.git' };
      return { status: 0 };
    });

    // A deferred async origin probe: it records that it STARTED and hands back a
    // promise the test resolves on demand — so teardown must await the event loop.
    let resolveProbe!: (reachable: boolean) => void;
    let probeStarted = false;
    const originReachable = (): Promise<boolean> => {
      probeStarted = true;
      return new Promise<boolean>((r) => {
        resolveProbe = r;
      });
    };

    const pending = teardownLaunch(
      { eventStore: store, worktreeId: 'wt-nonblock', worktreePath: '/some/worktree', exitCode: 0 },
      {
        release: release.fn,
        gitRunner: gitRec.runner,
        originReachable,
        processTableSource: fakeTable([]),
        selfPid: process.pid,
      },
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Yield the event loop until the async origin probe STARTS *or* teardown
    // settles — whichever first, bounded only by this test's own timeout, never
    // a fixed tick budget. The guaranteed-terminal emit that precedes the origin
    // gate is itself async (a real SQLite append); under a loaded CI runner that
    // append can take more ticks than any fixed cap, which is exactly what made
    // the old `for (i < 200)` budget flake. A blocking sync `ls-remote` (the
    // reverted path) would settle `pending` WITHOUT ever starting the probe, so
    // the `probeStarted` assertion below still catches that regression.
    while (!probeStarted && !settled) {
      await new Promise((r) => setImmediate(r));
    }
    // The probe is in flight and unresolved → teardown YIELDED to the loop (the
    // network round-trip never blocked it), so it has NOT settled.
    expect(probeStarted).toBe(true);
    expect(settled).toBe(false);

    // Resolve the async probe (origin reachable) → teardown runs through to release.
    resolveProbe(true);
    const outcome = await pending;
    expect(outcome.originError).toBeUndefined();
    expect(outcome.released).toBe(true);
    expect(terminalsFor(store, 'wt-nonblock')).toHaveLength(1);
  }, 20_000);

  // ── DefaultOriginReachable_HungRemote_FailsClosedOnTimeout ──────────────────
  //
  // The default probe spawns `git ls-remote origin`; an unreachable/hung remote
  // may never emit `close`, so WITHOUT a bound the promise stays pending forever
  // and teardownLaunch (which awaits it) wedges on shutdown. Assert the bound:
  // once ORIGIN_PROBE_TIMEOUT_MS elapses, the stalled child is SIGTERM'd and the
  // verdict fails CLOSED (`false` → origin-unreachable), never a silent hang.
  it('DefaultOriginReachable_HungRemote_FailsClosedOnTimeout', async () => {
    vi.useFakeTimers();
    try {
      let killSignal: NodeJS.Signals | number | undefined;
      // A child that NEVER emits `close`/`error` — models a hung `ls-remote`.
      const hungChild = {
        on() {
          return this;
        },
        kill(sig?: NodeJS.Signals | number) {
          killSignal = sig;
          return true;
        },
      };
      const spawnFn = (() => hungChild) as unknown as typeof import('node:child_process').spawn;

      const probe = defaultOriginReachable('/some/worktree', {
        spawnFn,
        timeoutMs: ORIGIN_PROBE_TIMEOUT_MS,
      });
      // Nothing settles until the bound elapses …
      await vi.advanceTimersByTimeAsync(ORIGIN_PROBE_TIMEOUT_MS);
      // … then the stalled probe is reaped and the verdict fails closed.
      await expect(probe).resolves.toBe(false);
      expect(killSignal).toBe('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Teardown_ChildExitsDuringSignalPath_ReservationReleasedNotLingering (#1634) ─
  //
  // DR-6 signal-path race: on a trapped SIGINT/SIGTERM the launcher forwards the
  // signal, reaps the child, and tears down. Teardown's occupancy probe must run
  // AFTER the child is reaped — otherwise the still-exiting child is counted as
  // occupying its OWN reserved worktree, teardown refuses the release
  // ('worktree-in-use'), and the reservation LINGERS until the next GC. This wires
  // the REAL installSignalHandlers + REAL teardownLaunch over a REAL reserved
  // worktree and asserts the reservation is RELEASED promptly on the signal path.
  it('Teardown_ChildExitsDuringSignalPath_ReservationReleasedNotLingering', async () => {
    const { worktreeId, worktreePath } = await makeRealWorktree(
      'exarchos-signalrace',
      'launch-signalrace',
    );

    // Ground-truth process table: the spawned CHILD occupies its reserved worktree
    // (cwd inside it, a live NON-ancestry PID) UNTIL it is reaped. The reap
    // (reapWithEscalation) is the sole reader of `child.exit`, so reading it models
    // the OS collecting the child — after which it no longer occupies the worktree.
    const CHILD_PID = 987654;
    let childReaped = false;
    const childRecord: ProcessRecord = {
      pid: CHILD_PID,
      ppid: process.pid,
      cwd: worktreePath,
      startTime: 'signal-child',
    };
    const table: ProcessTableSource = {
      list: () => (childReaped ? [] : [childRecord]),
      isSupported: () => true,
    };
    const exitPromise = Promise.resolve<SpawnExit>({ code: null, signal: 'SIGTERM' });
    const child: SignalChild = {
      kill: () => true,
      get exit() {
        childReaped = true; // the reap collects the child → its worktree is freed.
        return exitPromise;
      },
    };

    // The signal path's teardown is the REAL teardownLaunch with the default WLM
    // release (event-only) over the SAME reserved owner, so a clean release
    // actually transitions the reservation to `released`. Its outcome is captured
    // (installSignalHandlers discards it, exactly as makeLifecycleTeardown does).
    const gitRec = recordingGit();
    let outcome: TeardownOutcome | undefined;
    const teardown = async (): Promise<void> => {
      outcome = await teardownLaunch(
        { eventStore: store, worktreeId, worktreePath, exitCode: null },
        {
          gitRunner: gitRec.runner,
          processTableSource: table,
          selfPid: process.pid,
          owner: { ownerPid: process.pid, ownerStartedAt: 'crashed-owner-fingerprint' },
        },
      );
    };

    const registrar = makeFakeRegistrar();
    installSignalHandlers({
      child,
      teardown,
      emitTerminal: () => emitLaunchExecuted(store, { worktreeId, exitCode: null }),
      signals: registrar.registrar,
    });

    // The operator interrupts the launcher (Ctrl-C / kill) mid-launch.
    await registrar.fire('SIGTERM');

    // Teardown ran AFTER the reap, so its occupancy probe saw the child gone and
    // the reservation was RELEASED — not withheld as 'worktree-in-use'.
    expect(outcome?.released).toBe(true);
    expect(outcome?.recoveryError).toBeUndefined();
    // Ground truth in the WLM ledger: the reservation actually transitioned to
    // `released` — it does NOT linger `reserved` for the next GC to reap.
    const entry = (await new WorktreeManager({ eventStore: store }).list()).find(
      (e) => e.worktreeId === worktreeId,
    );
    expect(entry?.state).toBe('released');
    // The guaranteed terminal still rode the signal path exactly once...
    expect(terminalsFor(store, worktreeId)).toHaveLength(1);
    // ...and nothing destructive ran (event-only release; work preserved on disk).
    expect(noResetHard(gitRec.calls)).toBe(true);
  }, 20_000);
});

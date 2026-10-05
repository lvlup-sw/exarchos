/**
 * Tests for launcher teardown safety and crash recovery.
 *
 * Each test uses a real `EventStore`, and a real git repo where teardown probes a git target.
 * The tests inject the release, process-table and git seams, so each outcome is deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  defaultGitRunner,
  type GitRunner,
  type ReleaseResult,
  type ReservationOwner,
} from '../../../../src/verbs/worktree/manager.js';
import { canonicalWorktreeId } from '../../../../src/verbs/worktree/pure/path-containment.js';
import type {
  ProcessRecord,
  ProcessTableSource,
} from '../../../../src/verbs/worktree/pure/probe.js';
import type {
  AsyncSpawnRequest,
  ChildHandle,
  SpawnExit,
} from '../../../../src/utils/process.js';
import { emitLaunchExecuted, LAUNCH_EXECUTED } from '../../../../src/runtime/launcher/liveness.js';
import { deriveWorktreePath } from '../../../../src/runtime/launcher/topology.js';
import {
  createLauncherWorktree,
  CREATE_REQUESTED,
  CREATE_EXECUTED,
} from '../../../../src/runtime/launcher/create-worktree.js';
import { runLifecycle, type SpawnHarnessChildFn } from '../../../../src/runtime/launcher/lifecycle-core.js';
import type { ResolvedLaunch } from '../../../../src/runtime/launcher/verb.js';
import {
  teardownLaunch,
  makeLifecycleTeardown,
  recoverCrashedLaunch,
  defaultOriginReachable,
  ORIGIN_PROBE_TIMEOUT_MS,
  type TeardownOutcome,
} from '../../../../src/runtime/launcher/teardown.js';
import {
  installSignalHandlers,
  type SignalChild,
  type SignalListener,
  type SignalRegistrar,
  type TrappedSignal,
} from '../../../../src/runtime/launcher/signals.js';

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'work']);
  await git(dir, ['config', 'user.email', 'teardown@example.com']);
  await git(dir, ['config', 'user.name', 'Teardown Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# launcher teardown test\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  await git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
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

/** A git runner that records each arg vector and delegates to real git. */
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

/** A git runner that runs no git. `route` gives the result for each arg vector. */
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

/** A release seam that records each call and returns `result`. */
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

/** A supported process table over fixed records. */
function fakeTable(records: ProcessRecord[]): ProcessTableSource {
  return { list: () => records, isSupported: () => true };
}

/** Tells if no recorded git call is a `reset --hard`. */
function noResetHard(calls: string[][]): boolean {
  return !calls.some((a) => a[0] === 'reset' && a.includes('--hard'));
}

/** Tells if no recorded git call is a `reset` or a `worktree remove`. */
function noDestructiveGit(calls: string[][]): boolean {
  return !calls.some(
    (a) => a[0] === 'reset' || (a[0] === 'worktree' && a[1] === 'remove'),
  );
}

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

/** A spawn primitive that rejects, for the path where the child never starts. */
const throwingSpawn: SpawnHarnessChildFn = async () => {
  throw new Error('spawn failed to start');
};

const HOLDER = {
  holderPid: process.pid,
  holderStartedAt: 'teardown-boot-fingerprint',
} as const;

/**
 * A `SignalRegistrar` that holds listeners in memory, so no real signal reaches the test runner.
 * `fire` waits for each listener, so the trap body is settled before the test asserts.
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

/** `makeRealWorktree` creates a reserved launcher worktree on disk and returns its id and path. */
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

  /**
   * The worktree holds an uncommitted file, and the process table is empty, so teardown can release.
   * Teardown releases cleanly, writes one terminal, runs no `git reset` and leaves the file on disk.
   */
  it('Teardown_NeverResetHard_PreservesUncommitted', async () => {
    const { worktreeId, worktreePath } = await makeRealWorktree(
      'exarchos-preserve',
      'launch-preserve',
    );
    const dirty = path.join(worktreePath, 'UNCOMMITTED.txt');
    writeFileSync(dirty, 'work in progress — never discard\n');

    const gitRec = recordingGit();
    const outcome = await teardownLaunch(
      { eventStore: store, worktreeId, worktreePath, exitCode: 0 },
      {
        gitRunner: gitRec.runner,
        processTableSource: fakeTable([]),
        selfPid: process.pid,
        owner: { ownerPid: process.pid, ownerStartedAt: 'crashed-owner-fingerprint' },
      },
    );

    expect(outcome.released).toBe(true);
    expect(outcome.recoveryError).toBeUndefined();
    expect(outcome.originError).toBeUndefined();
    expect(terminalsFor(store, worktreeId)).toHaveLength(1);
    expect(noResetHard(gitRec.calls)).toBe(true);
    expect(gitRec.calls.some((a) => a[0] === 'reset')).toBe(false);
    expect(existsSync(dirty)).toBe(true);
  }, 20_000);

  /**
   * The release seam refuses, as the manager does when a different live owner holds the reservation.
   * The outcome carries `release-rejected-foreign-owner`. Teardown still writes the terminal and runs no `git reset --hard`.
   */
  it('Teardown_UncleanRelease_RecoveryError', async () => {
    const { worktreeId, worktreePath } = await makeRealWorktree(
      'exarchos-unclean',
      'launch-unclean',
    );
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
    expect(outcome.terminalAppended).toBe(true);
    expect(terminalsFor(store, worktreeId)).toHaveLength(1);
    expect(noResetHard(gitRec.calls)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
  }, 20_000);

  /**
   * Four paths each end with one terminal:
   *  - A direct teardown after a normal exit.
   *  - A normal exit through `runLifecycle`.
   *  - A spawn that never starts, through `runLifecycle`.
   *  - A teardown after a different path wrote the terminal. This teardown appends nothing.
   */
  it('Teardown_EveryCatchablePath_EmitsLaunchExecuted', async () => {
    const release = fakeRelease({ released: true, rejectedForeignOwner: false });

    const directGit = scriptedGit((args) =>
      args[0] === 'rev-parse' ? { status: 0, stdout: 'true' } : { status: 1 },
    );
    const direct = await teardownLaunch(
      { eventStore: store, worktreeId: 'wt-direct', worktreePath: '/does/not/matter', exitCode: 0 },
      { release: release.fn, gitRunner: directGit.runner, processTableSource: fakeTable([]) },
    );
    expect(direct.terminalAppended).toBe(true);
    expect(terminalsFor(store, 'wt-direct')).toHaveLength(1);

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

    await emitLaunchExecuted(store, { worktreeId: 'wt-idem', exitCode: 0 });
    const idem = await teardownLaunch(
      { eventStore: store, worktreeId: 'wt-idem', worktreePath: '/does/not/matter', exitCode: 0 },
      { release: release.fn, gitRunner: directGit.runner, processTableSource: fakeTable([]) },
    );
    expect(idem.terminalAppended).toBe(false);
    expect(terminalsFor(store, 'wt-idem')).toHaveLength(1);
  }, 30_000);

  /**
   * Simulates a crash during spawn: a reservation by a dead PID, a worktree on disk, and a
   * `worktree.create.requested` with no paired terminal. The process table holds only this process, outside the worktree.
   * The entry is `reserved` before recovery. Recovery writes the create terminal and releases the reservation.
   * Then `prune` lists the worktree as a candidate. Recovery runs no `git reset --hard`, and the worktree stays on disk.
   */
  it('Recovery_CrashMidSpawn_NoOrphanWorktree', async () => {
    const gitRec = recordingGit();
    const DEAD_PID = 4242424;
    const seg = 'exarchos-crash';
    const worktreePath = deriveWorktreePath(base, seg);
    const worktreeId = canonicalWorktreeId(worktreePath);
    const op = 'crash-op-1';

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

    await mgr.reserve({
      worktreeId,
      path: worktreePath,
      featureId: null,
      ownerPid: DEAD_PID,
      ownerStartedAt: 'crashed',
    });
    await git(repo, ['worktree', 'add', worktreePath, '-b', 'crashed-launch']);
    await store.append(
      WORKTREES_STREAM,
      { type: CREATE_REQUESTED, data: { operationId: op, worktreePath, worktreeId } },
      { idempotencyKey: `${CREATE_REQUESTED}:${op}` },
    );

    const before = (await mgr.list()).find((e) => e.worktreeId === worktreeId);
    expect(before?.state).toBe('reserved');

    const result = await recoverCrashedLaunch(store, repo, {
      manager: mgr,
      gitRunner: gitRec.runner,
      selfPid: process.pid,
    });

    expect(result.recoveredCreations).toHaveLength(1);
    expect(result.recoveredCreations[0].operationId).toBe(op);
    expect(
      worktreeEvents(store).some(
        (e) => e.type === CREATE_EXECUTED && e.data?.operationId === op,
      ),
    ).toBe(true);

    expect(result.reclaimed).toContain(worktreeId);
    const after = (await mgr.list()).find((e) => e.worktreeId === worktreeId);
    expect(after?.state).toBe('released');

    const pruneReport = await mgr.prune({ repoRoot: repo });
    expect(pruneReport.candidates.some((c) => c.worktreeId === worktreeId)).toBe(true);
    expect(noResetHard(gitRec.calls)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);
  }, 30_000);

  /**
   * When the launcher process has its cwd in the worktree, teardown does not count it as an occupant and releases.
   * When a different live process has its cwd there, teardown reports `worktree-in-use` and does not call the release.
   */
  it('Recovery_CwdDriftSelfAncestry_Excluded', async () => {
    const { worktreeId, worktreePath } = await makeRealWorktree(
      'exarchos-cwddrift',
      'launch-cwddrift',
    );
    const gitRec = recordingGit();

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
    expect(releaseA.calls).toHaveLength(1);

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
    expect(releaseB.calls).toHaveLength(0);
  }, 20_000);

  /**
   * Teardown fails closed on a target where `git rev-parse` fails, and on a configured `origin` that the probe reports unreachable.
   * Each case still writes the terminal, runs no destructive git and does not call the release.
   * The sync git runner never runs `ls-remote`, because the async `originReachable` seam does the network check.
   */
  it('Recovery_OriginUnreachable_FailsClosed', async () => {
    const release = fakeRelease({ released: true, rejectedForeignOwner: false });

    const nonGit = scriptedGit(() => ({ status: 128 }));
    const outcomeA = await teardownLaunch(
      { eventStore: store, worktreeId: 'wt-nongit', worktreePath: '/not/a/repo', exitCode: 0 },
      { release: release.fn, gitRunner: nonGit.runner, processTableSource: fakeTable([]) },
    );
    expect(outcomeA.originError).toBe('non-git-target');
    expect(outcomeA.released).toBe(false);
    expect(terminalsFor(store, 'wt-nongit')).toHaveLength(1);
    expect(noDestructiveGit(nonGit.calls)).toBe(true);
    expect(release.calls).toHaveLength(0);

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
    expect(unreachable.calls.some((a) => a[0] === 'ls-remote')).toBe(false);
    expect(release.calls).toHaveLength(0);
  }, 20_000);

  /**
   * The injected origin probe returns a promise that the test resolves later.
   * Teardown stays pending while the probe is in flight, and releases after the probe resolves `true`.
   * The wait loop has no tick limit, because the terminal append before the origin gate is a real SQLite write.
   * A sync `ls-remote` in teardown settles the call with no probe start, and then the `probeStarted` assertion fails.
   */
  it('Teardown_OriginProbe_NonBlocking', async () => {
    const release = fakeRelease({ released: true, rejectedForeignOwner: false });
    const gitRec = scriptedGit((args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'true' };
      if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'git@x:y.git' };
      return { status: 0 };
    });

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

    while (!probeStarted && !settled) {
      await new Promise((r) => setImmediate(r));
    }
    expect(probeStarted).toBe(true);
    expect(settled).toBe(false);

    resolveProbe(true);
    const outcome = await pending;
    expect(outcome.originError).toBeUndefined();
    expect(outcome.released).toBe(true);
    expect(terminalsFor(store, 'wt-nonblock')).toHaveLength(1);
  }, 20_000);

  /**
   * The fake child never emits `close` or `error`, as a hung `git ls-remote` does.
   * After `ORIGIN_PROBE_TIMEOUT_MS`, the default probe sends `SIGTERM` to the child and resolves `false`.
   */
  it('DefaultOriginReachable_HungRemote_FailsClosedOnTimeout', async () => {
    vi.useFakeTimers();
    try {
      let killSignal: NodeJS.Signals | number | undefined;
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
      await vi.advanceTimersByTimeAsync(ORIGIN_PROBE_TIMEOUT_MS);
      await expect(probe).resolves.toBe(false);
      expect(killSignal).toBe('SIGTERM');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Runs the real `installSignalHandlers` and the real `teardownLaunch` on a reserved worktree.
   * The process table lists the child in the worktree until a caller reads `child.exit`, and only the reap reads it.
   * Thus the release succeeds only when teardown runs after the reap.
   * The entry becomes `released`, one terminal persists, and no `git reset --hard` runs.
   */
  it('Teardown_ChildExitsDuringSignalPath_ReservationReleasedNotLingering', async () => {
    const { worktreeId, worktreePath } = await makeRealWorktree(
      'exarchos-signalrace',
      'launch-signalrace',
    );

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
        childReaped = true;
        return exitPromise;
      },
    };

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

    await registrar.fire('SIGTERM');

    expect(outcome?.released).toBe(true);
    expect(outcome?.recoveryError).toBeUndefined();
    const entry = (await new WorktreeManager({ eventStore: store }).list()).find(
      (e) => e.worktreeId === worktreeId,
    );
    expect(entry?.state).toBe('released');
    expect(terminalsFor(store, worktreeId)).toHaveLength(1);
    expect(noResetHard(gitRec.calls)).toBe(true);
  }, 20_000);
});

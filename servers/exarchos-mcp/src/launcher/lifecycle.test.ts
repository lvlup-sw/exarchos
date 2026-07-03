// ─── Launcher lifecycle orchestration — spawn → place → observe → teardown +
// real verb binding (DR-1 / DR-6)
//
// HIGH-tier integrator suite. Every test drives the REAL EventStore / SQLite
// substrate AND a REAL git repo (per-test tmp dirs), with a CONTROLLABLE fake
// `spawnHarnessChild` injected so no real harness binary is launched and the
// child's exit is deterministic. The contract under test:
//
//   - teardown (and the guaranteed `launch.executed` terminal) runs EXACTLY once
//     even though the core enters the teardown path more than once (normal exit
//     + the defensive `finally`);
//   - after the child exits and teardown completes, NO process / timer / handle
//     outlives it (no repeating timer, no post-exit kill, one child);
//   - the spawned child's cwd is the CREATED worktree path — the place step —
//     never the descriptor's declarative default;
//   - the non-dry-run verb path invokes the real `runLifecycle` and spawns (no
//     longer `NOT_WIRED`).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { DispatchContext } from '../core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../orchestrate/worktree/manager.js';
import type {
  AsyncSpawnRequest,
  ChildHandle,
  SpawnExit,
} from '../utils/process.js';
import {
  LAUNCH_EXECUTED,
  LAUNCH_EXECUTING_STARTED,
} from './liveness.js';
import { deriveWorktreePath } from './topology.js';
import { runLauncherVerb } from './verb.js';
import type { ResolvedLaunch } from './verb.js';
import {
  runLifecycle,
  type LifecycleResultData,
  type LifecycleTeardown,
  type LifecycleSignalContext,
  type InstallSignals,
  type SpawnHarnessChildFn,
} from './lifecycle-core.js';

// ─── git + event-store helpers (mirror create-worktree.test.ts) ───────────────

/** Run `git <args>` from `cwd`, returning trimmed stdout (throws on failure). */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Init a real repo on branch `work` with one commit; returns its canonical path. */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'work']);
  git(dir, ['config', 'user.email', 'lifecycle@example.com']);
  git(dir, ['config', 'user.name', 'Lifecycle Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# launcher lifecycle test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

/** A base sibling worktree the launcher derives siblings off. */
async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync(base);
}

/** Raw persisted events on the `worktrees` stream (sync read backend). */
function worktreeEvents(store: EventStore): WorkflowEvent[] {
  return store.getReadBackend().queryEvents(WORKTREES_STREAM);
}

function eventsOfType(store: EventStore, type: string): WorkflowEvent[] {
  return worktreeEvents(store).filter((e) => e.type === type);
}

// ─── Controllable fake spawn (auto-exits with a fixed outcome) ────────────────

interface FakeSpawn {
  readonly fn: SpawnHarnessChildFn;
  /** Every `AsyncSpawnRequest` the lifecycle handed the spawn primitive. */
  readonly calls: AsyncSpawnRequest[];
  /** Every signal passed to `child.kill` — must stay empty on the normal path. */
  readonly killCalls: (NodeJS.Signals | number | undefined)[];
  /** Whether the child's `exit` promise was observed (the child terminated). */
  hasExited(): boolean;
}

/**
 * A deterministic fake over {@link spawnHarnessChild}: it records the request,
 * hands back a {@link ChildHandle} whose `exit` promise resolves to a fixed
 * outcome (auto-exit), and records any `kill` calls — so the lifecycle's
 * observe→teardown path runs to completion without a real child process.
 */
function makeFakeSpawn(exit: SpawnExit, pid = 44444): FakeSpawn {
  const calls: AsyncSpawnRequest[] = [];
  const killCalls: (NodeJS.Signals | number | undefined)[] = [];
  let exited = false;
  const fn: SpawnHarnessChildFn = async (request) => {
    calls.push(request);
    const exitPromise = Promise.resolve(exit).then((e) => {
      exited = true;
      return e;
    });
    const handle: ChildHandle = {
      pid,
      exit: exitPromise,
      kill: (signal) => {
        killCalls.push(signal);
        return true;
      },
    };
    return handle;
  };
  return { fn, calls, killCalls, hasExited: () => exited };
}

// Explicit, non-empty holder identity so every launch is deterministic + probe-free.
const HOLDER = {
  holderPid: process.pid,
  holderStartedAt: 'lifecycle-boot-fingerprint',
} as const;

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('runLifecycle — launcher lifecycle integrator (real git + real event store)', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;
  let ctx: DispatchContext;
  let repo: string;
  let base: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'launcher-lifecycle-state-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'launcher-lifecycle-work-'));
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

  const WT_SEGMENT = 'exarchos-claude-code';

  /** A resolved launch whose stand-in worktree id is a valid single segment. */
  function makeParams(overrides: Partial<ResolvedLaunch> = {}): ResolvedLaunch {
    return {
      harness: 'claude-code',
      runtimeId: 'claude',
      feature: null,
      base,
      worktreeId: WT_SEGMENT,
      worktreePath: deriveWorktreePath(base, WT_SEGMENT),
      ...overrides,
    };
  }

  it('Lifecycle_TeardownExactlyOnce', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    // A teardown seam that COUNTS its own body invocations while still routing
    // the guaranteed terminal through the idempotent Task-006 emitter.
    let teardownCount = 0;
    const teardown: LifecycleTeardown = async (tctx) => {
      teardownCount += 1;
      await tctx.emitExecuted(tctx.eventStore, {
        worktreeId: tctx.worktreeId,
        exitCode: tctx.exitCode,
      });
    };

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: fake.fn,
      teardown,
      newBranch: 'launch-once',
      repoRoot: repo,
      ...HOLDER,
    });

    expect(result.success).toBe(true);
    // The core enters teardown on BOTH the normal-exit path and the defensive
    // `finally`, but the once-guard collapses them to ONE body invocation.
    expect(teardownCount).toBe(1);
    // And exactly one terminal persisted (idempotent seam backstop), carrying
    // the observed exit code.
    const terminals = eventsOfType(store, LAUNCH_EXECUTED);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].data?.exitCode).toBe(0);
  }, 20_000);

  it('Lifecycle_NoHandleOutlivesChild', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    // A repeating timer is the canonical handle that keeps the event loop alive
    // — the core must create none.
    const intervalSpy = vi.spyOn(global, 'setInterval');
    try {
      const result = await runLifecycle(makeParams(), {
        ctx,
        spawnChild: fake.fn,
        newBranch: 'launch-nohandle',
        repoRoot: repo,
        ...HOLDER,
      });

      expect(result.success).toBe(true);
      // The child was observed to exit...
      expect(fake.hasExited()).toBe(true);
      // ...and NOTHING outlives it: no repeating timer, no lingering supervision
      // that kills / respawns the child post-exit, exactly one child.
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(fake.killCalls).toHaveLength(0);
      expect(fake.calls).toHaveLength(1);
      // The launch is closed — the terminal cleared any in-flight marker.
      expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
    } finally {
      intervalSpy.mockRestore();
    }
  }, 20_000);

  it('Lifecycle_PlacesChildInWorktree_CwdEqualsWorktree', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: fake.fn,
      newBranch: 'launch-place',
      repoRoot: repo,
      ...HOLDER,
    });

    expect(result.success).toBe(true);
    const data = result.data as LifecycleResultData;

    // The spawn was handed exactly one request...
    expect(fake.calls).toHaveLength(1);
    const spawned = fake.calls[0];
    // ...whose cwd is the CREATED worktree path (the place step) — never the
    // descriptor's declarative default ('.').
    expect(spawned.cwd).toBe(data.worktreePath);
    expect(spawned.cwd).not.toBe('.');
    // The placed cwd is a real, on-disk worktree — the derived sibling of base.
    expect(existsSync(spawned.cwd)).toBe(true);
    expect(data.worktreePath).toBe(deriveWorktreePath(base, WT_SEGMENT));

    // The liveness CLAIM was emitted with the SUPERVISOR holderPid (task-016's
    // dead-holder anchor), BEFORE the terminal.
    const claim = eventsOfType(store, LAUNCH_EXECUTING_STARTED);
    expect(claim).toHaveLength(1);
    expect(claim[0].data?.holderPid).toBe(HOLDER.holderPid);
    expect(claim[0].data?.worktreeId).toBe(data.worktreeId);
  }, 20_000);

  it('Lifecycle_InstallsSignals_AfterSpawn_ThenUninstalls', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    // The signal-install seam is invoked with the LIVE child + the guaranteed-
    // once teardown + terminal, and its uninstaller is called once the launch is
    // over — so no signal handler outlives the child (DR-6, R-2).
    let installCtx: LifecycleSignalContext | undefined;
    let uninstalled = 0;
    const installSignals: InstallSignals = (sigCtx) => {
      installCtx = sigCtx;
      return () => {
        uninstalled += 1;
      };
    };

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: fake.fn,
      installSignals,
      newBranch: 'launch-signals',
      repoRoot: repo,
      ...HOLDER,
    });

    expect(result.success).toBe(true);
    // The seam received the live child (with kill + exit) and the two guaranteed
    // seams the DR-6 signal path forwards through.
    expect(installCtx).toBeDefined();
    expect(typeof installCtx?.child.kill).toBe('function');
    expect(typeof installCtx?.teardown).toBe('function');
    expect(typeof installCtx?.emitTerminal).toBe('function');
    // The handlers were uninstalled exactly once after observe/in `finally`.
    expect(uninstalled).toBe(1);
  }, 20_000);

  it('Lifecycle_SpawnFailure_NoSignalsInstalled_StillEmitsTerminal', async () => {
    const failingSpawn: SpawnHarnessChildFn = async () => {
      throw new Error('spawn refused');
    };
    let installed = 0;

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: failingSpawn,
      installSignals: () => {
        installed += 1;
        return () => undefined;
      },
      newBranch: 'launch-spawnfail',
      repoRoot: repo,
      ...HOLDER,
    });

    // Spawn never started → structured failure, and NO signal handler was
    // installed (there is no child to supervise)...
    expect(result.success).toBe(false);
    expect(installed).toBe(0);
    // ...yet the launch was still closed with the guaranteed terminal.
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);

  // ─── post-spawn failure kills + reaps the live child (no orphan) ──────────
  // Regression (CodeRabbit MAJOR, PR #1632): once spawn succeeded, a throw from
  // `installSignals` or a rejection from `await child.exit` sent control to the
  // `finally`, which only uninstalled + tore down — it never killed the live
  // child, leaking an orphan reparented to init. The core now force-kills + reaps
  // the child on that path.

  it('Lifecycle_PostSpawnInstallSignalsThrows_KillsChild_NoOrphan', async () => {
    const killCalls: (NodeJS.Signals | number | undefined)[] = [];
    // A child whose exit does NOT auto-resolve — it settles only when killed, so
    // it is provably "live" until the error path reaps it.
    let resolveExit!: (e: SpawnExit) => void;
    const exit = new Promise<SpawnExit>((res) => {
      resolveExit = res;
    });
    const spawnChild: SpawnHarnessChildFn = async () => ({
      pid: 55555,
      exit,
      kill: (signal) => {
        killCalls.push(signal);
        resolveExit({ code: null, signal: 'SIGKILL' }); // SIGKILL terminates → exit settles.
        return true;
      },
    });

    await expect(
      runLifecycle(makeParams(), {
        ctx,
        spawnChild,
        installSignals: () => {
          throw new Error('install boom');
        },
        newBranch: 'launch-install-throw',
        repoRoot: repo,
        ...HOLDER,
      }),
    ).rejects.toThrow('install boom');

    // The live child was force-killed on the error path — no orphan survives...
    expect(killCalls).toContain('SIGKILL');
    // ...and the launch was still closed with the guaranteed terminal.
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);

  it('Lifecycle_PostSpawnObserveRejects_KillsChild_NoOrphan', async () => {
    const killCalls: (NodeJS.Signals | number | undefined)[] = [];
    const exit = Promise.reject(new Error('observe boom'));
    // Mark handled so the double-await (observe + reap) never trips an unhandled
    // rejection; `await exit` still throws at each use site.
    exit.catch(() => undefined);
    const spawnChild: SpawnHarnessChildFn = async () => ({
      pid: 55556,
      exit,
      kill: (signal) => {
        killCalls.push(signal);
        return true;
      },
    });

    await expect(
      runLifecycle(makeParams(), {
        ctx,
        spawnChild,
        installSignals: () => () => undefined, // no-op so we reach the observe step
        newBranch: 'launch-observe-reject',
        repoRoot: repo,
        ...HOLDER,
      }),
    ).rejects.toThrow('observe boom');

    // A rejected observe still force-kills the (possibly-live) child...
    expect(killCalls).toContain('SIGKILL');
    // ...and the launch closes with the guaranteed terminal.
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);

  it('Verb_NonDryRun_InvokesLifecycleAndSpawns', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    // NO explicit `lifecycle` — the verb must BUILD the real default runner from
    // `lifecycleDeps` and run it (the Task-010 binding).
    const result = await runLauncherVerb(
      { harness: 'claude-code', dryRun: false },
      {
        base,
        lifecycleDeps: {
          ctx,
          spawnChild: fake.fn,
          newBranch: 'launch-verb',
          repoRoot: repo,
          ...HOLDER,
        },
      },
    );

    // No longer NOT_WIRED — the real lifecycle ran end-to-end.
    expect(result.success).toBe(true);
    expect(result.error?.code).not.toBe('NOT_WIRED');
    // It actually spawned exactly one child...
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe('claude');
    // ...into a real, created worktree that now exists on disk...
    const data = result.data as LifecycleResultData;
    expect(existsSync(data.worktreePath)).toBe(true);
    // ...and the launch ran to its guaranteed terminal.
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);
});

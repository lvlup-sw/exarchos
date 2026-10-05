/**
 * Integration tests for `runLifecycle` and for its binding in the launcher verb.
 *
 * Each test uses a real `EventStore` and a real git repo in temp directories.
 * Each test injects a fake `spawnHarnessChild`, so no harness binary starts and the test controls the child exit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { LaunchExecutingStartedData } from '../../../../src/events/schemas.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../../../src/verbs/worktree/manager.js';
import type { ProcessSource } from '../../../../src/verbs/worktree/pure/process-identity.js';
import type {
  AsyncSpawnRequest,
  ChildHandle,
  SpawnExit,
} from '../../../../src/utils/process.js';
import {
  LAUNCH_EXECUTED,
  LAUNCH_EXECUTING_STARTED,
} from '../../../../src/runtime/launcher/liveness.js';
import { deriveWorktreePath } from '../../../../src/runtime/launcher/topology.js';
import { runLauncherVerb } from '../../../../src/runtime/launcher/verb.js';
import type { ResolvedLaunch } from '../../../../src/runtime/launcher/verb.js';
import {
  clearHelpProbeCache,
  runLifecycle,
  type LifecycleResultData,
  type LifecycleTeardown,
  type LifecycleSignalContext,
  type InstallSignals,
  type SpawnHarnessChildFn,
} from '../../../../src/runtime/launcher/lifecycle-core.js';

/** Runs `git <args>` in `cwd` and returns the trimmed stdout. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/**
 * Creates a repo on branch `work` with one commit and returns its canonical path.
 * `realpathSync.native` expands a Windows 8.3 short name, so the path matches the path that the launcher derives.
 */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'work']);
  await git(dir, ['config', 'user.email', 'lifecycle@example.com']);
  await git(dir, ['config', 'user.name', 'Lifecycle Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# launcher lifecycle test\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync.native(dir);
}

/** Adds the base worktree. The launcher derives each sibling worktree path from it. */
async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  await git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync.native(base);
}

/** The persisted events of the `worktrees` stream. */
function worktreeEvents(store: EventStore): WorkflowEvent[] {
  return store.getReadBackend().queryEvents(WORKTREES_STREAM);
}

function eventsOfType(store: EventStore, type: string): WorkflowEvent[] {
  return worktreeEvents(store).filter((e) => e.type === type);
}

interface FakeSpawn {
  readonly fn: SpawnHarnessChildFn;
  /** Each `AsyncSpawnRequest` that the lifecycle passed to the spawn primitive. */
  readonly calls: AsyncSpawnRequest[];
  /** Each signal passed to `child.kill`. It stays empty on the normal path. */
  readonly killCalls: (NodeJS.Signals | number | undefined)[];
  /** Tells if the `exit` promise of the child resolved. */
  hasExited(): boolean;
}

/**
 * A fake spawn primitive. It records each request and returns a `ChildHandle`.
 * The `exit` promise of the handle resolves to `exit`, and the handle records each `kill` call.
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

/**
 * A fixed holder identity, so no launch probes for the supervisor start time.
 * `orientation: { disabled: true }` stops the default channel probe, which runs a real CLI on the host.
 */
const HOLDER = {
  holderPid: process.pid,
  holderStartedAt: 'lifecycle-boot-fingerprint',
  orientation: { disabled: true },
} as const;

/** `makeParams` builds a resolved launch whose worktree id is one valid path segment. */
describe('runLifecycle — launcher lifecycle integrator (real git + real event store)', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;
  let ctx: DispatchContext;
  let repo: string;
  let base: string;

  beforeEach(async () => {
    clearHelpProbeCache();
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

  /**
   * The core calls teardown on the normal exit and again in its `finally` block.
   * The teardown body runs once, and one terminal persists with the exit code.
   */
  it('Lifecycle_TeardownExactlyOnce', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

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
    expect(teardownCount).toBe(1);
    const terminals = eventsOfType(store, LAUNCH_EXECUTED);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].data?.exitCode).toBe(0);
  }, 20_000);

  /**
   * After a normal exit, the core made no `setInterval` call, sent no `kill`, spawned one child and wrote one terminal.
   * The test spies on `setInterval` because a repeating timer keeps the event loop alive after the child exits.
   */
  it('Lifecycle_NoHandleOutlivesChild', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

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
      expect(fake.hasExited()).toBe(true);
      expect(intervalSpy).not.toHaveBeenCalled();
      expect(fake.killCalls).toHaveLength(0);
      expect(fake.calls).toHaveLength(1);
      expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
    } finally {
      intervalSpy.mockRestore();
    }
  }, 20_000);

  /**
   * The spawn request has the created worktree path as its cwd, not the `.` default of the descriptor.
   * The path exists on disk. The liveness claim carries the supervisor `holderPid` and the `worktreeId`.
   */
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

    expect(fake.calls).toHaveLength(1);
    const spawned = fake.calls[0];
    expect(spawned.cwd).toBe(data.worktreePath);
    expect(spawned.cwd).not.toBe('.');
    expect(existsSync(spawned.cwd)).toBe(true);
    expect(data.worktreePath).toBe(deriveWorktreePath(base, WT_SEGMENT));

    const claim = eventsOfType(store, LAUNCH_EXECUTING_STARTED);
    expect(claim).toHaveLength(1);
    expect(claim[0].data?.holderPid).toBe(HOLDER.holderPid);
    expect(claim[0].data?.worktreeId).toBe(data.worktreeId);
  }, 20_000);

  /**
   * The signal-install seam gets the live child, the teardown and the terminal emitter.
   * The core calls the returned uninstaller once, so no signal handler stays after the launch.
   */
  it('Lifecycle_InstallsSignals_AfterSpawn_ThenUninstalls', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

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
    expect(installCtx).toBeDefined();
    expect(typeof installCtx?.child.kill).toBe('function');
    expect(typeof installCtx?.teardown).toBe('function');
    expect(typeof installCtx?.emitTerminal).toBe('function');
    expect(uninstalled).toBe(1);
  }, 20_000);

  /** A spawn that throws gives a failure result. The core installs no signal handler and still writes one terminal. */
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

    expect(result.success).toBe(false);
    expect(installed).toBe(0);
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);

  /**
   * The `exit` promise of this child settles only on `kill`, so the child is live until the error path reaps it.
   * When `installSignals` throws, the core sends `SIGKILL` to the child and still writes one terminal.
   */
  it('Lifecycle_PostSpawnInstallSignalsThrows_KillsChild_NoOrphan', async () => {
    const killCalls: (NodeJS.Signals | number | undefined)[] = [];
    let resolveExit!: (e: SpawnExit) => void;
    const exit = new Promise<SpawnExit>((res) => {
      resolveExit = res;
    });
    const spawnChild: SpawnHarnessChildFn = async () => ({
      pid: 55555,
      exit,
      kill: (signal) => {
        killCalls.push(signal);
        resolveExit({ code: null, signal: 'SIGKILL' });
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

    expect(killCalls).toContain('SIGKILL');
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);

  /**
   * The `exit` promise rejects, and a no-op `installSignals` lets the core reach the observe step.
   * The core sends `SIGKILL` to the child and still writes one terminal.
   * The early `catch` marks the rejection as handled, because the core awaits `exit` in the observe step and in the reap.
   */
  it('Lifecycle_PostSpawnObserveRejects_KillsChild_NoOrphan', async () => {
    const killCalls: (NodeJS.Signals | number | undefined)[] = [];
    const exit = Promise.reject(new Error('observe boom'));
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
        installSignals: () => () => undefined,
        newBranch: 'launch-observe-reject',
        repoRoot: repo,
        ...HOLDER,
      }),
    ).rejects.toThrow('observe boom');

    expect(killCalls).toContain('SIGKILL');
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);

  /**
   * With no `lifecycle` override, the verb builds its runner from `lifecycleDeps` and runs it.
   * The run spawns one `claude` child in a worktree that exists on disk, and writes one terminal.
   */
  it('Verb_NonDryRun_InvokesLifecycleAndSpawns', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

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

    expect(result.success).toBe(true);
    expect(result.error?.code).not.toBe('NOT_WIRED');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe('claude');
    const data = result.data as LifecycleResultData;
    expect(existsSync(data.worktreePath)).toBe(true);
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);

  /**
   * The process source resolves no start time, and the launch passes no `holderStartedAt`.
   * The persisted claim carries `holderStartedAt: null` and a numeric `holderPid`, and it passes `LaunchExecutingStartedData`.
   * The same claim with an empty string fails that schema. Orientation is disabled, so no host probe runs.
   */
  it('LauncherClaim_HolderStartedAt_NonEmptyOrNullPerSchema', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });
    const unresolvable: ProcessSource = { getStartTime: () => ({ status: 'unknown' }) };

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: fake.fn,
      processSource: unresolvable,
      newBranch: 'launch-nullstart',
      repoRoot: repo,
      orientation: { disabled: true },
    });
    expect(result.success).toBe(true);

    const claims = eventsOfType(store, LAUNCH_EXECUTING_STARTED);
    expect(claims).toHaveLength(1);
    const holderStartedAt = claims[0].data?.holderStartedAt;
    expect(holderStartedAt).toBeNull();
    expect(holderStartedAt).not.toBe('');
    expect(typeof claims[0].data?.holderPid).toBe('number');

    expect(() => LaunchExecutingStartedData.parse(claims[0].data)).not.toThrow();
    expect(() =>
      LaunchExecutingStartedData.parse({ ...claims[0].data, holderStartedAt: '' }),
    ).toThrow();
  }, 20_000);

  /**
   * The help text names the file flag of `claude`, so a channel resolves, but the temp-file write throws.
   * The launch still succeeds, and its result records a degradation with channel `none`.
   * The child spawns without the native flag, and one terminal persists.
   */
  it('runLifecycle_InjectionConstructionFails_LaunchProceedsWithDegradationRecorded', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: fake.fn,
      newBranch: 'launch-inject-fail',
      repoRoot: repo,
      ...HOLDER,
      orientation: {
        content: 'ORIENTATION-BLOCK',
        helpProbe: () => 'Usage: claude\n  --append-system-prompt-file FILE',
        applyDeps: {
          writeTempFile: () => {
            throw new Error('disk full: cannot write orientation temp file');
          },
        },
      },
    });

    expect(result.success).toBe(true);
    const data = result.data as LifecycleResultData;
    expect(data.injection.degraded).toBe(true);
    expect(data.injection.channel).toBe('none');
    expect(data.injection.degradation).toContain('construction failed');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].args).not.toContain('--append-system-prompt-file');
    expect(eventsOfType(store, LAUNCH_EXECUTED)).toHaveLength(1);
  }, 20_000);

  /** A resolved file-flag channel puts the flag and the temp-file path in the spawn args, and the content in `EXARCHOS_ORIENTATION`. */
  it('runLifecycle_ChannelResolves_AppliesNativeFlagToSpawnedDescriptor', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: fake.fn,
      newBranch: 'launch-inject-ok',
      repoRoot: repo,
      ...HOLDER,
      orientation: {
        content: 'ORIENTATION-BLOCK',
        helpProbe: () => 'Usage: claude\n  --append-system-prompt-file FILE',
        applyDeps: { writeTempFile: () => '/tmp/orient/orientation.md' },
      },
    });

    expect(result.success).toBe(true);
    const data = result.data as LifecycleResultData;
    expect(data.injection.degraded).toBe(false);
    expect(data.injection.channel).toBe('flag:--append-system-prompt-file');
    expect(fake.calls[0].args).toEqual(['--append-system-prompt-file', '/tmp/orient/orientation.md']);
    expect(fake.calls[0].env?.EXARCHOS_ORIENTATION).toBe('ORIENTATION-BLOCK');
  }, 20_000);

  /**
   * The test passes no `writeTempFile` override, so the default materializer supplies the temp-file path.
   * After the launch, that path and its parent directory do not exist.
   */
  it('runLifecycle_FileFormOrientation_RemovesTempPathAfterTeardown', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });
    let createdPath: string | undefined;

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: fake.fn,
      newBranch: 'launch-inject-cleanup',
      repoRoot: repo,
      ...HOLDER,
      orientation: {
        content: 'ORIENTATION-BLOCK',
        helpProbe: () => 'Usage: claude\n  --append-system-prompt-file FILE',
      },
    });

    expect(result.success).toBe(true);
    const data = result.data as LifecycleResultData;
    expect(data.injection.channel).toBe('flag:--append-system-prompt-file');
    createdPath = fake.calls[0].args[1];
    expect(createdPath).toBeDefined();
    expect(existsSync(createdPath as string)).toBe(false);
    expect(existsSync(path.dirname(createdPath as string))).toBe(false);
  }, 20_000);

  /** With orientation disabled, the channel label is `disabled`, the spawn args are empty and `EXARCHOS_ORIENTATION` is not set. */
  it('runLifecycle_OrientationDisabled_NoInjectionApplied', async () => {
    const fake = makeFakeSpawn({ code: 0, signal: null });

    const result = await runLifecycle(makeParams(), {
      ctx,
      spawnChild: fake.fn,
      newBranch: 'launch-inject-off',
      repoRoot: repo,
      ...HOLDER,
      orientation: { disabled: true },
    });

    expect(result.success).toBe(true);
    const data = result.data as LifecycleResultData;
    expect(data.injection.channel).toBe('disabled');
    expect(data.injection.degraded).toBe(false);
    expect(fake.calls[0].args).toEqual([]);
    expect(fake.calls[0].env?.EXARCHOS_ORIENTATION).toBeUndefined();
  }, 20_000);
});

// Regression suite for the CLI wiring of the `exarchos <harness>` launcher.
//
// The suite drives the real Commander program over a real `EventStore` and a real git repository.
// It injects only OS-effect fakes at the launcher-wiring seam of `buildCli`. A fake of the
// verb-level `lifecycleDeps` hides a launcher that is not wired.
// Thus each test runs the production composition: `cli.ts`, `makeLauncherLifecycleDeps`, the
// verb, and `runLifecycle`.
//
// A real launch must spawn the child, place it, observe it and tear it down. The teardown
// releases the reservation. A dry-run must spawn nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { buildCli, CLI_EXIT_CODES } from '../../../../src/adapters/cli/cli.js';
import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { WorktreeManager, WORKTREES_STREAM } from '../../../../src/verbs/worktree/manager.js';
import { LAUNCH_EXECUTED } from '../../../../src/runtime/launcher/liveness.js';
import { deriveWorktreePath } from '../../../../src/runtime/launcher/topology.js';
import type {
  AsyncSpawnRequest,
  ChildHandle,
  SpawnExit,
} from '../../../../src/utils/process.js';
import type { SpawnHarnessChildFn } from '../../../../src/runtime/launcher/lifecycle-core.js';
import type {
  SignalRegistrar,
  SignalListener,
  TrappedSignal,
} from '../../../../src/runtime/launcher/signals.js';
import type { LauncherWiringOverrides } from '../../../../src/runtime/launcher/production-deps.js';

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).trim();
}

/**
 * Creates a git repository with one commit and returns its real path.
 * `realpathSync.native` expands Windows 8.3 short names, as the production `defaultRealpath` does.
 * Thus the path equals the one from `deriveWorktreePath` when `os.tmpdir()` is a short path.
 */
async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ['init', '-q', '-b', 'work']);
  await git(dir, ['config', 'user.email', 'cli-launcher@example.com']);
  await git(dir, ['config', 'user.name', 'CLI Launcher Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# cli launcher wiring test\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync.native(dir);
}

async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  await git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync.native(base);
}

interface FakeSpawn {
  readonly fn: SpawnHarnessChildFn;
  readonly calls: AsyncSpawnRequest[];
}

/** A fake spawn that records each request. Its child exits at once with the fixed `exit`. */
function makeFakeSpawn(exit: SpawnExit = { code: 0, signal: null }, pid = 55555): FakeSpawn {
  const calls: AsyncSpawnRequest[] = [];
  const fn: SpawnHarnessChildFn = async (request) => {
    calls.push(request);
    const handle: ChildHandle = {
      pid,
      exit: Promise.resolve(exit),
      kill: () => true,
    };
    return handle;
  };
  return { fn, calls };
}

/** A `SignalRegistrar` that only stores listeners, so the launch never touches real `process` signals. */
function makeNoopRegistrar(): SignalRegistrar {
  const listeners = new Map<TrappedSignal, SignalListener[]>();
  return {
    add(signal, listener) {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
    },
    remove(signal, listener) {
      listeners.set(signal, (listeners.get(signal) ?? []).filter((l) => l !== listener));
    },
  };
}

interface LauncherCliRun {
  readonly stdout: string;
  readonly exitCode: number;
}

async function runLauncherCli(
  ctx: DispatchContext,
  launcher: LauncherWiringOverrides,
  argv: readonly string[],
): Promise<LauncherCliRun> {
  const program = buildCli(ctx, { launcher });
  program.exitOverride();

  const chunks: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((data: unknown): boolean => {
      chunks.push(typeof data === 'string' ? data : String(data));
      return true;
    });

  const savedExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'exarchos', ...argv]);
  } finally {
    stdoutSpy.mockRestore();
  }

  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = savedExitCode;
  return { stdout: chunks.join(''), exitCode };
}

/**
 * `baseOverrides` keeps the launch off the host OS and off real process signals. Its default
 * `recover` does nothing, because one test covers startup recovery separately.
 */
describe('exarchos <harness> launcher CLI wiring (DR-1 / DR-6, R-1)', () => {
  let stateDir: string;
  let workdir: string;
  let store: EventStore;
  let ctx: DispatchContext;
  let repo: string;
  let base: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'cli-launcher-state-'));
    workdir = await mkdtemp(path.join(tmpdir(), 'cli-launcher-work-'));
    store = new EventStore(stateDir);
    await store.initialize();
    ctx = { stateDir, eventStore: store, enableTelemetry: false };
    repo = await initRepo(path.join(workdir, 'repo'));
    base = await addBaseWorktree(repo, workdir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    store.close();
    await rmrfAsync(stateDir);
    await rmrfAsync(workdir);
  });

  function terminalCount(): number {
    return store
      .getReadBackend()
      .queryEvents(WORKTREES_STREAM)
      .filter((e) => e.type === LAUNCH_EXECUTED).length;
  }

  function baseOverrides(fake: FakeSpawn, extra: Partial<LauncherWiringOverrides> = {}): LauncherWiringOverrides {
    return {
      base,
      repoRoot: repo,
      newBranch: `launch-cli-${Math.random().toString(36).slice(2, 8)}`,
      spawnChild: fake.fn,
      signalRegistrar: makeNoopRegistrar(),
      recover: async () => ({ reconciled: [] }),
      ...extra,
    };
  }

  /**
   * The load-bearing test. A real launch exits 0, calls the spawn seam one time with the harness
   * command, and places the child in the new sibling worktree.
   * The launch reaches its terminal event, and the teardown releases the worktree reservation.
   * Both sides of the path comparison use `realpathSync.native`, so Windows short names compare equal.
   */
  it('LauncherCli_NonDryRun_ActuallySpawns', async () => {
    const fake = makeFakeSpawn();

    const { exitCode, stdout } = await runLauncherCli(
      ctx,
      baseOverrides(fake),
      ['claude-code', '--json'],
    );

    expect(stdout).not.toContain('NOT_WIRED');
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe('claude');
    const expectedPath = deriveWorktreePath(base, 'exarchos-claude-code');
    expect(realpathSync.native(fake.calls[0].cwd)).toBe(realpathSync.native(expectedPath));
    expect(existsSync(fake.calls[0].cwd)).toBe(true);

    expect(terminalCount()).toBe(1);

    const manager = new WorktreeManager({ eventStore: store });
    const worktrees = await manager.list();
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].state).toBe('released');
  }, 30_000);

  /**
   * A dry-run only previews: no spawn, no terminal event, and no crash recovery.
   * The preview names the `launch.executed` event, but the store holds no such event.
   */
  it('LauncherCli_DryRun_SpawnsNothing', async () => {
    const fake = makeFakeSpawn();
    let recoverCalls = 0;

    const { exitCode, stdout } = await runLauncherCli(
      ctx,
      baseOverrides(fake, {
        recover: async () => {
          recoverCalls += 1;
          return { reconciled: [] };
        },
      }),
      ['claude-code', '--dry-run', '--json'],
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(fake.calls).toHaveLength(0);
    expect(terminalCount()).toBe(0);
    expect(recoverCalls).toBe(0);
    expect(stdout).toContain('launch.executed');
  });

  /** A real launch runs startup recovery one time, against the repo root. */
  it('LauncherCli_NonDryRun_RunsStartupRecovery', async () => {
    const fake = makeFakeSpawn();
    const recoverRepoRoots: string[] = [];

    const { exitCode } = await runLauncherCli(
      ctx,
      baseOverrides(fake, {
        recover: async (_eventStore, repoRoot) => {
          recoverRepoRoots.push(repoRoot);
          return { reconciled: [] };
        },
      }),
      ['claude-code', '--json'],
    );

    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);
    expect(recoverRepoRoots).toEqual([repo]);
    expect(fake.calls).toHaveLength(1);
  }, 30_000);

  /**
   * `runCli` normalizes only a `CommanderError`, so the launcher action must catch every other
   * rejection. Here the signal-install seam throws after the spawn, and `runLifecycle` rejects.
   * The CLI must map that rejection to the `UNCAUGHT_EXCEPTION` envelope and exit 3.
   */
  it('LauncherCli_LaunchRejection_MapsToUncaughtException', async () => {
    const fake = makeFakeSpawn();
    const stderrChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((data: unknown): boolean => {
      stderrChunks.push(typeof data === 'string' ? data : String(data));
      return true;
    });

    const { exitCode, stdout } = await runLauncherCli(
      ctx,
      baseOverrides(fake, {
        installSignals: () => {
          throw new Error('install seam boom');
        },
      }),
      ['claude-code', '--json'],
    );

    expect(fake.calls).toHaveLength(1);
    expect(exitCode).toBe(CLI_EXIT_CODES.UNCAUGHT_EXCEPTION);
    expect(stdout + stderrChunks.join('')).toContain('UNCAUGHT_EXCEPTION');
  }, 30_000);

  /**
   * `frobozz` is not a Tier-1 harness, so Commander has no such command. Under `exitOverride`,
   * `parseAsync` rejects, and nothing spawns.
   */
  it('LauncherCli_UnknownHarness_NeverRegistered', async () => {
    const fake = makeFakeSpawn();
    await expect(
      runLauncherCli(ctx, baseOverrides(fake), ['frobozz']),
    ).rejects.toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });
});

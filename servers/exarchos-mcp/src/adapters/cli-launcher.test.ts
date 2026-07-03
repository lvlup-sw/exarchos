// ─── `exarchos <harness>` launcher CLI-surface wiring (DR-1 / DR-6, R-1) ─────
//
// The LOAD-BEARING regression suite for the "built but not wired" defect. It
// drives the REAL Commander program (`buildCli(ctx).parseAsync([...])`) over a
// REAL EventStore + REAL git repo, injecting ONLY an OS-effect spawn fake at the
// PRODUCTION boundary (`buildCli`'s launcher-wiring seam) — NOT verb-level
// `lifecycleDeps`, which is exactly the injection that masked the bug. So the
// test exercises the true `cli.ts → makeLauncherLifecycleDeps → verb →
// runLifecycle` composition end-to-end.
//
// Before the wiring, `exarchos <harness>` (non-dry-run) returned `NOT_WIRED`
// (exit 2) and spawned NOTHING. This suite proves a real launch now actually
// spawns → places → observes → tears down (releasing the reservation), and that
// dry-run still spawns nothing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { buildCli, CLI_EXIT_CODES } from './cli.js';
import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { WorktreeManager, WORKTREES_STREAM } from '../orchestrate/worktree/manager.js';
import { LAUNCH_EXECUTED } from '../launcher/liveness.js';
import { deriveWorktreePath } from '../launcher/topology.js';
import type {
  AsyncSpawnRequest,
  ChildHandle,
  SpawnExit,
} from '../utils/process.js';
import type { SpawnHarnessChildFn } from '../launcher/lifecycle-core.js';
import type {
  SignalRegistrar,
  SignalListener,
  TrappedSignal,
} from '../launcher/signals.js';
import type { LauncherWiringOverrides } from '../launcher/production-deps.js';

// ── git + event-store helpers (mirror lifecycle.test.ts) ─────────────────────

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
  git(dir, ['config', 'user.email', 'cli-launcher@example.com']);
  git(dir, ['config', 'user.name', 'CLI Launcher Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(dir, 'README.md'), '# cli launcher wiring test\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return realpathSync(dir);
}

async function addBaseWorktree(repo: string, workdir: string): Promise<string> {
  const base = path.join(workdir, 'base-wt');
  git(repo, ['worktree', 'add', '-q', base, '-b', 'base-branch']);
  return realpathSync(base);
}

// ── Controllable fake spawn (auto-exits with a fixed outcome) ────────────────

interface FakeSpawn {
  readonly fn: SpawnHarnessChildFn;
  readonly calls: AsyncSpawnRequest[];
}

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

/** A captured-listener SignalRegistrar so the launch never touches real `process` signals. */
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

// ── CLI driver ────────────────────────────────────────────────────────────────

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

// ── Suite ───────────────────────────────────────────────────────────────────

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

  /** Base overrides that keep the launch off the host OS + real process signals. */
  function baseOverrides(fake: FakeSpawn, extra: Partial<LauncherWiringOverrides> = {}): LauncherWiringOverrides {
    return {
      base,
      repoRoot: repo,
      newBranch: `launch-cli-${Math.random().toString(36).slice(2, 8)}`,
      spawnChild: fake.fn,
      signalRegistrar: makeNoopRegistrar(),
      // No crash-recovery side effects in the spawn assertions (covered separately).
      recover: async () => ({ reconciled: [] }),
      ...extra,
    };
  }

  // ── THE load-bearing test: a real non-dry-run launch actually spawns ─────────
  it('LauncherCli_NonDryRun_ActuallySpawns', async () => {
    const fake = makeFakeSpawn();

    const { exitCode, stdout } = await runLauncherCli(
      ctx,
      baseOverrides(fake),
      ['claude-code', '--json'],
    );

    // It is NO LONGER NOT_WIRED — the launch succeeded (exit 0) and the wired
    // lifecycle actually ran a child.
    expect(stdout).not.toContain('NOT_WIRED');
    expect(exitCode).toBe(CLI_EXIT_CODES.SUCCESS);

    // The spawn seam was invoked exactly once, with the resolved harness command.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].command).toBe('claude');
    // ...and the child was placed IN the created sibling worktree (not '.').
    const expectedPath = deriveWorktreePath(base, 'exarchos-claude-code');
    expect(realpathSync(fake.calls[0].cwd)).toBe(realpathSync(expectedPath));
    expect(existsSync(fake.calls[0].cwd)).toBe(true);

    // The launch ran to its guaranteed terminal.
    expect(terminalCount()).toBe(1);

    // R-3: the wired teardown RELEASED the launcher worktree's reservation.
    const manager = new WorktreeManager({ eventStore: store });
    const worktrees = await manager.list();
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].state).toBe('released');
  }, 30_000);

  // ── Dry-run still spawns nothing (regression guard on the safe path) ─────────
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
    // Dry-run previews only: no spawn, no terminal, no crash-recovery mutation.
    expect(fake.calls).toHaveLength(0);
    expect(terminalCount()).toBe(0);
    expect(recoverCalls).toBe(0);
    // The preview names the event plan but nothing was emitted.
    expect(stdout).toContain('launch.executed');
  });

  // ── R-4b: a real launch self-heals crashed prior launches first ──────────────
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
    // Startup recovery ran once, against the repo root, BEFORE the spawn.
    expect(recoverRepoRoots).toEqual([repo]);
    expect(fake.calls).toHaveLength(1);
  }, 30_000);

  // ── Unknown harness is still a structured rejection, not a spawn ─────────────
  it('LauncherCli_UnknownHarness_NeverRegistered', async () => {
    const fake = makeFakeSpawn();
    // `frobozz` is not a Tier-1 harness → Commander has no such subcommand, so
    // parseAsync raises a CommanderError under exitOverride (never a spawn).
    await expect(
      runLauncherCli(ctx, baseOverrides(fake), ['frobozz']),
    ).rejects.toBeTruthy();
    expect(fake.calls).toHaveLength(0);
  });
});

// ─── Production launcher wiring — composed deps behavior (DR-6) ───────────────
//
// HIGH-tier suite for the seam that turns the DI-only lifecycle into a LIVE one.
// It proves the composed `RunLifecycleDeps` actually carry the fail-closed
// teardown + real signal handlers a real launch needs — the gap that let every
// non-dry-run launch fall through to `NOT_WIRED`:
//
//   - R-2: the wired `installSignals` seam installs the REAL signal handlers —
//     a trapped SIGTERM is forwarded to the child, teardown + the guaranteed
//     terminal run, and the returned uninstaller detaches the trap.
//   - R-3: the wired `teardown` RELEASES the worktree reservation on a trusted
//     (local-only) target, and FAIL-CLOSES (no release) on a non-git target —
//     while always emitting the guaranteed terminal, and NEVER `reset --hard`.
//   - R-4: `recoverBeforeLaunch` invokes the crash-recovery pass and swallows a
//     recovery failure so it can never block a launch.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../events/store.js';
import type { DispatchContext } from '../dispatch/core/dispatch.js';
import type { WorkflowEvent } from '../events/schemas.js';
import { launcherLogger } from '../logger.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  type GitRunner,
} from '../verbs/worktree/manager.js';
import type { ProcessTableSource } from '../verbs/worktree/pure/probe.js';
import type { SignalChild, SignalRegistrar, SignalListener, TrappedSignal } from './signals.js';
import { emitLaunchExecuted, LAUNCH_EXECUTED } from './liveness.js';
import type { LifecycleSignalContext } from './lifecycle-core.js';
import {
  makeLauncherLifecycleDeps,
  recoverBeforeLaunch,
} from './production-deps.js';

// ── Fakes ─────────────────────────────────────────────────────────────────────

/** A GitRunner whose per-arg-prefix statuses are scripted; unknown → status 0. */
function makeGitRunner(script: Record<string, number>): GitRunner {
  return {
    run(args) {
      const key = args.join(' ');
      for (const prefix of Object.keys(script)) {
        if (key.startsWith(prefix)) return { status: script[prefix], stdout: '' };
      }
      return { status: 0, stdout: '' };
    },
  };
}

/** A process table that provably has NO occupants (so the in-use probe never holds). */
const EMPTY_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => true,
};

/** A minimal in-memory SignalRegistrar (captured listeners, driven by `fire`). */
function makeFakeRegistrar(): {
  registrar: SignalRegistrar;
  fire(signal: TrappedSignal): Promise<void>;
  listenerCount(signal: TrappedSignal): number;
} {
  const listeners = new Map<TrappedSignal, SignalListener[]>();
  return {
    registrar: {
      add(signal, listener) {
        listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
      },
      remove(signal, listener) {
        listeners.set(signal, (listeners.get(signal) ?? []).filter((l) => l !== listener));
      },
    },
    async fire(signal) {
      await Promise.all((listeners.get(signal) ?? []).map((l) => l(signal)));
    },
    listenerCount: (signal) => (listeners.get(signal) ?? []).length,
  };
}

const HOLDER_PID = 987654;
const HOLDER_STARTED_AT = 'prod-deps-holder-fingerprint';

// ── Suite ───────────────────────────────────────────────────────────────────

describe('makeLauncherLifecycleDeps / recoverBeforeLaunch — production wiring (DR-6)', () => {
  let stateDir: string;
  let store: EventStore;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'launcher-proddeps-'));
    store = new EventStore(stateDir);
    await store.initialize();
    ctx = { stateDir, eventStore: store, enableTelemetry: false };
  });

  afterEach(async () => {
    store.close();
    await rmrfAsync(stateDir);
  });

  function terminals(): WorkflowEvent[] {
    return store
      .getReadBackend()
      .queryEvents(WORKTREES_STREAM)
      .filter((e) => e.type === LAUNCH_EXECUTED);
  }

  async function reserveFor(worktreeId: string, worktreePath: string): Promise<void> {
    const manager = new WorktreeManager({ eventStore: store });
    const result = await manager.reserve({
      worktreeId,
      path: worktreePath,
      featureId: null,
      ownerPid: HOLDER_PID,
      ownerStartedAt: HOLDER_STARTED_AT,
    });
    expect(result.reserved).toBe(true);
  }

  async function stateOf(worktreeId: string): Promise<string | undefined> {
    const manager = new WorktreeManager({ eventStore: store });
    const list = await manager.list();
    return list.find((w) => w.worktreeId === worktreeId)?.state;
  }

  // ── R-3: the wired teardown RELEASES the reservation on a trusted target ─────
  it('ProdDeps_Teardown_ReleasesReservation', async () => {
    const worktreeId = '/wt/exarchos-claude-code';
    const worktreePath = '/wt/exarchos-claude-code';
    await reserveFor(worktreeId, worktreePath);
    expect(await stateOf(worktreeId)).toBe('reserved');

    const deps = makeLauncherLifecycleDeps(ctx, {
      holderPid: HOLDER_PID,
      holderStartedAt: HOLDER_STARTED_AT,
      // A real git worktree with NO origin configured → local-only → trustworthy.
      gitRunner: makeGitRunner({ 'rev-parse': 0, 'remote get-url origin': 1 }),
      processTableSource: EMPTY_TABLE,
      realpath: (p) => p,
    });

    await deps.teardown!({
      eventStore: store,
      worktreeId,
      worktreePath,
      exitCode: 0,
      emitExecuted: emitLaunchExecuted,
    });

    // The reservation was cleanly relinquished (same-owner) and the guaranteed
    // terminal landed exactly once.
    expect(await stateOf(worktreeId)).toBe('released');
    expect(terminals()).toHaveLength(1);
  });

  // ── R-3: the wired teardown FAIL-CLOSES on a non-git target ──────────────────
  it('ProdDeps_Teardown_FailClosed_NonGitTarget_NoRelease', async () => {
    const worktreeId = '/wt/exarchos-codex';
    const worktreePath = '/wt/exarchos-codex';
    await reserveFor(worktreeId, worktreePath);

    const deps = makeLauncherLifecycleDeps(ctx, {
      holderPid: HOLDER_PID,
      holderStartedAt: HOLDER_STARTED_AT,
      // `rev-parse --is-inside-work-tree` fails → non-git target → fail closed.
      gitRunner: makeGitRunner({ 'rev-parse': 128 }),
      processTableSource: EMPTY_TABLE,
      realpath: (p) => p,
    });

    await deps.teardown!({
      eventStore: store,
      worktreeId,
      worktreePath,
      exitCode: null,
      emitExecuted: emitLaunchExecuted,
    });

    // Fail-closed: the reservation is HELD (never released against an untrusted
    // target), yet the guaranteed terminal still landed.
    expect(await stateOf(worktreeId)).toBe('reserved');
    expect(terminals()).toHaveLength(1);
  });

  // ── R-2: the wired installSignals installs the REAL handlers ─────────────────
  it('ProdDeps_InstallSignals_ForwardsAndTearsDown', async () => {
    const registrar = makeFakeRegistrar();
    const deps = makeLauncherLifecycleDeps(ctx, {
      holderPid: HOLDER_PID,
      holderStartedAt: HOLDER_STARTED_AT,
      signalRegistrar: registrar.registrar,
    });

    const log: string[] = [];
    const killCalls: (NodeJS.Signals | number | undefined)[] = [];
    const child: SignalChild = {
      kill(signal) {
        killCalls.push(signal);
        return true;
      },
      get exit() {
        return Promise.resolve({ code: null, signal: 'SIGTERM' as NodeJS.Signals });
      },
    };
    let terminalCount = 0;
    const sigCtx: LifecycleSignalContext = {
      child,
      teardown: (signal) => {
        log.push(`teardown:${signal}`);
      },
      emitTerminal: async () => {
        terminalCount += 1;
        return { appended: true, worktreeId: 'wt', exitCode: null };
      },
    };

    const uninstall = deps.installSignals!(sigCtx);
    expect(registrar.listenerCount('SIGTERM')).toBe(1);

    await registrar.fire('SIGTERM');

    // The real installer forwarded the signal to the child, ran teardown, and
    // fired the guaranteed terminal.
    expect(killCalls).toEqual(['SIGTERM']);
    expect(log).toContain('teardown:SIGTERM');
    expect(terminalCount).toBe(1);

    // The uninstaller detaches the trap so nothing outlives the launch.
    uninstall();
    expect(registrar.listenerCount('SIGTERM')).toBe(0);
  });

  // ── DR-6 review polish: a signal-path failure is LOGGED, not swallowed ───────
  // Guards against a future refactor silently reverting to `signals.ts`'s `noop`
  // onError default — the exact silent-swallow class this fix closes.
  it('ProdDeps_InstallSignals_OnError_LogsSignalPathFailure', async () => {
    const registrar = makeFakeRegistrar();
    const deps = makeLauncherLifecycleDeps(ctx, {
      holderPid: HOLDER_PID,
      holderStartedAt: HOLDER_STARTED_AT,
      signalRegistrar: registrar.registrar,
    });

    const errorSpy = vi.spyOn(launcherLogger, 'error').mockImplementation((() => {}) as never);

    const child: SignalChild = {
      kill() {
        return true;
      },
      get exit() {
        return Promise.resolve({ code: null, signal: 'SIGTERM' as NodeJS.Signals });
      },
    };
    const teardownError = new Error('teardown blew up');
    const sigCtx: LifecycleSignalContext = {
      child,
      teardown: () => {
        throw teardownError;
      },
      emitTerminal: async () => ({ appended: true, worktreeId: 'wt', exitCode: null }),
    };

    deps.installSignals!(sigCtx);
    await registrar.fire('SIGTERM');

    // The wired `onError` funnels the failure to the launcher logger with
    // structured context (err/signal/holderPid) instead of vanishing.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: teardownError, signal: 'SIGTERM', holderPid: HOLDER_PID }),
      'signal-path teardown/terminal failed',
    );

    errorSpy.mockRestore();
  });

  // ── R-4: recoverBeforeLaunch invokes the recovery pass ───────────────────────
  it('RecoverBeforeLaunch_InvokesRecovery', async () => {
    let calledWith: { repoRoot: string } | undefined;
    await recoverBeforeLaunch(ctx, '/repo/root', {
      recover: async (eventStore, repoRoot) => {
        expect(eventStore).toBe(store);
        calledWith = { repoRoot };
        return { reconciled: [] };
      },
    });
    expect(calledWith).toEqual({ repoRoot: '/repo/root' });
  });

  // ── R-4: a recovery failure NEVER blocks a launch ────────────────────────────
  it('RecoverBeforeLaunch_SwallowsFailure', async () => {
    await expect(
      recoverBeforeLaunch(ctx, '/repo/root', {
        recover: async () => {
          throw new Error('recovery blew up');
        },
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * Tests for the production launcher wiring, `makeLauncherLifecycleDeps` and `recoverBeforeLaunch`.
 *
 * The composed `RunLifecycleDeps` must carry the fail-closed teardown and the real signal handlers.
 * Each test uses a real `EventStore`. The teardown tests inject the git and process-table seams.
 * The signal tests inject the registrar, and the recovery tests inject the recovery pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { launcherLogger } from '../../../../src/logger.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import {
  WorktreeManager,
  WORKTREES_STREAM,
  type GitRunner,
} from '../../../../src/verbs/worktree/manager.js';
import type { ProcessTableSource } from '../../../../src/verbs/worktree/pure/probe.js';
import type { SignalChild, SignalRegistrar, SignalListener, TrappedSignal } from '../../../../src/runtime/launcher/signals.js';
import { emitLaunchExecuted, LAUNCH_EXECUTED } from '../../../../src/runtime/launcher/liveness.js';
import type { LifecycleSignalContext } from '../../../../src/runtime/launcher/lifecycle-core.js';
import {
  makeLauncherLifecycleDeps,
  recoverBeforeLaunch,
} from '../../../../src/runtime/launcher/production-deps.js';

/** A `GitRunner` that returns the scripted status of the first key that is a prefix of the joined args. An unknown command gets status 0. */
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

/** A supported process table with no process, so the in-use probe finds no occupant. */
const EMPTY_TABLE: ProcessTableSource = {
  list: () => [],
  isSupported: () => true,
};

/** A `SignalRegistrar` that holds listeners in memory. `fire` calls each listener of a signal. */
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

  /**
   * The scripted git has no `origin`, so the target is local-only and trusted.
   * The wired teardown releases the reservation of the same owner and writes one terminal.
   */
  it('ProdDeps_Teardown_ReleasesReservation', async () => {
    const worktreeId = '/wt/exarchos-claude-code';
    const worktreePath = '/wt/exarchos-claude-code';
    await reserveFor(worktreeId, worktreePath);
    expect(await stateOf(worktreeId)).toBe('reserved');

    const deps = makeLauncherLifecycleDeps(ctx, {
      holderPid: HOLDER_PID,
      holderStartedAt: HOLDER_STARTED_AT,
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

    expect(await stateOf(worktreeId)).toBe('released');
    expect(terminals()).toHaveLength(1);
  });

  /** When `git rev-parse` fails, the wired teardown keeps the reservation and still writes one terminal. */
  it('ProdDeps_Teardown_FailClosed_NonGitTarget_NoRelease', async () => {
    const worktreeId = '/wt/exarchos-codex';
    const worktreePath = '/wt/exarchos-codex';
    await reserveFor(worktreeId, worktreePath);

    const deps = makeLauncherLifecycleDeps(ctx, {
      holderPid: HOLDER_PID,
      holderStartedAt: HOLDER_STARTED_AT,
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

    expect(await stateOf(worktreeId)).toBe('reserved');
    expect(terminals()).toHaveLength(1);
  });

  /**
   * The wired `installSignals` registers a `SIGTERM` listener on the injected registrar.
   * On the signal, the listener forwards `SIGTERM` to the child, emits the terminal and runs teardown.
   * The uninstaller removes the listener.
   */
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

    expect(killCalls).toEqual(['SIGTERM']);
    expect(log).toContain('teardown:SIGTERM');
    expect(terminalCount).toBe(1);

    uninstall();
    expect(registrar.listenerCount('SIGTERM')).toBe(0);
  });

  /**
   * When teardown throws on the signal path, the wiring calls `launcherLogger.error` with the error, the signal and the holder PID.
   * The default `onError` of `installSignalHandlers` is a no-op, so this test fails when the wiring passes no `onError`.
   */
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

    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: teardownError, signal: 'SIGTERM', holderPid: HOLDER_PID }),
      'signal-path teardown/terminal failed',
    );

    errorSpy.mockRestore();
  });

  /** `recoverBeforeLaunch` calls the injected recovery pass with the event store and the repo root. */
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

  /** A recovery pass that throws does not make `recoverBeforeLaunch` reject, so a recovery failure cannot block a launch. */
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

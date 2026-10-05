/**
 * Tests for the launcher signal trap, `installSignalHandlers`.
 *
 * Each test calls a captured listener through a fake `SignalRegistrar`, so no real signal reaches
 * the test runner. The child is a fake that records each `kill` call and each read of `exit`.
 * One suite emits the terminal through the real `emitLaunchExecuted` on a real `EventStore`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../../../src/verbs/worktree/manager.js';
import type { SpawnExit } from '../../../../src/utils/process.js';
import { LAUNCH_EXECUTED, emitLaunchExecuted } from '../../../../src/runtime/launcher/liveness.js';
import {
  installSignalHandlers,
  type EmitTerminalFn,
  type EscalationTimer,
  type ScheduleEscalation,
  type SignalChild,
  type SignalListener,
  type SignalRegistrar,
  type TrappedSignal,
} from '../../../../src/runtime/launcher/signals.js';

interface FakeRegistrar {
  readonly registrar: SignalRegistrar;
  /** Calls each listener of `signal` and waits for all of them. */
  fire(signal: TrappedSignal): Promise<void>;
  /** The number of listeners registered for `signal`. */
  listenerCount(signal: TrappedSignal): number;
}

/**
 * A `SignalRegistrar` that holds listeners in memory and does not touch `process`.
 * `fire` waits for each listener, so the trap body is settled before the test asserts.
 */
function makeFakeRegistrar(): FakeRegistrar {
  const listeners = new Map<TrappedSignal, SignalListener[]>();
  const registrar: SignalRegistrar = {
    add(signal, listener) {
      const list = listeners.get(signal) ?? [];
      list.push(listener);
      listeners.set(signal, list);
    },
    remove(signal, listener) {
      const list = listeners.get(signal) ?? [];
      listeners.set(
        signal,
        list.filter((registered) => registered !== listener),
      );
    },
  };
  return {
    registrar,
    async fire(signal) {
      const list = listeners.get(signal) ?? [];
      await Promise.all(list.map((listener) => listener(signal)));
    },
    listenerCount: (signal) => (listeners.get(signal) ?? []).length,
  };
}

interface FakeChild {
  readonly child: SignalChild;
  /** Each signal passed to `child.kill`, in call order. */
  readonly killCalls: (NodeJS.Signals | number | undefined)[];
  /** Tells if a caller read `child.exit`. */
  exitObserved(): boolean;
}

/**
 * A `SignalChild` that records each `kill` call and adds a `kill:<signal>` marker to `log`.
 * Its `exit` getter returns a resolved promise and records the read.
 */
function makeFakeChild(
  log: string[],
  exit: SpawnExit = { code: null, signal: 'SIGTERM' },
): FakeChild {
  const killCalls: (NodeJS.Signals | number | undefined)[] = [];
  let observed = false;
  const exitPromise = Promise.resolve(exit);
  const child: SignalChild = {
    kill(signal) {
      killCalls.push(signal);
      log.push(`kill:${String(signal)}`);
      return true;
    },
    get exit() {
      observed = true;
      return exitPromise;
    },
  };
  return { child, killCalls, exitObserved: () => observed };
}

describe('installSignalHandlers — signal handling + orphan prevention (DR-6)', () => {
  /** The trap forwards the trapped signal to the child before teardown runs. */
  it('Signals_SigtermForwarded_ThenTeardown', async () => {
    const log: string[] = [];
    const fake = makeFakeChild(log);
    const registrar = makeFakeRegistrar();

    const teardown = async (signal: TrappedSignal): Promise<void> => {
      log.push(`teardown:${signal}`);
    };
    const emitTerminal: EmitTerminalFn = async () => {
      log.push('terminal');
      return { appended: true, worktreeId: 'wt', exitCode: null };
    };

    installSignalHandlers({
      child: fake.child,
      teardown,
      emitTerminal,
      signals: registrar.registrar,
    });

    await registrar.fire('SIGTERM');

    expect(fake.killCalls).toEqual(['SIGTERM']);
    expect(log.indexOf('kill:SIGTERM')).toBeLessThan(log.indexOf('teardown:SIGTERM'));
    expect(log).toContain('teardown:SIGTERM');
  });

  /** The terminal goes through the real `emitLaunchExecuted` on a real `EventStore`, so the test reads the persisted row. */
  describe('Signals_SigtermPath_EmitsLaunchExecutedTerminal (real event store)', () => {
    let stateDir: string;
    let store: EventStore;

    beforeEach(async () => {
      stateDir = await mkdtemp(path.join(tmpdir(), 'launcher-signals-state-'));
      store = new EventStore(stateDir);
      await store.initialize();
    });

    afterEach(async () => {
      store.close();
      await rmrfAsync(stateDir);
    });

    const WT_ID = 'exarchos-claude-code';

    function terminals(): WorkflowEvent[] {
      return store
        .getReadBackend()
        .queryEvents(WORKTREES_STREAM)
        .filter((event) => event.type === LAUNCH_EXECUTED);
    }

    /** No terminal exists before the signal. After it, the `worktrees` stream holds one `launch.executed` row with `exitCode: null`. */
    it('Signals_SigtermPath_EmitsLaunchExecutedTerminal', async () => {
      const log: string[] = [];
      const fake = makeFakeChild(log);
      const registrar = makeFakeRegistrar();

      const emitTerminal: EmitTerminalFn = () =>
        emitLaunchExecuted(store, { worktreeId: WT_ID, exitCode: null });

      installSignalHandlers({
        child: fake.child,
        teardown: () => undefined,
        emitTerminal,
        signals: registrar.registrar,
      });

      expect(terminals()).toHaveLength(0);

      await registrar.fire('SIGTERM');

      const rows = terminals();
      expect(rows).toHaveLength(1);
      expect(rows[0].data?.worktreeId).toBe(WT_ID);
      expect(rows[0].data?.exitCode).toBeNull();
    });
  });

  /** The trap sends the trapped signal to the child and reads `child.exit`, the promise that the reap waits for. */
  it('Signals_LauncherDies_ChildNotOrphaned', async () => {
    const log: string[] = [];
    const fake = makeFakeChild(log);
    const registrar = makeFakeRegistrar();

    installSignalHandlers({
      child: fake.child,
      teardown: () => undefined,
      emitTerminal: async () => ({ appended: true, worktreeId: 'wt', exitCode: null }),
      signals: registrar.registrar,
    });

    await registrar.fire('SIGTERM');

    expect(fake.killCalls).toEqual(['SIGTERM']);
    expect(fake.exitObserved()).toBe(true);
  });

  /** Two `SIGTERM` deliveries give one forward, one teardown and one terminal. */
  it('Signals_DoubleSignal_TeardownIdempotent', async () => {
    const log: string[] = [];
    const fake = makeFakeChild(log);
    const registrar = makeFakeRegistrar();

    let teardownCount = 0;
    let terminalCount = 0;
    const teardown = async (): Promise<void> => {
      teardownCount += 1;
    };
    const emitTerminal: EmitTerminalFn = async () => {
      terminalCount += 1;
      return { appended: terminalCount === 1, worktreeId: 'wt', exitCode: null };
    };

    installSignalHandlers({
      child: fake.child,
      teardown,
      emitTerminal,
      signals: registrar.registrar,
    });

    await registrar.fire('SIGTERM');
    await registrar.fire('SIGTERM');

    expect(fake.killCalls).toHaveLength(1);
    expect(teardownCount).toBe(1);
    expect(terminalCount).toBe(1);
  });

  /**
   * The `exit` promise of this child settles only on `SIGKILL`, and the injected scheduler fires the escalation at once.
   * The trap forwards `SIGTERM` and then sends `SIGKILL`, so the reap does not hang.
   */
  it('Signals_NonExitingChild_EscalatesToSigkill', async () => {
    const log: string[] = [];
    const registrar = makeFakeRegistrar();

    const killCalls: (NodeJS.Signals | number | undefined)[] = [];
    let resolveExit!: (e: SpawnExit) => void;
    const exitPromise = new Promise<SpawnExit>((res) => {
      resolveExit = res;
    });
    const child: SignalChild = {
      kill(signal) {
        killCalls.push(signal);
        log.push(`kill:${String(signal)}`);
        if (signal === 'SIGKILL') resolveExit({ code: null, signal: 'SIGKILL' });
        return true;
      },
      get exit() {
        return exitPromise;
      },
    };

    let armed = false;
    const scheduleEscalation: ScheduleEscalation = (onExpire): EscalationTimer => {
      armed = true;
      onExpire();
      return { cancel: () => undefined };
    };

    installSignalHandlers({
      child,
      teardown: () => undefined,
      emitTerminal: async () => ({ appended: true, worktreeId: 'wt', exitCode: null }),
      signals: registrar.registrar,
      killTimeoutMs: 5,
      scheduleEscalation,
    });

    await registrar.fire('SIGTERM');

    expect(armed).toBe(true);
    expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  /** A child that exits by itself gets no `SIGKILL`, and the trap cancels the escalation timer. */
  it('Signals_ExitingChild_NoEscalation', async () => {
    const log: string[] = [];
    const fake = makeFakeChild(log);
    const registrar = makeFakeRegistrar();

    let cancelled = false;
    const scheduleEscalation: ScheduleEscalation = (): EscalationTimer => ({
      cancel: () => {
        cancelled = true;
      },
    });

    installSignalHandlers({
      child: fake.child,
      teardown: () => undefined,
      emitTerminal: async () => ({ appended: true, worktreeId: 'wt', exitCode: null }),
      signals: registrar.registrar,
      scheduleEscalation,
    });

    await registrar.fire('SIGTERM');

    expect(fake.killCalls).toEqual(['SIGTERM']);
    expect(cancelled).toBe(true);
  });

  /**
   * The trap registers one listener for each of `SIGINT` and `SIGTERM`.
   * After the uninstaller runs, no listener remains and a late signal does nothing.
   */
  it('Signals_Uninstall_DetachesHandlers', async () => {
    const log: string[] = [];
    const fake = makeFakeChild(log);
    const registrar = makeFakeRegistrar();

    const uninstall = installSignalHandlers({
      child: fake.child,
      teardown: () => undefined,
      emitTerminal: async () => ({ appended: true, worktreeId: 'wt', exitCode: null }),
      signals: registrar.registrar,
    });

    expect(registrar.listenerCount('SIGINT')).toBe(1);
    expect(registrar.listenerCount('SIGTERM')).toBe(1);

    uninstall();

    expect(registrar.listenerCount('SIGINT')).toBe(0);
    expect(registrar.listenerCount('SIGTERM')).toBe(0);

    await registrar.fire('SIGTERM');
    expect(fake.killCalls).toHaveLength(0);
    expect(fake.exitObserved()).toBe(false);
  });
});

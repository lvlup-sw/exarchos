// ─── Launcher signal handling + orphan prevention (DR-6) ──────────────────────
//
// HIGH-tier suite for the installable signal seam. Every test drives the trap
// DETERMINISTICALLY through an injected `SignalRegistrar` fake — a captured
// listener invoked directly — so no real signal is delivered to the vitest
// process. The child is a controllable fake ({@link makeFakeChild}) whose `exit`
// promise auto-resolves and whose `kill`/`exit` accesses are recorded, so the
// forward → teardown → terminal → reap path runs to completion without a real
// child. The terminal-emission test drives the REAL EventStore / SQLite
// substrate so `launch.executed` idempotency is asserted against the shipped
// Task-006 seam, not a mock. The contract under test:
//
//   - a trapped SIGTERM is FORWARDED to the child, THEN teardown runs;
//   - the signal path emits the guaranteed `launch.executed` terminal via the
//     idempotent Task-006 seam;
//   - the child is killed AND reaped (awaited) — never orphaned / detached;
//   - a double signal collapses to ONE forward / teardown / terminal.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../orchestrate/worktree/manager.js';
import type { SpawnExit } from '../utils/process.js';
import { LAUNCH_EXECUTED, emitLaunchExecuted } from './liveness.js';
import {
  installSignalHandlers,
  type EmitTerminalFn,
  type EscalationTimer,
  type ScheduleEscalation,
  type SignalChild,
  type SignalListener,
  type SignalRegistrar,
  type TrappedSignal,
} from './signals.js';

// ─── Deterministic signal-registration fake ───────────────────────────────────

interface FakeRegistrar {
  readonly registrar: SignalRegistrar;
  /** Deliver `signal` to every listener registered for it, awaiting each. */
  fire(signal: TrappedSignal): Promise<void>;
  /** How many listeners are currently registered for `signal`. */
  listenerCount(signal: TrappedSignal): number;
}

/**
 * A {@link SignalRegistrar} that captures listeners in-memory instead of binding
 * `process` — so a test drives the trap by calling {@link FakeRegistrar.fire}.
 * `fire` awaits each listener's returned promise, so the async trap body is
 * fully settled (forward → teardown → terminal → reap) before the test asserts.
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

// ─── Controllable fake child ──────────────────────────────────────────────────

interface FakeChild {
  readonly child: SignalChild;
  /** Every signal passed to `child.kill`, in call order. */
  readonly killCalls: (NodeJS.Signals | number | undefined)[];
  /** Whether the trap body READ `child.exit` (i.e. awaited the reap). */
  exitObserved(): boolean;
}

/**
 * A deterministic {@link SignalChild}: records `kill` calls (and appends a
 * `kill:<signal>` marker to the shared `log`), and exposes an auto-resolving
 * `exit` promise whose GETTER access flips `exitObserved` — the proof the trap
 * body reaped (awaited) the child rather than leaving it detached.
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

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('installSignalHandlers — signal handling + orphan prevention (DR-6)', () => {
  // ── Signals_SigtermForwarded_ThenTeardown ───────────────────────────────────
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

    // The child was forwarded exactly the trapped signal...
    expect(fake.killCalls).toEqual(['SIGTERM']);
    // ...and the forward happened BEFORE teardown ran.
    expect(log.indexOf('kill:SIGTERM')).toBeLessThan(log.indexOf('teardown:SIGTERM'));
    expect(log).toContain('teardown:SIGTERM');
  });

  // ── Signals_SigtermPath_EmitsLaunchExecutedTerminal ─────────────────────────
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

    it('Signals_SigtermPath_EmitsLaunchExecutedTerminal', async () => {
      const log: string[] = [];
      const fake = makeFakeChild(log);
      const registrar = makeFakeRegistrar();

      // The GUARANTEED terminal rides the REAL idempotent Task-006 seam — not a
      // mock — so the assertion pins the shipped `launch.executed` contract.
      const emitTerminal: EmitTerminalFn = () =>
        emitLaunchExecuted(store, { worktreeId: WT_ID, exitCode: null });

      installSignalHandlers({
        child: fake.child,
        teardown: () => undefined,
        emitTerminal,
        signals: registrar.registrar,
      });

      // No terminal until the signal path fires.
      expect(terminals()).toHaveLength(0);

      await registrar.fire('SIGTERM');

      // Exactly one `launch.executed` landed on the worktrees stream, correlated
      // to the launch and carrying the signal-terminated `exitCode: null`.
      const rows = terminals();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.data?.worktreeId).toBe(WT_ID);
      expect(rows[0]!.data?.exitCode).toBeNull();
    });
  });

  // ── Signals_LauncherDies_ChildNotOrphaned ───────────────────────────────────
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

    // The launcher is interrupted (told to die) with SIGTERM.
    await registrar.fire('SIGTERM');

    // The child is KILLED (receives the terminating signal, so it dies WITH the
    // launcher rather than surviving detached)...
    expect(fake.killCalls).toEqual(['SIGTERM']);
    // ...AND is reaped: the trap body awaited `child.exit`, so THIS parent
    // collects it — it is never left orphaned / reparented to init.
    expect(fake.exitObserved()).toBe(true);
  });

  // ── Signals_DoubleSignal_TeardownIdempotent ─────────────────────────────────
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

    // Two signals arrive (Ctrl-C mashed twice / SIGINT then SIGTERM).
    await registrar.fire('SIGTERM');
    await registrar.fire('SIGTERM');

    // The trap body collapsed to ONE run: forward, teardown, and terminal each
    // fired exactly once despite two delivered signals.
    expect(fake.killCalls).toHaveLength(1);
    expect(teardownCount).toBe(1);
    expect(terminalCount).toBe(1);
  });

  // ── Signals_NonExitingChild_EscalatesToSigkill (DR-6 / R-5) ─────────────────
  it('Signals_NonExitingChild_EscalatesToSigkill', async () => {
    const log: string[] = [];
    const registrar = makeFakeRegistrar();

    // A child that IGNORES the forwarded signal: its `exit` never resolves on its
    // own — ONLY a SIGKILL makes it exit. Without escalation the reap would hang
    // the launcher forever.
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

    // A deterministic escalation scheduler that fires the SIGKILL timer at once —
    // no wall-clock wait. Records that it was armed.
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

    // This RESOLVES (does not hang) only because escalation forces the SIGKILL —
    // the child's own `exit` would never settle otherwise.
    await registrar.fire('SIGTERM');

    expect(armed).toBe(true);
    // The original signal was forwarded first, THEN SIGKILL escalated the
    // unresponsive child.
    expect(killCalls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  // ── Signals_ExitingChild_NoEscalation (escalation is cancelled on clean exit) ─
  it('Signals_ExitingChild_NoEscalation', async () => {
    const log: string[] = [];
    const fake = makeFakeChild(log); // auto-resolving exit
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

    // A child that exits on its own is NEVER SIGKILL'd, and the pending escalation
    // timer is cancelled so nothing lingers.
    expect(fake.killCalls).toEqual(['SIGTERM']);
    expect(cancelled).toBe(true);
  });

  // ── Bonus: the uninstaller detaches every handler (nothing outlives the launch)
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

    // Both catchable signals are trapped while the launch is live.
    expect(registrar.listenerCount('SIGINT')).toBe(1);
    expect(registrar.listenerCount('SIGTERM')).toBe(1);

    uninstall();

    // After teardown of the launch, no trap outlives the child.
    expect(registrar.listenerCount('SIGINT')).toBe(0);
    expect(registrar.listenerCount('SIGTERM')).toBe(0);

    // A late signal to a detached listener set is a no-op — no forward / reap.
    await registrar.fire('SIGTERM');
    expect(fake.killCalls).toHaveLength(0);
    expect(fake.exitObserved()).toBe(false);
  });
});

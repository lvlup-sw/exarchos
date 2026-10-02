/**
 * Signal handling and orphan prevention for the harness launcher, which supervises the agent harness as a child process.
 * On `SIGINT` or `SIGTERM`, the trap forwards the signal to the child, so the child does not survive as an orphan.
 * Then it emits the `launch.executed` terminal before the reap, so a slow child cannot block the terminal.
 * Then it reaps the child, and then it runs teardown.
 * Teardown comes after the reap, because its occupancy probe must see the child collected.
 * Otherwise the child counts as an occupant of its own worktree, and the reservation stays until the next GC.
 *
 * The trap body runs at most once, so a second signal joins the first run. The terminal emitter is also idempotent.
 * The `process` registration is an injectable {@link SignalRegistrar}. The integrator calls the returned uninstaller when the child exits.
 */

import type { ChildHandle } from '../../utils/process.js';
import type { EmitLaunchExecutedResult } from './liveness.js';

/** The catchable signals that the launcher traps and forwards. */
export type TrappedSignal = 'SIGINT' | 'SIGTERM';

/** The default trap set: `SIGINT` (Ctrl-C) + `SIGTERM` (`kill`). */
export const DEFAULT_TRAPPED_SIGNALS: readonly TrappedSignal[] = ['SIGINT', 'SIGTERM'];

/**
 * The view of the supervised child that the signal path needs: `kill` to forward the signal, and `exit` to reap it.
 * A {@link ChildHandle} satisfies it. The view does not include the raw streams.
 */
export type SignalChild = Pick<ChildHandle, 'kill' | 'exit'>;

/**
 * Teardown that runs on a parent interruption, with the trapped signal. It runs at most once across a double signal.
 * It owns its release and recovery semantics. This module only makes sure that each catchable signal reaches it.
 */
export type SignalTeardown = (signal: TrappedSignal) => void | Promise<void>;

/**
 * The terminal emitter. The integrator binds it over the idempotent {@link liveness.emitLaunchExecuted}, with `exitCode: null`.
 * A child that a signal stops has no exit code. The seam writes at most one `launch.executed` row, also when this function runs twice.
 */
export type EmitTerminalFn = () => Promise<EmitLaunchExecutedResult>;

/**
 * Signal-registration seam over `process.on` and `process.off`. Tests inject it and call a captured listener, so no real signal goes to the test runner.
 * The default is {@link processSignalRegistrar}.
 */
export interface SignalRegistrar {
  add(signal: TrappedSignal, listener: SignalListener): void;
  remove(signal: TrappedSignal, listener: SignalListener): void;
}

/** A registered signal listener. It can be async, because the trap body is async. */
export type SignalListener = (signal: TrappedSignal) => void | Promise<void>;

/** A cancellable handle over the SIGTERM-to-SIGKILL escalation timer. */
export interface EscalationTimer {
  /** Cancel the pending escalation, when the child exits on its own. */
  cancel(): void;
}

/**
 * Schedules the SIGTERM-to-SIGKILL escalation timer. A test injects it and calls `onExpire` directly, with no real {@link DEFAULT_KILL_TIMEOUT_MS} wait.
 * The default is {@link defaultScheduleEscalation}.
 */
export type ScheduleEscalation = (
  onExpire: () => void,
  timeoutMs: number,
) => EscalationTimer;

/** Default grace period in ms before the launcher sends `SIGKILL` to a child that ignores the forwarded signal. */
export const DEFAULT_KILL_TIMEOUT_MS = 10_000;

/** Dependencies for {@link installSignalHandlers}. */
export interface InstallSignalHandlersOptions {
  /** The live supervised child that gets the forwarded signal and the reap. */
  readonly child: SignalChild;
  /** Teardown that runs on interruption, at most once. */
  readonly teardown: SignalTeardown;
  /** The bound, idempotent `launch.executed` terminal emitter. */
  readonly emitTerminal: EmitTerminalFn;
  /** Signal-registration seam. The default is a `process` adapter. */
  readonly signals?: SignalRegistrar;
  /** Signals to trap. The default is {@link DEFAULT_TRAPPED_SIGNALS}. */
  readonly trap?: readonly TrappedSignal[];
  /**
   * Observer for a teardown or terminal failure on the signal path. The default is a no-op.
   * A signal handler must not reject, because the rejection on `process` is unhandled. Thus the listener sends each error here.
   */
  readonly onError?: (error: unknown, signal: TrappedSignal) => void;
  /**
   * Grace period in ms after the forwarded signal. Then a child that did not exit gets `SIGKILL`, so a slow child cannot hang the reap.
   * The default is {@link DEFAULT_KILL_TIMEOUT_MS}.
   */
  readonly killTimeoutMs?: number;
  /** The escalation-timer scheduler. The default is {@link defaultScheduleEscalation}. A test injects it to fire the escalation with no real wait. */
  readonly scheduleEscalation?: ScheduleEscalation;
}

/**
 * Trap `SIGINT` and `SIGTERM`. On a signal, forward it to the child, emit the terminal, reap the child, and run teardown, in that order.
 * When the terminal emit or the reap throws, the later steps still run. A double signal, or `SIGINT` then `SIGTERM`, gives one run.
 *
 * The listener never rejects, because a rejection on `process` is unhandled. Errors go to `onError`.
 * Returns an uninstaller that removes the handlers. The integrator calls it when the launch ends.
 */
export function installSignalHandlers(
  options: InstallSignalHandlersOptions,
): () => void {
  const { child, teardown, emitTerminal } = options;
  const registrar = options.signals ?? processSignalRegistrar();
  const trapped = options.trap ?? DEFAULT_TRAPPED_SIGNALS;
  const onError = options.onError ?? noop;
  const killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
  const scheduleEscalation = options.scheduleEscalation ?? defaultScheduleEscalation;

  const runOnce = once(async (signal: TrappedSignal): Promise<void> => {
    child.kill(signal);
    try {
      await emitTerminal();
    } finally {
      try {
        await reapWithEscalation(child, killTimeoutMs, scheduleEscalation);
      } finally {
        await teardown(signal);
      }
    }
  });

  const listener: SignalListener = (signal) =>
    runOnce(signal).catch((error: unknown) => {
      onError(error, signal);
    });

  for (const signal of trapped) {
    registrar.add(signal, listener);
  }

  let uninstalled = false;
  return () => {
    if (uninstalled) return;
    uninstalled = true;
    for (const signal of trapped) {
      registrar.remove(signal, listener);
    }
  };
}

/** Memoize a single-argument async body so that it runs at most once. Each later call returns the first promise and ignores its argument. */
function once<A>(body: (arg: A) => Promise<void>): (arg: A) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (arg) => (pending ??= body(arg));
}

/**
 * Reap the child. When it does not exit within `timeoutMs`, send `SIGKILL` and wait for the exit, so this parent still collects it.
 * A clean exit cancels the timer, so the escalation does not fire and does not keep the event loop alive.
 */
async function reapWithEscalation(
  child: SignalChild,
  timeoutMs: number,
  schedule: ScheduleEscalation,
): Promise<void> {
  let timer: EscalationTimer | undefined;
  const exited = child.exit.then((): 'exited' => 'exited');
  const escalated = new Promise<'escalate'>((resolve) => {
    timer = schedule(() => resolve('escalate'), timeoutMs);
  });
  void child.exit.then(() => timer?.cancel());

  const outcome = await Promise.race([exited, escalated]);
  if (outcome === 'escalate') {
    child.kill('SIGKILL');
    await child.exit;
  }
}

/** Default {@link ScheduleEscalation}: a `setTimeout` with `unref`, so a pending escalation does not keep the event loop alive. */
function defaultScheduleEscalation(
  onExpire: () => void,
  timeoutMs: number,
): EscalationTimer {
  const handle = setTimeout(onExpire, timeoutMs);
  if (typeof handle.unref === 'function') handle.unref();
  return { cancel: () => clearTimeout(handle) };
}

/** No-op default {@link InstallSignalHandlersOptions.onError}. */
function noop(): void {
}

/**
 * Default {@link SignalRegistrar} over `process`. Only production touches the real `process.on` and `process.off`.
 * `process` ignores the promise that the listener returns, and the listener catches its own errors.
 */
function processSignalRegistrar(): SignalRegistrar {
  return {
    add(signal, listener) {
      process.on(signal, listener as (received: NodeJS.Signals) => void);
    },
    remove(signal, listener) {
      process.off(signal, listener as (received: NodeJS.Signals) => void);
    },
  };
}

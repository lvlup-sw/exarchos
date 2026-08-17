/**
 * Launcher signal handling + orphan prevention (DR-6).
 *
 * The harness launcher is a long-lived process SUPERVISOR: it spawns an agent
 * harness as a child into its top-level worktree and owns that child's full
 * lifecycle. When the operator (or the OS) interrupts the launcher with a
 * *catchable* signal — `SIGINT` (Ctrl-C) or `SIGTERM` (`kill`) — the launcher
 * must not just die and leave the child running detached, reparented to init.
 * It must:
 *
 *   1. **Forward** the terminating signal to the child, so the child tears down
 *      *with* the launcher rather than surviving as an orphan.
 *   2. **Emit the guaranteed `launch.executed` terminal** through the idempotent
 *      Task-006 seam ({@link liveness.emitLaunchExecuted}, injected here as
 *      {@link EmitTerminalFn}) — FIRST, before the reap, so a slow / ignoring
 *      child can never block it. This is the DR-6 "every catchable exit" contract
 *      asserted ON the signal path — NOT deferred to the Task-016
 *      uncatchable-death (`SIGKILL`/host-death) reconciler.
 *   3. **Reap** the child (await its exit) so THIS parent collects it — proof it
 *      is never left detached / reparented.
 *   4. **Guarantee teardown** runs on parent interruption (release / recovery —
 *      owned by the injected {@link SignalTeardown}; task 012 extends it), AFTER
 *      the reap: teardown's occupancy probe must see the child already collected,
 *      else the still-exiting child is counted as occupying its OWN reserved
 *      worktree and the release is withheld, leaving the reservation to linger
 *      until the next GC (#1634). Reaping before teardown mirrors the normal-exit
 *      path (observe → teardown) so both exit routes release promptly.
 *
 * ## Installable, self-contained seam
 *
 * This module is a self-contained seam that PLUGS IN to the lifecycle core
 * ({@link lifecycle-core.runLifecycle}) without reshaping it: the integrator
 * hands it the live {@link SignalChild}, its guaranteed-once `teardown`, and a
 * pre-bound `emitTerminal` closure over the Task-006 seam, and receives an
 * **uninstaller** it calls once the child has exited so no handler outlives the
 * launch. The `process`-level signal registration is itself an injectable seam
 * ({@link SignalRegistrar}) so tests drive the trap deterministically without
 * touching the real test-runner process.
 *
 * ## Idempotent under a double signal
 *
 * The trap body is memoized ({@link once}): a second `SIGINT`/`SIGTERM` (or a
 * `SIGINT` then `SIGTERM`) collapses onto the first invocation's promise, so the
 * forward + teardown + terminal each fire AT MOST ONCE. The terminal
 * additionally rides the idempotent `emitLaunchExecuted` seam, so even a teardown
 * path that ALSO fired the terminal (tasks 010/012) can never persist a second
 * `launch.executed` row.
 */

import type { ChildHandle } from '../../utils/process.js';
import type { EmitLaunchExecutedResult } from './liveness.js';

// ============================================================
// Trapped-signal vocabulary
// ============================================================

/** The catchable signals the launcher traps + forwards (DR-6). */
export type TrappedSignal = 'SIGINT' | 'SIGTERM';

/** The default trap set: `SIGINT` (Ctrl-C) + `SIGTERM` (`kill`). */
export const DEFAULT_TRAPPED_SIGNALS: readonly TrappedSignal[] = ['SIGINT', 'SIGTERM'];

// ============================================================
// Injectable seam types
// ============================================================

/**
 * The minimal view of the supervised child the signal path needs: `kill` to
 * forward the terminating signal (orphan prevention) and `exit` to reap it.
 * `node:child_process`'s child (via {@link ChildHandle}) satisfies this
 * structurally — deliberately NOT the raw streams.
 */
export type SignalChild = Pick<ChildHandle, 'kill' | 'exit'>;

/**
 * Teardown to guarantee-run on parent interruption. Called with the trapped
 * signal; runs AT MOST ONCE across a double signal. Owns its own release /
 * recovery / `recoveryError` semantics (task 012 extends it) — this module only
 * guarantees it is *reached* on every catchable signal.
 */
export type SignalTeardown = (signal: TrappedSignal) => void | Promise<void>;

/**
 * The guaranteed-terminal emitter — a closure the integrator pre-binds over the
 * idempotent Task-006 {@link liveness.emitLaunchExecuted} seam (the launch's
 * `worktreeId` + `exitCode: null`, since a signal-terminated child has no exit
 * code). Called on the signal path so `launch.executed` lands on EVERY catchable
 * exit. At-most-once is guaranteed by the seam regardless of double invocation.
 */
export type EmitTerminalFn = () => Promise<EmitLaunchExecutedResult>;

/**
 * Signal-registration seam over `process.on`/`process.off`. Injected in tests so
 * the trap is driven deterministically (a captured listener invoked directly),
 * never by delivering a real signal to the test-runner process. Defaults to a
 * thin adapter over `process` ({@link processSignalRegistrar}).
 */
export interface SignalRegistrar {
  add(signal: TrappedSignal, listener: SignalListener): void;
  remove(signal: TrappedSignal, listener: SignalListener): void;
}

/** A registered signal listener; may run async (the trap body is async). */
export type SignalListener = (signal: TrappedSignal) => void | Promise<void>;

/** A cancellable handle over the SIGTERM→SIGKILL escalation timer (DR-6 / R-5). */
export interface EscalationTimer {
  /** Cancel the pending escalation (called the moment the child reaps on its own). */
  cancel(): void;
}

/**
 * Schedules the SIGTERM→SIGKILL escalation timer. Injected so a test drives the
 * escalation deterministically (invoke `onExpire` synchronously) instead of
 * waiting a real {@link DEFAULT_KILL_TIMEOUT_MS}. Defaults to an unref'd
 * `setTimeout` ({@link defaultScheduleEscalation}) so it never keeps the event
 * loop alive on its own.
 */
export type ScheduleEscalation = (
  onExpire: () => void,
  timeoutMs: number,
) => EscalationTimer;

/** Default grace period (ms) before a child that ignores the forwarded signal is SIGKILL'd. */
export const DEFAULT_KILL_TIMEOUT_MS = 10_000;

// ============================================================
// Install options
// ============================================================

/** Dependencies for {@link installSignalHandlers}. */
export interface InstallSignalHandlersOptions {
  /** The live supervised child to forward the terminating signal to + reap. */
  readonly child: SignalChild;
  /** Guaranteed-on-interruption teardown seam (runs at most once). */
  readonly teardown: SignalTeardown;
  /** The idempotent Task-006 `launch.executed` terminal emitter, pre-bound. */
  readonly emitTerminal: EmitTerminalFn;
  /** Signal-registration seam; defaults to a `process` adapter. */
  readonly signals?: SignalRegistrar;
  /** Signals to trap; defaults to {@link DEFAULT_TRAPPED_SIGNALS}. */
  readonly trap?: readonly TrappedSignal[];
  /**
   * Best-effort observer for a teardown/terminal failure on the signal path.
   * Signal handlers must never reject (an unhandled rejection on `process`), so
   * the trap body funnels any error here instead. Defaults to a no-op.
   */
  readonly onError?: (error: unknown, signal: TrappedSignal) => void;
  /**
   * Grace period (ms) after the forwarded signal before a child that has NOT
   * exited is escalated to `SIGKILL`, so a child that ignores or slow-handles the
   * signal can never hang the launcher's reap (DR-6 / R-5). Defaults to
   * {@link DEFAULT_KILL_TIMEOUT_MS}.
   */
  readonly killTimeoutMs?: number;
  /**
   * The escalation-timer scheduler; defaults to {@link defaultScheduleEscalation}
   * (an unref'd `setTimeout`). Injected so a test fires the SIGKILL escalation
   * deterministically without a real wall-clock wait.
   */
  readonly scheduleEscalation?: ScheduleEscalation;
}

// ============================================================
// Install
// ============================================================

/**
 * Trap `SIGINT`/`SIGTERM`, forward each to the supervised child, guarantee
 * teardown + the idempotent `launch.executed` terminal, and reap the child — so
 * no orphaned/detached child survives a catchable interruption of the launcher
 * (DR-6). Returns an **uninstaller** that detaches the handlers; the integrator
 * calls it once the launch is over, so nothing outlives the child.
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

  // The guaranteed-once trap body: forward → terminal → reap → teardown. Memoized
  // so a double signal (or a SIGINT then SIGTERM) collapses to ONE run.
  const runOnce = once(async (signal: TrappedSignal): Promise<void> => {
    // (1) Forward the terminating signal to the child FIRST — orphan prevention.
    //     A well-behaved child receives SIGINT/SIGTERM and exits WITH the
    //     launcher, never left detached / reparented to init.
    child.kill(signal);
    try {
      // (2) Emit the GUARANTEED `launch.executed` terminal via the idempotent
      //     Task-006 seam — the DR-6 "every catchable exit" contract asserted on
      //     the signal path. Emitted FIRST, BEFORE the reap, so a child that
      //     ignores / slow-handles the forwarded signal can never block the
      //     terminal. Idempotent, so teardown's own terminal emit later collapses
      //     onto this one — never a second `launch.executed` row.
      await emitTerminal();
    } finally {
      try {
        // (3) Reap the child so THIS parent collects it — the proof it is not
        //     orphaned / detached — but NEVER hang: a child that ignores or
        //     slow-handles the forwarded signal is escalated to SIGKILL after
        //     `killTimeoutMs`, then reaped.
        await reapWithEscalation(child, killTimeoutMs, scheduleEscalation);
      } finally {
        // (4) Teardown runs AFTER the reap (#1634): the release path's occupancy
        //     probe must see the child ALREADY collected, else the still-exiting
        //     child is counted as occupying its own reserved worktree and the
        //     release is withheld — leaving the reservation to linger until the
        //     next GC. Reaping first mirrors the normal-exit path (observe →
        //     teardown); the teardown seam owns its own release/recoveryError
        //     semantics (best-effort here).
        await teardown(signal);
      }
    }
  });

  // The registered listener never rejects: signal handlers on `process` must not
  // surface an unhandled rejection, so failures funnel to `onError`.
  const listener: SignalListener = (signal) =>
    runOnce(signal).catch((error: unknown) => {
      onError(error, signal);
    });

  for (const signal of trapped) {
    registrar.add(signal, listener);
  }

  // Uninstaller: detach every handler so no signal trap outlives the launch.
  let uninstalled = false;
  return () => {
    if (uninstalled) return;
    uninstalled = true;
    for (const signal of trapped) {
      registrar.remove(signal, listener);
    }
  };
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Memoize a single-argument async body so it runs AT MOST ONCE: the first call
 * records the promise; every later call returns that same promise (its argument
 * ignored). This is the double-signal-collapses-to-one guard.
 */
function once<A>(body: (arg: A) => Promise<void>): (arg: A) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (arg) => (pending ??= body(arg));
}

/**
 * Reap the child, escalating to `SIGKILL` if it does not exit within `timeoutMs`
 * of the forwarded signal (DR-6 / R-5). Races `child.exit` against the injected
 * escalation timer: a clean exit cancels the timer; on expiry a `SIGKILL` is
 * delivered and the now-terminating child is awaited, so the supervisor can never
 * block forever on a child that ignores/slow-handles the original signal.
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
  // Cancel the pending timer the instant the child exits on its own, so the
  // escalation never fires (and never keeps the event loop alive) after a reap.
  void child.exit.then(() => timer?.cancel());

  const outcome = await Promise.race([exited, escalated]);
  if (outcome === 'escalate') {
    // The child ignored/slow-handled the forwarded signal — force it down and
    // await the guaranteed termination so this parent still collects it.
    child.kill('SIGKILL');
    await child.exit;
  }
}

/**
 * Default {@link ScheduleEscalation}: an unref'd `setTimeout`, so a pending
 * escalation never keeps the event loop alive on its own (it is always cancelled
 * on a clean exit anyway).
 */
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
  /* intentionally empty */
}

/**
 * Default {@link SignalRegistrar} over `process`. Kept behind the seam so the
 * real `process.on`/`process.off` is only ever touched in production, never in
 * unit tests. The listener returns a promise (the async trap body); `process`
 * ignores the return value, and the trap body already swallows its own errors.
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

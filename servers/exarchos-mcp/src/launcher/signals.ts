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
 *   2. **Guarantee teardown** runs on parent interruption (release / recovery —
 *      owned by the injected {@link SignalTeardown}; task 012 extends it).
 *   3. **Emit the guaranteed `launch.executed` terminal** through the idempotent
 *      Task-006 seam ({@link liveness.emitLaunchExecuted}, injected here as
 *      {@link EmitTerminalFn}). This is the DR-6 "every catchable exit" contract
 *      asserted ON the signal path — NOT deferred to the Task-016
 *      uncatchable-death (`SIGKILL`/host-death) reconciler.
 *   4. **Reap** the child (await its exit) so THIS parent collects it — proof it
 *      is never left detached / reparented.
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

import type { ChildHandle, SpawnExit } from '../utils/process.js';
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

  // The guaranteed-once trap body: forward → teardown → terminal → reap. Memoized
  // so a double signal (or a SIGINT then SIGTERM) collapses to ONE run.
  const runOnce = once(async (signal: TrappedSignal): Promise<void> => {
    // (1) Forward the terminating signal to the child FIRST — orphan prevention.
    //     A well-behaved child receives SIGINT/SIGTERM and exits WITH the
    //     launcher, never left detached / reparented to init.
    child.kill(signal);
    try {
      // (2) Guarantee teardown runs on parent interruption (best-effort; the
      //     teardown seam owns its own release/recoveryError semantics).
      await teardown(signal);
    } finally {
      // (3) Emit the GUARANTEED `launch.executed` terminal via the idempotent
      //     Task-006 seam — the DR-6 "every catchable exit" contract asserted on
      //     the signal path. In a `finally` so it fires even if teardown threw,
      //     and BEFORE the reap so a slow child never blocks the terminal.
      await emitTerminal();
    }
    // (4) Reap the child: await its exit so THIS parent collects it — the proof
    //     it is not orphaned / detached. Done last so it cannot delay the
    //     terminal; deterministic under a well-behaved (or faked) child.
    await reap(child.exit);
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

/** Await the child's exit for reaping; the outcome itself is not needed here. */
async function reap(exit: Promise<SpawnExit>): Promise<void> {
  await exit;
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

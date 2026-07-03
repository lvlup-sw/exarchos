// ─── Production launcher wiring — compose the built modules into live deps ───
//
// The `exarchos <harness>` CLI verb owns a real child's lifecycle, but the verb
// and lifecycle core are deliberately DI-only: they accept an event-store
// substrate + spawn/teardown/signal seams and never construct them. Without a
// production wiring point, a real non-dry-run launch has no `lifecycleDeps` and
// falls through to the structured `NOT_WIRED` result (spawns nothing).
//
// This module IS that wiring point (INV-2 — behavior lives in the built modules;
// this only composes them):
//
//   - {@link makeLauncherLifecycleDeps} builds a {@link RunLifecycleDeps} over a
//     live {@link DispatchContext} (the `eventStore` append substrate), binding:
//       * the guaranteed teardown-safety seam ({@link makeLifecycleTeardown}) —
//         releases the `worktree.reserved` reservation, fail-closes a non-git /
//         unreachable-origin target, and NEVER `git reset --hard`s (DR-6);
//       * the signal-install seam ({@link installSignalHandlers}) — a trapped
//         SIGINT/SIGTERM is forwarded to the child, teardown + the guaranteed
//         terminal run, and the child is reaped, so no orphan survives a
//         catchable interruption of the launcher (DR-6).
//     The reservation `owner` handed to teardown is the SAME holder identity the
//     lifecycle reserves the worktree under (`holderPid` + `holderStartedAt`), so
//     the teardown release is a CLEAN same-owner relinquish (INV-14).
//   - {@link recoverBeforeLaunch} runs the crash-mid-spawn reconciler
//     ({@link recoverCrashedLaunch}) as a best-effort self-heal at launcher
//     startup: it finishes any half-created worktree and reclaims a prior crashed
//     launcher's now-dead reservation, so no orphaned half-created worktree
//     escapes a subsequent launch (DR-6). Failures never block a launch.
//
// Every seam is overridable via {@link LauncherWiringOverrides} so the CLI-surface
// tests inject an OS-effect fake (spawn / signal registrar / recovery) at the
// production boundary WITHOUT re-implementing the wiring the verb runs. This
// module contains NO per-harness branching (DR-4): every per-harness difference
// stays in the declarative descriptors the registry resolves.
// ─────────────────────────────────────────────────────────────────────────────

import type { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import {
  makeLifecycleTeardown,
  recoverCrashedLaunch,
  type RecoverCrashedLaunchDeps,
} from './teardown.js';
import { installSignalHandlers, type SignalRegistrar, type ScheduleEscalation } from './signals.js';
import type {
  RunLifecycleDeps,
  InstallSignals,
  LifecycleTeardown,
  SpawnHarnessChildFn,
} from './lifecycle-core.js';
import {
  defaultProcessSource,
  type ProcessSource,
} from '../orchestrate/worktree/pure/process-identity.js';
import type { GitRunner, ReservationOwner } from '../orchestrate/worktree/manager.js';
import type { ProcessTableSource } from '../orchestrate/worktree/pure/probe.js';
import type { RealpathResolver } from '../orchestrate/worktree/pure/path-containment.js';
import type { CreateLauncherWorktreeDeps } from './create-worktree.js';

/**
 * A launcher startup-recovery pass — the crash-mid-spawn self-heal run before a
 * launch. Defaults to {@link recoverCrashedLaunch}; injectable so a test observes
 * or stubs it deterministically.
 */
export type StartupRecover = (
  eventStore: EventStore,
  repoRoot: string,
) => Promise<unknown>;

/**
 * OS-effect / advanced-caller overrides for the production launcher wiring. Every
 * field is a DI seam — production callers omit them all so the real spawn / git /
 * process-table / signal seams are wired; the CLI-surface tests inject fakes HERE
 * so they exercise the real composition without touching the host OS. Kept out of
 * any user-facing flag surface.
 */
export interface LauncherWiringOverrides {
  /**
   * Base worktree the launcher worktree is derived off (sibling root), passed to
   * the verb as `deps.base`. Defaults to `process.cwd()` at the call site.
   */
  readonly base?: string;
  /** Repo root `git worktree add` runs from. Defaults to the base worktree. */
  readonly repoRoot?: string;
  /** New branch for the created worktree (`git worktree add -b`). Omit to let git derive it. */
  readonly newBranch?: string;
  /** Start-point commit-ish for the created worktree. */
  readonly startPoint?: string;
  /** Supervisor holder PID (liveness CLAIM + reservation owner). Defaults to `process.pid`. */
  readonly holderPid?: number;
  /** Supervisor create-time fingerprint. Defaults to a probed value (defeats PID reuse). */
  readonly holderStartedAt?: string;
  /** Process-identity source for the holder start-time probe. Defaults to the OS source. */
  readonly processSource?: ProcessSource;
  /** Async harness-spawn primitive. Defaults to the real `spawnHarnessChild`. */
  readonly spawnChild?: SpawnHarnessChildFn;
  /** Extra create-worktree seams (git runner / guard / realpath). */
  readonly createDeps?: CreateLauncherWorktreeDeps;
  /** Git runner for the teardown non-git / origin safety gate. Defaults to the real runner. */
  readonly gitRunner?: GitRunner;
  /** Symlink-resolver for teardown occupancy containment. Defaults to the real realpath. */
  readonly realpath?: RealpathResolver;
  /** Ground-truth process table for the teardown cwd-drift in-use probe. Defaults to the OS source. */
  readonly processTableSource?: ProcessTableSource;
  /** Signal-registration seam (`process.on`/`off`). Injected so tests drive the trap deterministically. */
  readonly signalRegistrar?: SignalRegistrar;
  /** Grace period (ms) before a non-exiting child is escalated to SIGKILL. */
  readonly killTimeoutMs?: number;
  /** SIGTERM→SIGKILL escalation-timer scheduler. Injected so tests fire escalation without a wall-clock wait. */
  readonly scheduleEscalation?: ScheduleEscalation;
  /** FULL signal-install override (bypasses the real installer entirely). */
  readonly installSignals?: InstallSignals;
  /** Startup crash-recovery override (bypasses the real {@link recoverCrashedLaunch}). */
  readonly recover?: StartupRecover;
}

/**
 * Build the production {@link RunLifecycleDeps} over a live {@link DispatchContext}.
 *
 * Wires the fail-closed teardown seam and the real signal-install seam (see the
 * module header). The reservation `owner` handed to teardown mirrors the holder
 * identity the lifecycle reserves under, so the release is a clean same-owner
 * relinquish. Overrides substitute individual OS seams for deterministic tests.
 */
export function makeLauncherLifecycleDeps(
  ctx: DispatchContext,
  overrides: LauncherWiringOverrides = {},
): RunLifecycleDeps {
  const processSource = overrides.processSource ?? defaultProcessSource;
  const holderPid = overrides.holderPid ?? process.pid;
  const holderStartedAt =
    overrides.holderStartedAt ?? resolveStartedAt(holderPid, processSource);
  const owner: ReservationOwner = { ownerPid: holderPid, ownerStartedAt: holderStartedAt };

  // ── R-3: fail-closed teardown — release the reservation (clean same-owner),
  //     fail-close a non-git / unreachable-origin target, never `reset --hard`. ──
  const teardown: LifecycleTeardown = makeLifecycleTeardown({
    owner,
    selfPid: holderPid,
    ...(overrides.gitRunner ? { gitRunner: overrides.gitRunner } : {}),
    ...(overrides.realpath ? { realpath: overrides.realpath } : {}),
    ...(overrides.processTableSource
      ? { processTableSource: overrides.processTableSource }
      : {}),
  });

  // ── R-2: install the real signal handlers over the live child right after
  //     spawn — forward SIGINT/SIGTERM, teardown + guaranteed terminal, reap. ──
  const installSignals: InstallSignals =
    overrides.installSignals ??
    ((sigCtx) =>
      installSignalHandlers({
        child: sigCtx.child,
        teardown: sigCtx.teardown,
        emitTerminal: sigCtx.emitTerminal,
        ...(overrides.signalRegistrar ? { signals: overrides.signalRegistrar } : {}),
        ...(overrides.killTimeoutMs !== undefined
          ? { killTimeoutMs: overrides.killTimeoutMs }
          : {}),
        ...(overrides.scheduleEscalation
          ? { scheduleEscalation: overrides.scheduleEscalation }
          : {}),
      }));

  return {
    ctx,
    holderPid,
    holderStartedAt,
    processSource,
    teardown,
    installSignals,
    ...(overrides.spawnChild ? { spawnChild: overrides.spawnChild } : {}),
    ...(overrides.newBranch !== undefined ? { newBranch: overrides.newBranch } : {}),
    ...(overrides.startPoint !== undefined ? { startPoint: overrides.startPoint } : {}),
    ...(overrides.repoRoot !== undefined ? { repoRoot: overrides.repoRoot } : {}),
    ...(overrides.createDeps ? { createDeps: overrides.createDeps } : {}),
  };
}

/**
 * Best-effort crash-mid-spawn self-heal, run at launcher startup before a real
 * launch (DR-6 / R-4). Finishes any half-created worktree and reclaims a prior
 * crashed launcher's now-dead reservation via {@link recoverCrashedLaunch}, so no
 * orphaned half-created worktree escapes the upcoming launch. A recovery failure
 * is swallowed — self-heal must NEVER block a launch.
 */
export async function recoverBeforeLaunch(
  ctx: DispatchContext,
  repoRoot: string,
  overrides: LauncherWiringOverrides = {},
): Promise<void> {
  const recover = overrides.recover ?? defaultStartupRecover(overrides);
  try {
    await recover(ctx.eventStore, repoRoot);
  } catch {
    // Self-heal is best-effort: a recovery failure must never block a launch.
  }
}

// ─── Internal ────────────────────────────────────────────────────────────────

/** Bind {@link recoverCrashedLaunch} with the override-derived recovery deps. */
function defaultStartupRecover(overrides: LauncherWiringOverrides): StartupRecover {
  return (eventStore, repoRoot) =>
    recoverCrashedLaunch(eventStore, repoRoot, buildRecoverDeps(overrides));
}

/** Assemble {@link RecoverCrashedLaunchDeps} from the wiring overrides. */
function buildRecoverDeps(overrides: LauncherWiringOverrides): RecoverCrashedLaunchDeps {
  return {
    ...(overrides.gitRunner ? { gitRunner: overrides.gitRunner } : {}),
    ...(overrides.realpath ? { realpath: overrides.realpath } : {}),
    ...(overrides.holderPid !== undefined ? { selfPid: overrides.holderPid } : {}),
  };
}

/**
 * Probe a process's create-time via the injected source; `null` (NEVER the empty
 * string `''`) when the platform cannot resolve it. `null` threads cleanly
 * through the launcher's null-ready `holderStartedAt` claim contract
 * (`z.string().min(1).nullable()`), whereas `''` would be the `''`-vs-`.min(1)`
 * invalid-raw-event class. Mirrors `merge-serializer`'s `resolveSelfStartedAt`.
 */
function resolveStartedAt(pid: number, source: ProcessSource): string | null {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' ? probe.startedAt : null;
}

/**
 * Production wiring for the launcher. It composes the built modules into live deps.
 *
 * The `exarchos <harness>` verb and the lifecycle core accept their event store and
 * their spawn, teardown and signal seams as deps, and never construct them.
 * Without this wiring, a real launch has no `lifecycleDeps` and returns `NOT_WIRED`.
 * This module holds no behavior of its own and no per-harness branch.
 * {@link LauncherWiringOverrides} lets the CLI-surface tests inject OS-effect fakes
 * into the same composition that the verb runs.
 */

import type { EventStore } from '../../events/store.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import { launcherLogger } from '../../logger.js';
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
} from '../../verbs/worktree/pure/process-identity.js';
import type { GitRunner, ReservationOwner } from '../../verbs/worktree/manager.js';
import type { ProcessTableSource } from '../../verbs/worktree/pure/probe.js';
import type { RealpathResolver } from '../../verbs/worktree/pure/path-containment.js';
import type { CreateLauncherWorktreeDeps } from './create-worktree.js';

/**
 * The crash recovery pass that runs before a launch. It defaults to
 * {@link recoverCrashedLaunch}. A test can inject a stub.
 */
export type StartupRecover = (
  eventStore: EventStore,
  repoRoot: string,
) => Promise<unknown>;

/**
 * Overrides for the production launcher wiring. Production callers omit all fields,
 * so the real spawn, git, process-table and signal seams are wired.
 * The CLI-surface tests inject fakes here to run the real composition without host OS effects.
 * No user-facing flag sets these fields.
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
 * The teardown seam releases the `worktree.reserved` reservation, fails closed on a
 * non-git or unreachable-origin target, and never runs `git reset --hard`.
 * Its `owner` is the same holder identity that the lifecycle reserves under, so the release is a same-owner release.
 * The signal seam forwards SIGINT and SIGTERM to the child, runs teardown, emits the terminal event, and reaps the child.
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

  const teardown: LifecycleTeardown = makeLifecycleTeardown({
    owner,
    selfPid: holderPid,
    ...(overrides.gitRunner ? { gitRunner: overrides.gitRunner } : {}),
    ...(overrides.realpath ? { realpath: overrides.realpath } : {}),
    ...(overrides.processTableSource
      ? { processTableSource: overrides.processTableSource }
      : {}),
  });

  const installSignals: InstallSignals =
    overrides.installSignals ??
    ((sigCtx) =>
      installSignalHandlers({
        child: sigCtx.child,
        teardown: sigCtx.teardown,
        emitTerminal: sigCtx.emitTerminal,
        onError: (error: unknown, signal) =>
          launcherLogger.error({ err: error, signal, holderPid }, 'signal-path teardown/terminal failed'),
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
 * Best-effort crash recovery at launcher startup, before a real launch.
 * {@link recoverCrashedLaunch} finishes a half-created worktree and reclaims the
 * reservation of a dead launcher. The function ignores a recovery failure, so recovery never blocks a launch.
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
  }
}

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
 * Probe the create time of a process through the injected source. Return `null`,
 * never `''`, when the platform cannot resolve it. The `holderStartedAt` claim schema
 * is `z.string().min(1).nullable()`, so `''` makes an invalid event.
 */
function resolveStartedAt(pid: number, source: ProcessSource): string | null {
  const probe = source.getStartTime(pid);
  return probe.status === 'present' ? probe.startedAt : null;
}

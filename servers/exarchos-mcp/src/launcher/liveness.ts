/**
 * Launcher child-process liveness emitters (DR-2).
 *
 * The harness launcher spawns a child process into its top-level, task-less
 * worktree; this module owns the two appends that bracket that child's lifetime
 * on the singleton `worktrees` stream, and that the `worktrees@v1` reducer folds
 * onto the launcher worktree entry (keyed by `worktreeId`):
 *
 *   1. {@link emitLaunchExecutingStarted} — the CLAIM. Appends
 *      `launch.executing_started` (`worktreeId` + supervisor `holderPid` +
 *      `holderStartedAt`) BEFORE the child is observed as terminated, so a
 *      long-running launch is observable as "started but not yet terminated".
 *   2. {@link emitLaunchExecuted} — the guaranteed-terminal, AT-MOST-ONCE seam.
 *      Appends `launch.executed` (`worktreeId` + `exitCode`) exactly once per
 *      launch even when called from BOTH a signal path and a teardown path (the
 *      lifecycle/teardown/signal work in tasks 010/011/012 calls it on every
 *      catchable exit). The terminal is what clears the reducer's in-flight
 *      marker, so a permanent launch phantom cannot survive a real exit.
 *
 * Both appends key their idempotency off the `worktreeId` — the launch's
 * canonical `worktrees@v1` identity and the `LaunchExecutedData` correlator (the
 * terminal carries no `operationId`). A launcher worktree is created once per
 * launch (`create-worktree.ts`), so one `worktreeId` maps to one launch and is a
 * sound at-most-once correlator.
 *
 * ## At-most-once terminal (INV-7)
 *
 * {@link emitLaunchExecuted} both (a) pre-checks the stream for an existing
 * terminal and short-circuits — the clean detectable `appended: false` signal a
 * teardown path reads to know a signal path already fired — AND (b) appends
 * under the `launch.executed:<worktreeId>` idempotency key, which is the ATOMIC
 * backstop: two concurrent callers that both pass the pre-check still collapse to
 * a single persisted row (the event-store's idempotency cache-hit), closing the
 * TOCTOU window the pre-check alone cannot. The row-count guarantee rides on the
 * key; the pre-check is the short-circuit + signal.
 */

import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';
import { withStateRetry } from '../workflow/state-retry.js';
import { WORKTREES_STREAM } from '../orchestrate/worktree/manager.js';

/** The launcher child-process liveness CLAIM (INV-10 `<surface>.executing_started`). */
export const LAUNCH_EXECUTING_STARTED = 'launch.executing_started';
/** The launcher child-process liveness TERMINAL, paired to the CLAIM by `worktreeId`. */
export const LAUNCH_EXECUTED = 'launch.executed';

/** Arguments for {@link emitLaunchExecutingStarted}. */
export interface EmitLaunchExecutingStartedInput {
  /** Canonical `worktrees@v1` key of the launch top-level worktree. */
  readonly worktreeId: string;
  /** PID of the launcher/supervisor process holding the launch — the long-lived
   * process that owns the child and writes the terminal (task-016 dead-holder anchor). */
  readonly holderPid: number;
  /**
   * Supervisor process start time (ISO 8601) — disambiguates PID reuse. `null`
   * (NEVER `''`) when the platform cannot resolve create-time, honoring the
   * null-ready `LaunchExecutingStartedData.holderStartedAt` schema contract.
   */
  readonly holderStartedAt: string | null;
}

/** Arguments for {@link emitLaunchExecuted}. */
export interface EmitLaunchExecutedInput {
  /** Canonical `worktrees@v1` key of the launch top-level worktree (the terminal correlator). */
  readonly worktreeId: string;
  /** Child process exit code, or `null` when terminated by signal / not captured. */
  readonly exitCode: number | null;
}

/** Outcome of {@link emitLaunchExecuted} — whether THIS call wrote the terminal. */
export interface EmitLaunchExecutedResult {
  /**
   * `true` when this call appended the terminal; `false` when a terminal for
   * this `worktreeId` was already present (the idempotent short-circuit a second
   * signal/teardown caller observes). The at-most-once ROW guarantee holds
   * regardless — under a concurrent race both callers may see `true` yet the
   * idempotency key collapses them to a single persisted row.
   */
  readonly appended: boolean;
  /** The launch this terminal correlates to. */
  readonly worktreeId: string;
  /** The exit code carried on the terminal. */
  readonly exitCode: number | null;
}

/**
 * Emit the launcher liveness CLAIM: append `launch.executing_started` to the
 * singleton `worktrees` stream. Keyed by `worktreeId` so a re-emission for the
 * same launch (crash-resume) collapses to the original row.
 */
export async function emitLaunchExecutingStarted(
  eventStore: EventStore,
  input: EmitLaunchExecutingStartedInput,
): Promise<void> {
  await withStateRetry(() =>
    eventStore.append(
      WORKTREES_STREAM,
      {
        type: LAUNCH_EXECUTING_STARTED,
        data: {
          worktreeId: input.worktreeId,
          holderPid: input.holderPid,
          holderStartedAt: input.holderStartedAt,
          // DR-2 — canonical liveness instance key (launch: worktreeId).
          instanceId: input.worktreeId,
        },
      },
      { idempotencyKey: `${LAUNCH_EXECUTING_STARTED}:${input.worktreeId}` },
    ),
  );
}

/**
 * Emit the launcher liveness TERMINAL — the AT-MOST-ONCE seam every catchable
 * exit funnels through (tasks 010/011/012). Pre-checks for an existing
 * `launch.executed` on this `worktreeId` and short-circuits (`appended: false`);
 * otherwise appends `launch.executed` under the `launch.executed:<worktreeId>`
 * idempotency key so concurrent signal + teardown callers still persist ONE row.
 */
export async function emitLaunchExecuted(
  eventStore: EventStore,
  input: EmitLaunchExecutedInput,
): Promise<EmitLaunchExecutedResult> {
  const { worktreeId, exitCode } = input;
  if (await hasLaunchTerminal(eventStore, worktreeId)) {
    // A signal/teardown path already closed this launch — idempotent no-op.
    return { appended: false, worktreeId, exitCode };
  }
  await withStateRetry(() =>
    eventStore.append(
      WORKTREES_STREAM,
      {
        type: LAUNCH_EXECUTED,
        // DR-2 — canonical liveness instance key (launch: worktreeId), paired
        // to the `launch.executing_started` START by the same value.
        data: { worktreeId, exitCode, instanceId: worktreeId },
      },
      { idempotencyKey: `${LAUNCH_EXECUTED}:${worktreeId}` },
    ),
  );
  return { appended: true, worktreeId, exitCode };
}

/**
 * Whether a `launch.executed` terminal is already on the `worktrees` stream for
 * `worktreeId` — the pre-check short-circuit for the at-most-once terminal.
 */
async function hasLaunchTerminal(
  eventStore: EventStore,
  worktreeId: string,
): Promise<boolean> {
  const events = await eventStore.query(WORKTREES_STREAM);
  return events.some(
    (event) =>
      event.type === LAUNCH_EXECUTED &&
      eventStringField(event, 'worktreeId') === worktreeId,
  );
}

/** Read a string field off an event payload (`null` when absent / non-string). */
function eventStringField(event: WorkflowEvent, key: string): string | null {
  const value = event.data?.[key];
  return typeof value === 'string' ? value : null;
}

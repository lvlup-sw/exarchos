/**
 * The two liveness events that bracket the life of a launcher child process on the `worktrees` stream.
 * The `worktrees@v1` reducer folds both onto the launcher worktree entry, keyed by `worktreeId`.
 *
 *   1. {@link emitLaunchExecutingStarted} appends the claim before the child ends. Thus a long launch shows as started but not terminated.
 *   2. {@link emitLaunchExecuted} appends the terminal at most once. The terminal clears the in-flight marker, so no launch phantom survives a real exit.
 *
 * Both appends use `worktreeId` as the idempotency correlator, because the terminal has no `operationId`.
 * A launcher worktree is created once per launch, so one `worktreeId` maps to one launch.
 */

import type { EventStore } from '../../events/store.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { withStateRetry } from '../../workflow/state-retry.js';
import { WORKTREES_STREAM } from '../../verbs/worktree/manager.js';

/** The launcher child-process liveness claim, in the `<surface>.executing_started` form. */
export const LAUNCH_EXECUTING_STARTED = 'launch.executing_started';
/** The launcher child-process liveness TERMINAL, paired to the CLAIM by `worktreeId`. */
export const LAUNCH_EXECUTED = 'launch.executed';

/** Arguments for {@link emitLaunchExecutingStarted}. */
export interface EmitLaunchExecutingStartedInput {
  /** Canonical `worktrees@v1` key of the launch top-level worktree. */
  readonly worktreeId: string;
  /** PID of the supervisor process that holds the launch. It owns the child and writes the terminal. */
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
   * `true` when this call appended the terminal, and `false` when a terminal for this `worktreeId` was already present.
   * In a concurrent race both callers can see `true`, but the idempotency key still persists one row.
   */
  readonly appended: boolean;
  /** The launch this terminal correlates to. */
  readonly worktreeId: string;
  /** The exit code carried on the terminal. */
  readonly exitCode: number | null;
}

/**
 * Append the launcher liveness claim `launch.executing_started` to the `worktrees` stream.
 * The idempotency key comes from `worktreeId`, so a re-emission for the same launch after a crash gives no second row.
 * The `instanceId` field is the canonical liveness instance key.
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
          instanceId: input.worktreeId,
        },
      },
      { idempotencyKey: `${LAUNCH_EXECUTING_STARTED}:${input.worktreeId}` },
    ),
  );
}

/**
 * Append the launcher liveness terminal `launch.executed` at most once.
 * A pre-check returns `appended: false` when a terminal for this `worktreeId` exists. Thus a second teardown or signal caller sees that the launch is closed.
 * The `launch.executed:<worktreeId>` idempotency key is the atomic backstop. Two concurrent callers that pass the pre-check still persist one row.
 * The `instanceId` field pairs the terminal with its claim.
 */
export async function emitLaunchExecuted(
  eventStore: EventStore,
  input: EmitLaunchExecutedInput,
): Promise<EmitLaunchExecutedResult> {
  const { worktreeId, exitCode } = input;
  if (await hasLaunchTerminal(eventStore, worktreeId)) {
    return { appended: false, worktreeId, exitCode };
  }
  await withStateRetry(() =>
    eventStore.append(
      WORKTREES_STREAM,
      {
        type: LAUNCH_EXECUTED,
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

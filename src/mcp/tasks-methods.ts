// RESERVED(issue: #1273, owner: exarchos, expires: 2027-01-31) — reserved dead stub. The module-intent gate fails at expiry if nobody adopts it.
//
// MCP `tasks/get`, `tasks/result`, `tasks/cancel`, and `tasks/follow` primitives over the
// event-sourced task store. The MCP SDK installs its own `tasks/*` handlers when the server
// gets a `TaskStore`, and those handlers stay the wire surface. These functions follow the
// same contract for callers outside the SDK. The request functions throw an `Error` on a
// contract violation, and the caller maps it to the error shape of its facade.

import type {
  V2Result as Result,
  V2Task as Task,
} from '../contract/sdk/seam.js';

import type { EventSourcedTaskStore } from '../projections/task-store/event-sourced-task-store.js';
import {
  runInspectFollow,
  type FollowSubscribe,
  type InspectFollowHandle,
} from '../cli/follow-loop.js';
import type { SubscriptionClock } from '../events/subscriptions.js';
import type { Frame } from '../ndjson/frames.js';

/**
 * `tasks/get`: returns the SDK `Task` for `taskId`, and throws when the task is
 * missing. The `getTask` call of the store can append a throttled `task.polled`
 * audit event.
 */
export async function tasksGet(
  store: EventSourcedTaskStore,
  taskId: string,
  sessionId?: string,
): Promise<Task> {
  const task = await store.getTask(taskId, sessionId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

/**
 * `tasks/result`: returns the stored final result for `taskId`. It throws when the
 * task is missing or has no result yet. A caller must call it only after `tasksGet`
 * reports a terminal status. For a tool-call task, the result is
 * `{ _toolResult: ToolResult }`.
 */
export async function tasksResult(
  store: EventSourcedTaskStore,
  taskId: string,
  sessionId?: string,
): Promise<Result> {
  return store.getTaskResult(taskId, sessionId);
}

/**
 * `tasks/cancel`: moves `taskId` to the terminal `cancelled` status and returns the
 * updated task. The store emits a durable `task.cancelled` event.
 *
 * It reads the task first, so a missing task gives a clear "not found" error. For a
 * task in a terminal status, the store error passes through, and its message contains
 * the word "terminal". If the task is gone after the cancel, as after a TTL sweep in
 * the same tick, it throws a separate "not found after cancellation" error.
 */
export async function tasksCancel(
  store: EventSourcedTaskStore,
  taskId: string,
  sessionId?: string,
): Promise<Task> {
  const existing = await store.getTask(taskId, sessionId);
  if (!existing) {
    throw new Error(`Task not found: ${taskId}`);
  }
  await store.updateTaskStatus(
    taskId,
    'cancelled',
    'Client cancelled task execution.',
    sessionId,
  );
  const updated = await store.getTask(taskId, sessionId);
  if (!updated) {
    throw new Error(`Task not found after cancellation: ${taskId}`);
  }
  return updated;
}

export interface TasksFollowOptions {
  /** Event subscription contract. */
  readonly subscribe: FollowSubscribe;
  /** Workflow to tail. */
  readonly featureId: string;
  /** Carrier sink — the MCP transport pushes each frame as a task update. */
  readonly onFrame: (frame: Frame) => void;
  /** Initial cursor (see {@link runInspectFollow}). */
  readonly fromSequence?: number;
  /** Injected heartbeat clock. */
  readonly clock?: SubscriptionClock;
  /** Idle heartbeat interval (ms). */
  readonly heartbeatIntervalMs?: number;
  /**
   * Optional external abort, such as a server teardown, that uses the same disposal
   * path as {@link TasksFollowHandle.cancel}.
   */
  readonly signal?: AbortSignal;
}

export interface TasksFollowHandle extends InspectFollowHandle {
  /**
   * Disposes the subscription and ends the frame stream through the abort path. It
   * is idempotent.
   */
  cancel(): void;
}

/**
 * `tasks/follow`: the MCP Tasks form of `inspect --follow` over the shared
 * `runInspectFollow` core. An internal `AbortController` joins `cancel` and the
 * external signal into one abort teardown. When the stream ends by any route, it
 * removes its listener from the external signal.
 */
export function tasksFollow(opts: TasksFollowOptions): TasksFollowHandle {
  const controller = new AbortController();
  const onExternalAbort = (): void => controller.abort();
  const externalSignal = opts.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const inner = runInspectFollow({
    subscribe: opts.subscribe,
    featureId: opts.featureId,
    fromSequence: opts.fromSequence,
    onFrame: opts.onFrame,
    signal: controller.signal,
    clock: opts.clock,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
  });

  if (externalSignal) {
    void inner.done.then(() => externalSignal.removeEventListener('abort', onExternalAbort));
  }

  return {
    done: inner.done,
    disposed: () => inner.disposed(),
    dispose: () => inner.dispose(),
    cancel: () => {
      controller.abort();
      inner.dispose();
    },
  };
}

/**
 * MCP `tasks/get` / `tasks/result` / `tasks/cancel` primitives
 * (#1273 / C2 T31).
 *
 * Thin functional layer over {@link EventSourcedTaskStore} so the MCP
 * adapter and the CLI `--follow` polling loop (C3) share ONE code path
 * per method (INV-2 facade equivalence). The MCP SDK auto-installs its
 * own `setRequestHandler` for `tasks/*` when a `TaskStore` is supplied
 * to the server constructor (see
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js`);
 * that wiring stays as the authoritative on-wire surface — these
 * primitives mirror the same SDK contract so non-MCP callers (CLI
 * follow loop, unit tests, future REST gateway) can drive the same
 * lifecycle without re-implementing the projection rules.
 *
 * Each function throws an `Error` on contract violation (missing task,
 * terminal-cancellation, etc.); callers map to their facade's idiomatic
 * surface — `McpError(InvalidParams, ...)` for MCP, a structured
 * INVALID_INPUT envelope for the CLI.
 */

// RESERVED(issue: #1273, owner: exarchos, expires: 2027-01-31) — reserved dead stub; deletion at expiry if unadopted (DR-7 module-intent gate)

import type {
  Result,
  Task,
} from '@modelcontextprotocol/sdk/types.js';

import type { EventSourcedTaskStore } from '../task-store/event-sourced-task-store.js';
import {
  runInspectFollow,
  type FollowSubscribe,
  type InspectFollowHandle,
} from '../cli/follow-loop.js';
import type { SubscriptionClock } from '../event-store/subscriptions.js';
import type { Frame } from '../ndjson/frames.js';

/**
 * `tasks/get` — return the SDK `Task` projection for `taskId`. Mirrors
 * the SDK protocol handler's contract: throws when the task is missing
 * (the adapter maps to `InvalidParams`).
 *
 * Side-effect: emits a `task.polled` event on the namespaced stream
 * (handled inside the store's `getTask` for audit-trail completeness).
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
 * `tasks/result` — return the stored final result for `taskId`. Throws
 * when the task is missing or has no result yet (still `working` /
 * `input_required`). The caller-facing contract: only call after
 * `tasksGet(...).status` reports a terminal state.
 *
 * The returned `Result` is the same payload the synthesis surface
 * stamped via `storeTaskResult` — for tool-call tasks, that's
 * `{ _toolResult: ToolResult }` from `runTasksAugmented`. Consumers
 * unwrap as needed.
 */
export async function tasksResult(
  store: EventSourcedTaskStore,
  taskId: string,
  sessionId?: string,
): Promise<Result> {
  return store.getTaskResult(taskId, sessionId);
}

/**
 * `tasks/cancel` — transition `taskId` to the terminal `cancelled`
 * status. Emits a durable `task.cancelled` event on the namespaced
 * stream (handled inside the store's `updateTaskStatus`). Returns the
 * updated `Task` projection.
 *
 * Contract violations:
 *   - Missing task → throws (adapter maps to `InvalidParams`).
 *   - Task already in a terminal state → throws (the store enforces
 *     immutability of terminal transitions; the message contains the
 *     word "terminal" so callers can match on it without coupling to
 *     the exact text).
 */
export async function tasksCancel(
  store: EventSourcedTaskStore,
  taskId: string,
  sessionId?: string,
): Promise<Task> {
  // Read first so we can give a clean "not found" diagnostic without
  // relying on the store's `updateTaskStatus` to throw — it would, but
  // the wording is store-internal and may drift; explicit is clearer.
  const existing = await store.getTask(taskId, sessionId);
  if (!existing) {
    throw new Error(`Task not found: ${taskId}`);
  }
  // `updateTaskStatus` itself rejects terminal → terminal transitions
  // with a "terminal status" error message; we propagate that as-is.
  await store.updateTaskStatus(
    taskId,
    'cancelled',
    'Client cancelled task execution.',
    sessionId,
  );
  const updated = await store.getTask(taskId, sessionId);
  if (!updated) {
    // Defensive: cancellation followed by reaper sweep (TTL expiry on
    // the same tick) could remove the entry. Surface a recognizable
    // error so the adapter can degrade gracefully.
    throw new Error(`Task not found after cancellation: ${taskId}`);
  }
  return updated;
}

// ─── DR-4: MCP Tasks arm of `inspect --follow` ───────────────────────────────
//
// The Tasks facade of the streaming `inspect --follow` carrier. It drives the
// SAME `runInspectFollow` core (see `cli/follow-loop.ts`) over the SAME DR-1
// subscription contract the CLI NDJSON arm uses, so both facades stream
// byte-identical frames from one subscription (INV-2). The one facade-specific
// wire is cancellation: an MCP `tasks/cancel` disposes the subscription. This
// arm owns an internal `AbortController` so a single {@link TasksFollowHandle.cancel}
// call (invoked from the cancel path) folds into the carrier's abort teardown
// — subscription disposed, heartbeat cancelled, terminal `end` frame written.

export interface TasksFollowOptions {
  /** DR-1 subscription contract — the SAME one the CLI arm drives. */
  readonly subscribe: FollowSubscribe;
  /** Workflow to tail. */
  readonly featureId: string;
  /** Carrier sink — the MCP transport pushes each frame as a task update. */
  readonly onFrame: (frame: Frame) => void;
  /** Initial cursor (see {@link runInspectFollow}). */
  readonly fromSequence?: number;
  /** Injected heartbeat timer (INV-16). */
  readonly clock?: SubscriptionClock;
  /** Idle heartbeat interval (ms). */
  readonly heartbeatIntervalMs?: number;
  /**
   * Optional external abort (e.g. server teardown / session close) folded into
   * the same disposal path as {@link TasksFollowHandle.cancel}.
   */
  readonly signal?: AbortSignal;
}

export interface TasksFollowHandle extends InspectFollowHandle {
  /**
   * MCP `tasks/cancel` seam — dispose the underlying DR-1 subscription and end
   * the frame stream. Idempotent; mirrors the abort path exactly.
   */
  cancel(): void;
}

/**
 * `tasks/follow` — register the MCP Tasks arm of `inspect --follow` over the
 * DR-1 subscription. Returns a handle whose {@link TasksFollowHandle.cancel}
 * (wired from the `tasks/cancel` method) disposes the subscription.
 */
export function tasksFollow(opts: TasksFollowOptions): TasksFollowHandle {
  const controller = new AbortController();
  // Fold an external signal (server teardown) into the same abort the cancel
  // path uses, so there is ONE disposal route regardless of trigger.
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

  // When the carrier ends by ANY route (cancel / dispose / inner abort), drop the
  // external-signal listener so a long-lived server/session signal does not
  // retain it after this follow is gone (`{ once: true }` only covers the
  // abort-fired case). No new disposal route — purely leak hygiene.
  if (externalSignal) {
    void inner.done.then(() => externalSignal.removeEventListener('abort', onExternalAbort));
  }

  return {
    done: inner.done,
    disposed: () => inner.disposed(),
    dispose: () => inner.dispose(),
    cancel: () => {
      // task-cancel → subscription dispose. Abort drives the carrier's abort
      // teardown; the explicit dispose covers the (already-aborted) idempotent
      // case where the signal fired before this call.
      controller.abort();
      inner.dispose();
    },
  };
}

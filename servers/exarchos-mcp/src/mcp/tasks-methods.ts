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
import type {
  Result,
  Task,
} from '@modelcontextprotocol/sdk/types.js';

import type { EventSourcedTaskStore } from '../task-store/event-sourced-task-store.js';

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

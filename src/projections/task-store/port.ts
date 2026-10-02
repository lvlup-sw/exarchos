/**
 * The owned port for the Tasks store. The MCP SDK v2 packages have no server-side
 * Tasks runtime: no `TaskStore` seam and no `tasks/*` methods.
 *
 * `EventSourcedTaskStore` keeps its event-sourced persistence, because that half uses
 * the Exarchos `EventStore`. This port declares the store interface again. It does not
 * restore the `tasks/*` wire surface. `./attach.ts` reports that gap as `hostMustServe`.
 *
 * The port takes the payload types (`Task`, `Request`, `Result`, `RequestId`) as type
 * parameters, so it does not declare protocol shapes a second time. The module imports
 * nothing, so a package update cannot delete the contract.
 */

/** Task-creation parameters, with the same fields as `CreateTaskOptions` of the v1 SDK. */
export interface CreateTaskParams {
  /**
   * Milliseconds to keep the task available after completion. `null` means no limit.
   * When the field is absent, the store picks its own policy.
   */
  readonly ttl?: number | null;
  /** Milliseconds that a client waits between status polls. */
  readonly pollInterval?: number;
  /** Free-form context forwarded to the store. */
  readonly context?: Record<string, unknown>;
}

/**
 * The store contract: create a task, read its state, record its terminal result,
 * and list tasks. It has the same methods as `TaskStore` of the v1 SDK.
 *
 * @typeParam TTask      the task record of the protocol. Its only constraint is a `status`.
 * @typeParam TRequest   the request payload that started the task, stored as is
 * @typeParam TResult    the terminal result payload
 * @typeParam TRequestId the JSON-RPC correlation id
 */
export interface TaskStorePort<
  TTask extends { readonly status: string },
  TRequest,
  TResult,
  TRequestId,
> {
  /**
   * Creates a task. The implementation generates the id and the creation timestamp,
   * and it can clamp the requested `ttl`. The returned task holds the effective value.
   */
  createTask(
    taskParams: CreateTaskParams,
    requestId: TRequestId,
    request: TRequest,
    sessionId?: string,
  ): Promise<TTask>;

  /** Current state, or `null` when the task does not exist (or has expired). */
  getTask(taskId: string, sessionId?: string): Promise<TTask | null>;

  /** Record the terminal result. Only `completed` / `failed` carry a payload. */
  storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: TResult,
    sessionId?: string,
  ): Promise<void>;

  /** The stored result. Throws when the task is unknown or has no result yet. */
  getTaskResult(taskId: string, sessionId?: string): Promise<TResult>;

  /** Changes the status without a result payload, for example to `cancelled`. */
  updateTaskStatus(
    taskId: string,
    status: TTask['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void>;

  /** One page of tasks, plus an opaque cursor when more remain. */
  listTasks(
    cursor?: string,
    sessionId?: string,
  ): Promise<{ tasks: TTask[]; nextCursor?: string }>;
}

/** The statuses after which a task does not change again. */
export type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled';

/**
 * The terminal statuses as data, so tests can read the set. The array has a declared
 * type, not `as const`, because the cast ratchet counts each `as const`.
 *
 * @see TerminalTaskStatus
 */
export const TERMINAL_TASK_STATUSES: readonly TerminalTaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

const TERMINAL_LOOKUP: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES);

/**
 * True when the status is terminal. It agrees with `isTerminal` of the v1 SDK over
 * the statuses of `TaskStatusSchema` in v2.
 *
 * The parameter is `string`, and an unknown status is not terminal. A terminal answer
 * there blocks the record of results, and a throw fails the read of a durable event.
 * `TaskStoreSeam_TerminalStateQuery_MatchesV1Semantics` pins both properties.
 */
export function isTaskTerminal(status: string): boolean {
  return TERMINAL_LOOKUP.has(status);
}

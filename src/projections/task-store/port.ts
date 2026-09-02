/**
 * The OWNED Tasks-store port — the replacement for the SDK seam v2 deleted
 * (DR-0, task 051).
 *
 * ── What was actually lost, measured ────────────────────────────────────────
 * `@modelcontextprotocol/{core,server}@2.0.0` did not merely rename the
 * experimental Tasks store seam. It removed the **entire server-side Tasks
 * runtime**:
 *
 *   • `ServerOptions.taskStore` — gone. `TaskStore`, `CreateTaskOptions` and
 *     `isTerminal` have zero matches anywhere in either v2 package.
 *   • `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel` — a live v2
 *     `McpServer` answers all four with JSON-RPC `-32601` (Method not found),
 *     while `ping` on the same connection answers normally. Measured, not
 *     assumed; pinned by `TaskStoreSeam_V2Server_PreservesEventSourcedPersistence`.
 *   • v2's own protocol types carry the annotation
 *     `@deprecated 2025-11-25 wire vocabulary with no SDK runtime; kept
 *     importable for interoperability only` — the SDK itself says the Tasks
 *     types survive as vocabulary with nothing behind them.
 *
 * ── The distinction that makes the replacement possible ─────────────────────
 * `EventSourcedTaskStore`'s guarantee has TWO halves, and only one of them was
 * ever the SDK's:
 *
 *   1. **Event-sourced persistence** — every state-mutating call appends to
 *      `task-store/<taskId>` and every read folds that stream (INV-1). This is
 *      Exarchos's own `EventStore`. The SDK never participated in it, so v2
 *      cannot take it away. What the SDK *did* own was the `TaskStore`
 *      **interface** the class declared itself against — a type, not a
 *      behaviour. Re-declaring that type here loses nothing.
 *   2. **The `tasks/*` wire surface** — v1's SDK served it from the injected
 *      store for free. v2 serves nothing. That half is NOT restored by this
 *      module and must not be pretended away; see `./attach.ts`, which makes
 *      the gap a value (`hostMustServe`) instead of a silence.
 *
 * ── Why the port is parametric ──────────────────────────────────────────────
 * The payload types (`Task`, `Request`, `Result`, `RequestId`) survive in BOTH
 * generations. Re-declaring them here would install a second authority for
 * shapes the protocol already defines — exactly the defect this program exists
 * to remove. So the port takes them as type parameters instead: it constrains
 * only what it actually uses (`TTask` must have a `status`), and the
 * implementing class supplies whichever generation's declarations it draws.
 * That makes the port generation-neutral **by construction** rather than by
 * assertion, and it means task 053 can re-point the payload imports onto the
 * seam without touching this file.
 *
 * This module imports NOTHING. That is deliberate: a store contract that
 * depends on an SDK package is a contract that a package bump can delete, which
 * is the position this task exists to get out of.
 */

/**
 * Task-creation parameters — the owned replacement for v1's deleted
 * `CreateTaskOptions`.
 *
 * Field-for-field identical to the interface it replaces, so an implementation
 * declared against this port stays assignable to v1's `TaskStore` (method
 * parameters are bivariant) and `adapters/mcp.ts` keeps compiling against
 * `ServerOptions.taskStore`. That assignability is not asserted anywhere — it is
 * *exercised*: the v1 adapter still passes the store to the v1 SDK, so
 * `npm run typecheck` fails the moment the two shapes drift.
 */
export interface CreateTaskParams {
  /**
   * Milliseconds to keep the task available after completion. `null` means
   * unlimited lifetime; absent means the store picks its own policy.
   */
  readonly ttl?: number | null;
  /** Milliseconds a client should wait between status polls. */
  readonly pollInterval?: number;
  /** Free-form context forwarded to the store. */
  readonly context?: Record<string, unknown>;
}

/**
 * The store contract: create a task, read its state, record its terminal
 * result, and enumerate.
 *
 * Method-for-method identical to v1's deleted `TaskStore`, because that
 * interface was a reasonable contract and changing it here would have made this
 * migration a rewrite instead of a re-parenting. What changed is **who owns
 * it**.
 *
 * @typeParam TTask      the protocol's task record; constrained only to having
 *                       a `status`, which is the one field this contract's own
 *                       signatures mention
 * @typeParam TRequest   the originating request payload, stored verbatim
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
   * Create a task. The implementation generates the id and the creation
   * timestamp, and MAY clamp the requested `ttl` — the effective value is the
   * one on the returned task.
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

  /** Transition status without a result payload (e.g. to `cancelled`). */
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

/**
 * The statuses from which a task never transitions again.
 *
 * This is the whole content of v1's deleted `isTerminal`, restated as data so
 * the set is inspectable (and testable) rather than buried in a disjunction.
 * Declaration-site typed rather than `as const` — an assertion here would spend
 * the wave's cast budget on something the checker types for free.
 */
export type TerminalTaskStatus = 'completed' | 'failed' | 'cancelled';

/** @see TerminalTaskStatus */
export const TERMINAL_TASK_STATUSES: readonly TerminalTaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

const TERMINAL_LOOKUP: ReadonlySet<string> = new Set(TERMINAL_TASK_STATUSES);

/**
 * Is this task status terminal? The **behavioural** replacement for v1's
 * deleted `isTerminal` — not a type-level stand-in.
 *
 * Two properties are load-bearing and both are pinned by
 * `TaskStoreSeam_TerminalStateQuery_MatchesV1Semantics`:
 *
 *   • **Agreement.** Over the status vocabulary v2's own `TaskStatusSchema`
 *     enumerates, this returns exactly what the v1 SDK's `isTerminal` returns.
 *     The two authorities are different npm packages, so they can genuinely
 *     disagree — which is what makes the agreement worth asserting.
 *   • **Totality.** The parameter is `string`, not the status union, and an
 *     out-of-vocabulary value (a replayed event from a future schema, a typo,
 *     an empty string) is NON-terminal — same as the disjunction it replaces.
 *     A store that treated an unrecognised status as terminal would silently
 *     refuse to record results; one that threw would fail a read on a durable
 *     event it cannot re-write. Returning `false` is the only answer that keeps
 *     the fold total.
 */
export function isTaskTerminal(status: string): boolean {
  return TERMINAL_LOOKUP.has(status);
}

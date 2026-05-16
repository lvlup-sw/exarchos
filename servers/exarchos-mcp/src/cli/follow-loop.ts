/**
 * runFollowLoop — CLI `--follow` polling loop (#1273, T33 + T34).
 *
 * Wave C / PR 3 (CLI facade equivalent of MCP `tasks/get` polling). The
 * CLI `view workflow_status --follow` and `view shepherd_status --follow`
 * subcommands drive this loop directly against an in-process
 * `EventSourcedTaskStore` — function calls, not JSON-RPC. The MCP arm
 * (C2) consumes the same store over the `tasks/*` surface; INV-2 facade
 * equivalence guarantees the two arms emit byte-identical lifecycle
 * events because they share the dispatch-core path (#1273 / C1).
 *
 * ## Cadence
 *
 * Default 250ms — matches the dispatch design choice (see plan §C3 T33)
 * and the SDK demo store's recommended polling cadence. Overridable via
 * `pollIntervalMs`; the CLI adapter resolves `.exarchos.yml`'s
 * `cli.followPollIntervalMs` (registered in `exarchos-config-schema.ts`)
 * and threads it here.
 *
 * ## Termination
 *
 * The loop exits when the observed task status is terminal per the SDK
 * `isTerminal` predicate (`completed | failed | cancelled`) OR when the
 * provided `signal` aborts (SIGINT path, T34). Cancellation drives a
 * `taskStore.updateTaskStatus(taskId, 'cancelled', 'user-interrupt')`
 * call which emits `task.cancelled` on the namespaced stream — the
 * same surface the MCP `tasks/cancel` method invokes (INV-2).
 *
 * ## Output
 *
 * Every transition (status change OR `lastUpdatedAt` advance OR
 * `statusMessage` change) writes one line to the configured stdout
 * (default: `process.stdout`). The formatter lives in
 * `follow-formatter.ts` so the workflow_status and shepherd_status
 * subcommands render identically (only the prefix differs).
 *
 * ## SIGINT discipline
 *
 * Per project memory: "the CLI signal handler must NOT call process.exit
 * until cancelTask resolves (event must land in the store)." The
 * implementation reads as a single `await taskStore.updateTaskStatus(…)`
 * followed by loop termination — control only returns to the CLI
 * `action` callback after the `task.cancelled` event has been appended
 * (the store's `append` is event-store-first).
 */
import type { Task } from '@modelcontextprotocol/sdk/types.js';
import { isTerminal } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';

import {
  formatMissingTask,
  formatTransition,
  type FollowSubcommand,
} from './follow-formatter.js';

/**
 * Minimum slice of the SDK `TaskStore` interface the polling loop
 * exercises. Declared as a structural type so tests can substitute a
 * fixture without dragging in the EventStore; production callers pass
 * a real `EventSourcedTaskStore` (which satisfies this shape).
 */
export interface FollowTaskStore {
  getTask(taskId: string): Promise<Task | null>;
  updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
  ): Promise<void>;
}

/**
 * The default polling cadence in milliseconds. The CLI adapter overrides
 * via `.exarchos.yml`'s `cli.followPollIntervalMs`; this constant is
 * exported so the wiring layer (and integration tests) can reference the
 * same source of truth.
 */
export const DEFAULT_FOLLOW_POLL_INTERVAL_MS = 250;

export interface RunFollowLoopOptions {
  readonly taskStore: FollowTaskStore;
  readonly taskId: string;
  /** Override the default 250ms cadence. Resolved by CLI wiring. */
  readonly pollIntervalMs?: number;
  /** Sink for rendered transition lines. Defaults to `process.stdout`. */
  readonly stdout?: NodeJS.WritableStream;
  /** Which CLI subcommand triggered the loop (drives line prefix). */
  readonly subcommand: FollowSubcommand;
  /**
   * Abort handle. When the signal fires (T34 / SIGINT) the loop calls
   * `taskStore.updateTaskStatus(taskId, 'cancelled', 'user-interrupt')`
   * and awaits resolution before returning.
   */
  readonly signal?: AbortSignal;
}

export interface FollowLoopResult {
  /**
   * The terminal status observed before the loop returned — `completed`,
   * `failed`, or `cancelled`. The CLI action callback maps this to an
   * exit code.
   */
  readonly terminalStatus: 'completed' | 'failed' | 'cancelled';
  /** Number of transition lines written to stdout. */
  readonly transitions: number;
}

function snapshotSignature(task: Task): string {
  // Composite key over the fields a transition can shift. `lastUpdatedAt`
  // alone covers the 99% case (the EventSourcedTaskStore stamps a fresh
  // ISO string on every state mutation) but bundling `status` +
  // `statusMessage` makes the comparison robust against future stores
  // that don't bump the timestamp on a status-message-only edit.
  return `${task.status}|${task.lastUpdatedAt}|${task.statusMessage ?? ''}`;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Promise-friendly sleep that resolves early on abort. AbortError is
  // swallowed — the loop checks `signal.aborted` directly on each
  // iteration so a short-circuit return there reads cleaner than catching
  // here.
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runFollowLoop(
  opts: RunFollowLoopOptions,
): Promise<FollowLoopResult> {
  const {
    taskStore,
    taskId,
    pollIntervalMs = DEFAULT_FOLLOW_POLL_INTERVAL_MS,
    subcommand,
    signal,
  } = opts;
  const stdout: NodeJS.WritableStream = opts.stdout ?? process.stdout;

  let transitions = 0;
  let lastSeen: string | undefined;

  while (true) {
    // T34 — SIGINT short-circuit. The signal abort is the user's
    // "cancel this task" intent (CLI ^C). Route through dispatch-core
    // `updateTaskStatus(cancelled)` so the MCP `tasks/cancel` arm and
    // the CLI SIGINT arm both emit `task.cancelled` with identical
    // shape (INV-2 facade equivalence). The await BLOCKS the loop
    // return until the event has landed in the store — explicit
    // project-memory caution.
    if (signal?.aborted) {
      try {
        await taskStore.updateTaskStatus(taskId, 'cancelled', 'user-interrupt');
      } catch {
        // Best-effort: if the cancel write fails we still want to
        // surface the cancellation line to stdout and return. The
        // underlying error is observable in the event-store stream
        // by absence of `task.cancelled` — same model as the
        // dispatch-core's storeTaskResult tolerance.
      }
      const final = await taskStore.getTask(taskId);
      const cancelledTask: Task = final ?? {
        taskId,
        status: 'cancelled',
        ttl: null,
        createdAt: new Date(0).toISOString(),
        lastUpdatedAt: new Date().toISOString(),
        statusMessage: 'user-interrupt',
      };
      // Normalize status — the fresh getTask may race the cancel write
      // on stores that don't read-after-write within the same tick.
      const renderTask: Task = {
        ...cancelledTask,
        status: 'cancelled',
      };
      stdout.write(formatTransition({ subcommand, task: renderTask }));
      return { terminalStatus: 'cancelled', transitions: transitions + 1 };
    }

    const task = await taskStore.getTask(taskId);
    if (task === null) {
      // T33 acceptance: not-found path emits an error line and returns
      // so the operator isn't left polling indefinitely. The MCP arm
      // surfaces this as a `tasks/get` 404 — CLI surfaces it inline.
      stdout.write(formatMissingTask(subcommand, taskId));
      return { terminalStatus: 'failed', transitions };
    }

    const sig = snapshotSignature(task);
    if (sig !== lastSeen) {
      stdout.write(formatTransition({ subcommand, task }));
      transitions += 1;
      lastSeen = sig;
    }

    if (isTerminal(task.status)) {
      return {
        terminalStatus: task.status as 'completed' | 'failed' | 'cancelled',
        transitions,
      };
    }

    await sleep(pollIntervalMs, signal);
  }
}

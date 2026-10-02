/**
 * CLI `--follow` loops. `runFollowLoop` polls one task in the task store for the
 * `--follow` view commands. `runInspectFollow` tails the raw event stream of one
 * workflow as frames over an event subscription.
 */
import type { V2Task as Task } from '../contract/sdk/seam.js';
import { isTaskTerminal } from '../projections/task-store/port.js';

import {
  formatMissingTask,
  formatTransition,
  type FollowSubcommand,
} from './follow-formatter.js';
import type { WorkflowEvent } from '../events/schemas.js';
import type {
  SubscribeOptions,
  SubscriptionClock,
  SubscriptionFilter,
  SubscriptionHandle,
  SubscriptionListener,
} from '../events/subscriptions.js';
import type { Frame } from '../ndjson/frames.js';

/**
 * The part of the SDK `TaskStore` that the polling loop uses. Tests can pass a
 * fixture with no event store.
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
 * Default polling interval in milliseconds. The CLI adapter replaces it with
 * `cli.followPollIntervalMs` from `.exarchos.yml` when that value is set.
 */
export const DEFAULT_FOLLOW_POLL_INTERVAL_MS = 250;

export interface RunFollowLoopOptions {
  readonly taskStore: FollowTaskStore;
  readonly taskId: string;
  /** Override the default 250ms cadence. Resolved by CLI wiring. */
  readonly pollIntervalMs?: number | undefined;
  /** Sink for rendered transition lines. Defaults to `process.stdout`. */
  readonly stdout?: NodeJS.WritableStream;
  /** Which CLI subcommand triggered the loop (drives line prefix). */
  readonly subcommand: FollowSubcommand;
  /**
   * Abort handle, fired by SIGINT. On abort, the loop writes the `cancelled` status
   * with the message `user-interrupt` and awaits the write before it returns.
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

/**
 * Change key of a task snapshot. It holds `status` and `statusMessage` with
 * `lastUpdatedAt`, so a store that does not update the timestamp on a
 * message-only edit still shows a change.
 */
function snapshotSignature(task: Task): string {
  return `${task.status}|${task.lastUpdatedAt}|${task.statusMessage ?? ''}`;
}

/** Waits `ms`, or less when `signal` aborts. It never rejects. The loop checks `signal.aborted` itself. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

/**
 * Polls the task until it reaches a terminal status, and writes one line per change.
 * A missing task writes an error line and returns `failed`.
 *
 * When `signal` aborts, the loop writes the `cancelled` status and awaits the write,
 * so the `task.cancelled` event is in the store before the CLI exits. A failed cancel
 * write still prints the final line. A task that reached a terminal status before the
 * abort keeps that status. A fallback for a missing task uses the abort time as
 * `createdAt`, not the epoch.
 */
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
    if (signal?.aborted) {
      try {
        await taskStore.updateTaskStatus(taskId, 'cancelled', 'user-interrupt');
      } catch {
      }
      const final = await taskStore.getTask(taskId);
      const now = new Date().toISOString();
      const cancelledTask: Task = final ?? {
        taskId,
        status: 'cancelled',
        ttl: null,
        createdAt: now,
        lastUpdatedAt: now,
        statusMessage: 'user-interrupt',
      };
      const finalStatus: 'completed' | 'failed' | 'cancelled' =
        final !== null && isTaskTerminal(final.status)
          ? (final.status as 'completed' | 'failed' | 'cancelled')
          : 'cancelled';
      const renderTask: Task = { ...cancelledTask, status: finalStatus };
      stdout.write(formatTransition({ subcommand, task: renderTask }));
      return { terminalStatus: finalStatus, transitions: transitions + 1 };
    }

    const task = await taskStore.getTask(taskId);
    if (task === null) {
      stdout.write(formatMissingTask(subcommand, taskId));
      return { terminalStatus: 'failed', transitions };
    }

    const sig = snapshotSignature(task);
    if (sig !== lastSeen) {
      stdout.write(formatTransition({ subcommand, task }));
      transitions += 1;
      lastSeen = sig;
    }

    if (isTaskTerminal(task.status)) {
      return {
        terminalStatus: task.status as 'completed' | 'failed' | 'cancelled',
        transitions,
      };
    }

    await sleep(pollIntervalMs, signal);
  }
}

/**
 * The part of the event subscription contract that the follow carrier uses.
 * `EventStore.subscribe` satisfies it. Tests can inject a fixture.
 */
export type FollowSubscribe = (
  filter: SubscriptionFilter,
  onEvent: SubscriptionListener,
  options?: SubscribeOptions,
) => SubscriptionHandle;

/**
 * Default idle-heartbeat interval in milliseconds. It matches the 30s of
 * `event query --follow`, so an HTTP or WebSocket proxy does not close an idle stream.
 */
export const DEFAULT_FOLLOW_HEARTBEAT_MS = 30_000;

export interface InspectFollowOptions {
  /** Event subscription contract (`EventStore.subscribe` in production). */
  readonly subscribe: FollowSubscribe;
  /** Workflow to tail — becomes the subscription filter's `streamId`. */
  readonly featureId: string;
  /**
   * Initial cursor. The subscription delivers events after `fromSequence`. Without it,
   * the subscription delivers only the events committed after registration.
   */
  readonly fromSequence?: number | undefined;
  /** Carrier sink: an NDJSON encoder (CLI) or a task-update pump (MCP). */
  readonly onFrame: (frame: Frame) => void;
  /** Disposal handle — abort disposes the subscription and ends the stream. */
  readonly signal: AbortSignal;
  /** Injected heartbeat clock. A clock with no `scheduleInterval` gives no heartbeat. */
  readonly clock?: SubscriptionClock | undefined;
  /** Idle heartbeat interval (ms). Defaults to {@link DEFAULT_FOLLOW_HEARTBEAT_MS}. */
  readonly heartbeatIntervalMs?: number | undefined;
}

export interface InspectFollowHandle {
  /** Resolves once the stream has ended (signal aborted or {@link dispose}). */
  readonly done: Promise<void>;
  /** True after the subscription is disposed. */
  disposed(): boolean;
  /**
   * Disposes the stream through the same teardown as an abort. It is idempotent.
   * `tasksFollow` calls it on cancel.
   */
  dispose(): void;
}

/**
 * A host-timer clock for the heartbeat. Its interval is not `unref`'d on purpose:
 * the heartbeat holds the CLI process open until an abort.
 */
export function defaultFollowClock(): SubscriptionClock {
  return {
    now: () => Date.now(),
    scheduleInterval: (tick, intervalMs) => {
      const timer = setInterval(tick, intervalMs);
      return () => clearInterval(timer);
    },
  };
}

/**
 * Tails the event stream of one workflow as frames. The initial drain arrives
 * synchronously during `subscribe`, then live events follow. A sequence cursor
 * drops each event at or below the last emitted sequence.
 *
 * The heartbeat takes its schedule and timestamp from the injected clock. It calls
 * the clock methods on the clock object, so a clock can keep state on `this`. A tick
 * after event activity emits nothing, so a heartbeat marks an idle gap. A tick
 * ignores a throw from `onFrame`, because in a timer callback the throw becomes an
 * uncaught process error.
 *
 * Abort and `dispose` share one `end` path. It disposes the subscription, stops the
 * heartbeat, removes the abort listener, and writes an `end` frame.
 */
export function runInspectFollow(opts: InspectFollowOptions): InspectFollowHandle {
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_FOLLOW_HEARTBEAT_MS;

  let lastEmitted = opts.fromSequence ?? 0;
  let ended = false;
  let activitySinceTick = false;
  let cancelHeartbeat: (() => void) | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });

  const handle = opts.subscribe(
    { streamId: opts.featureId },
    (event: WorkflowEvent) => {
      if (ended) return;
      if (event.sequence <= lastEmitted) return;
      lastEmitted = event.sequence;
      activitySinceTick = true;
      opts.onFrame({ type: 'event', event, sequence: event.sequence });
    },
    opts.fromSequence !== undefined ? { fromSequence: opts.fromSequence } : undefined,
  );

  const clock = opts.clock;
  const now = (): number => (clock ? clock.now() : Date.now());
  if (clock?.scheduleInterval) {
    cancelHeartbeat = clock.scheduleInterval(() => {
      if (ended) return;
      if (activitySinceTick) {
        activitySinceTick = false;
        return;
      }
      try {
        opts.onFrame({ type: 'heartbeat', timestamp: new Date(now()).toISOString() });
      } catch {
      }
    }, heartbeatIntervalMs);
  }

  const onAbort = (): void => end('aborted');

  const end = (reason: string): void => {
    if (ended) return;
    ended = true;
    cancelHeartbeat?.();
    cancelHeartbeat = undefined;
    opts.signal.removeEventListener('abort', onAbort);
    handle.dispose();
    opts.onFrame({ type: 'end', reason });
    resolveDone();
  };

  if (opts.signal.aborted) {
    end('aborted');
  } else {
    opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  return {
    done,
    disposed: () => handle.disposed,
    dispose: () => end('disposed'),
  };
}

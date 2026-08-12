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
 * The loop exits when the observed task status is terminal per the owned
 * `isTaskTerminal` predicate (`completed | failed | cancelled`) OR when the
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
import type { V2Task as Task } from '../sdk/seam.js';
// DR-0 / task 051: v2 DELETED `isTerminal` along with the whole experimental
// Tasks store seam, so this predicate is drawn from the OWNED port rather than
// re-pointed at the seam. `../task-store/port.ts` imports nothing and is
// generation-neutral by construction; `isTaskTerminal` is differentially tested
// against the v1 oracle over v2's own status vocabulary.
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
  readonly pollIntervalMs?: number | undefined;
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
      const now = new Date().toISOString();
      const cancelledTask: Task = final ?? {
        taskId,
        status: 'cancelled',
        ttl: null,
        // Sentry LOW #1433: when fabricating a fallback for an expired
        // or missing task on abort, anchor `createdAt` to the abort
        // moment rather than the Unix epoch — the latter renders as
        // 1970 in transition output and confuses operators.
        createdAt: now,
        lastUpdatedAt: now,
        statusMessage: 'user-interrupt',
      };
      // Sentry MEDIUM #1433: if the abort signal lands after the task
      // already reached a terminal state, respect that terminal status
      // rather than forcing 'cancelled'. Re-reading via getTask above
      // makes this race-safe — `final.status` reflects the durable
      // post-cancel-attempt view of the world.
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

    if (isTaskTerminal(task.status)) {
      return {
        terminalStatus: task.status as 'completed' | 'failed' | 'cancelled',
        transitions,
      };
    }

    await sleep(pollIntervalMs, signal);
  }
}

// ─── DR-4: subscription-fed `inspect --follow` carrier ───────────────────────
//
// The task-polling loop above (`runFollowLoop`) tails the SDK `TaskStore`
// projection for the `workflow_status` / `shepherd_status` view actions.
// `inspect --follow` is a DIFFERENT shape: it tails ONE workflow's raw event
// stream live over the DR-1 cursor-pump subscription (see
// `event-store/subscriptions.ts`), framing each delivered event as an NDJSON
// `event` frame. Both streaming facades — the CLI NDJSON carrier and the MCP
// Tasks arm (`mcp/tasks-methods.ts`) — drive this SAME core over the SAME
// subscription contract, so they emit byte-identical frame streams (INV-2).
//
// Two invariants shape the core:
//   • DEDUP BY SEQUENCE (monotonic). A monotonic cursor drops any event whose
//     sequence is at-or-below the last-emitted one, so the frame stream carries
//     each sequence EXACTLY ONCE in ascending order. The DR-1 subscription
//     already guarantees exactly-once in-order delivery; this cursor is
//     defence-in-depth over that guarantee AND the seam a future snapshot+tail
//     overlap needs (a snapshot's trailing events re-delivered by the tail's
//     initial drain collapse to one frame each).
//   • INJECTED-TIMER HEARTBEAT (INV-16 — no wall-clock). Heartbeat frames on
//     silence are scheduled through the injected {@link SubscriptionClock}, not
//     `setInterval` + `Date.now()` directly, so tests drive both the cadence
//     (`scheduleInterval`) and the frame timestamp (`now`) deterministically.
//     A tick that follows real event activity RESETS instead of emitting, so a
//     heartbeat marks a genuine idle gap rather than merely elapsed time.
//
// Disposal is AbortSignal-driven (no POSIX-only signal semantics): aborting the
// signal — SIGINT on the CLI, `tasks/cancel` on the MCP arm — disposes the
// subscription, cancels the heartbeat, and writes a terminal `end` frame.

/**
 * The slice of the DR-1 subscription contract the follow carrier drives
 * (`EventStore.subscribe` satisfies it). Declared structurally so tests can
 * inject a hermetic subscribe fixture without a real EventStore.
 */
export type FollowSubscribe = (
  filter: SubscriptionFilter,
  onEvent: SubscriptionListener,
  options?: SubscribeOptions,
) => SubscriptionHandle;

/**
 * Default idle-heartbeat cadence (ms) for the `inspect --follow` carrier —
 * matches `event query --follow`'s 30s so an HTTP/WS intermediary doesn't tear
 * down an idle stream.
 */
export const DEFAULT_FOLLOW_HEARTBEAT_MS = 30_000;

export interface InspectFollowOptions {
  /** DR-1 subscription contract (`EventStore.subscribe` in production). */
  readonly subscribe: FollowSubscribe;
  /** Workflow to tail — becomes the subscription filter's `streamId`. */
  readonly featureId: string;
  /**
   * Start the cursor here (subscription sees events at-or-after
   * `fromSequence + 1`). The CLI passes `0` so the follow stream is
   * self-contained (existing events + live tail); omitting it tails only
   * events committed after registration.
   */
  readonly fromSequence?: number | undefined;
  /** Carrier sink: an NDJSON encoder (CLI) or a task-update pump (MCP). */
  readonly onFrame: (frame: Frame) => void;
  /** Disposal handle — abort disposes the subscription and ends the stream. */
  readonly signal: AbortSignal;
  /**
   * Injected heartbeat timer (INV-16). When it omits `scheduleInterval` (a bare
   * `{ now }` clock) the carrier runs with NO heartbeat; production CLI passes
   * {@link defaultFollowClock}.
   */
  readonly clock?: SubscriptionClock | undefined;
  /** Idle heartbeat interval (ms). Defaults to {@link DEFAULT_FOLLOW_HEARTBEAT_MS}. */
  readonly heartbeatIntervalMs?: number | undefined;
}

export interface InspectFollowHandle {
  /** Resolves once the stream has ended (signal aborted or {@link dispose}). */
  readonly done: Promise<void>;
  /** True once the underlying DR-1 subscription has been disposed. */
  disposed(): boolean;
  /**
   * Force-dispose (idempotent) — the same teardown the abort path runs. The
   * MCP `tasks/cancel` arm calls this to turn a task cancellation into a
   * subscription dispose.
   */
  dispose(): void;
}

/**
 * A real host-timer clock for the carrier's heartbeat. Unlike the
 * subscription registry's default clock this interval is deliberately NOT
 * `unref`'d: the heartbeat is the CLI follow session's keep-alive, holding the
 * process open until SIGINT aborts the signal (there is no polling loop to do
 * so). Tests inject a manual clock and never touch this.
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
 * Tail one workflow's event stream as a frame stream over the DR-1
 * subscription. Returns immediately with a handle; the initial drain (existing
 * events at-or-after the cursor) is delivered synchronously during
 * {@link InspectFollowOptions.subscribe}, and live events arrive as the source
 * commits. The stream ends when the signal aborts or {@link dispose} is called.
 */
export function runInspectFollow(opts: InspectFollowOptions): InspectFollowHandle {
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_FOLLOW_HEARTBEAT_MS;

  // Monotonic dedup cursor. `fromSequence` (when set) is the initial cursor, so
  // an event re-delivered at or below it is dropped; otherwise start below the
  // first possible sequence (events are 1-based) so nothing is filtered.
  let lastEmitted = opts.fromSequence ?? 0;
  let ended = false;
  // Set on every emitted event; a heartbeat tick that sees it RESETS instead of
  // firing, so heartbeats mark genuine idle gaps ("on silence"), not activity.
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
      // DEDUP BY SEQUENCE (monotonic): drop anything not strictly newer.
      if (event.sequence <= lastEmitted) return;
      lastEmitted = event.sequence;
      activitySinceTick = true;
      opts.onFrame({ type: 'event', event, sequence: event.sequence });
    },
    opts.fromSequence !== undefined ? { fromSequence: opts.fromSequence } : undefined,
  );

  // Call the clock methods as methods (never detach them) so an injected clock
  // may keep instance state on `this` — matching the subscription registry's
  // own convention.
  const clock = opts.clock;
  const now = (): number => (clock ? clock.now() : Date.now());
  if (clock?.scheduleInterval) {
    cancelHeartbeat = clock.scheduleInterval(() => {
      if (ended) return;
      // Heartbeat ONLY on silence: a tick that follows real event activity
      // resets the idle marker rather than emitting a frame (INV-16 timing +
      // frame timestamp both come from the injected clock — no wall-clock).
      if (activitySinceTick) {
        activitySinceTick = false;
        return;
      }
      try {
        opts.onFrame({ type: 'heartbeat', timestamp: new Date(now()).toISOString() });
      } catch {
        // Isolate the caller-supplied sink (NDJSON encoder write / MCP
        // task-update push) from the tick — same gap, and same containment, as
        // `Subscription.floorTick()` in event-store/subscriptions.ts. This runs
        // inside `scheduleInterval`, so an escaping throw is an unhandled
        // process-level exception rather than one dropped frame. A lost
        // heartbeat is cosmetic: it carries no state, real event frames flow
        // through the subscription path, and the next tick re-emits.
      }
    }, heartbeatIntervalMs);
  }

  // Single abort-listener reference so the SAME function can be removed on
  // teardown — a stream that ends by `dispose()` (never abort) must not leave a
  // live `abort` listener pinned to a long-lived external AbortSignal (SIGINT
  // wiring / server session). `{ once: true }` covers the abort-fired case; this
  // covers the dispose-first case. Both disposal entry points still converge on
  // the SINGLE `end()` → `handle.dispose()` route.
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

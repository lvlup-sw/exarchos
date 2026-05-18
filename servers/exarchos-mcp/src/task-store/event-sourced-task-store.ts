/**
 * EventSourcedTaskStore — SDK `TaskStore` as an event-sourced projection (#1272).
 *
 * Implements the MCP SDK `TaskStore` interface
 * (`@modelcontextprotocol/sdk/experimental/tasks/interfaces`) by emitting
 * the four `task.*` lifecycle events
 * (`task.created`/`task.polled`/`task.result`/`task.cancelled`) to the
 * event store on every state-mutating call and reconstructing per-task
 * state by folding those events on read.
 *
 * ## Why
 *
 * The SDK's `InMemoryTaskStore` is explicitly demo-only ("not suitable
 * for production use as all data is lost on restart"). Exarchos already
 * has a durable event store; making the TaskStore a projection over it
 * is the natural canonical wiring — INV-1 (event-sourcing integrity):
 * state derives from events, not the other way around. The REPLAY
 * acceptance test in `event-sourced-task-store.test.ts` is the
 * load-bearing proof of this contract.
 *
 * ## Stream layout
 *
 * Each task lives on its own namespaced stream `task-store/<taskId>`.
 * This keeps task lifecycle disjoint from workflow lifecycle streams,
 * so cross-stream queries (`view`, audit) can pivot on either axis
 * without entanglement. The stream-id prefix is intentionally identical
 * to the file's directory so a developer grepping `task-store/` finds
 * both the implementation and the runtime streams.
 *
 * ## Cache semantics
 *
 * The in-memory map (`this.tasks`) is a **lazy projection cache**, not
 * authoritative state. The durable stream is the source of truth — the
 * cache is rebuilt lazily on miss and validated against the stream on
 * every hit.
 *
 *   - **Cache miss** → `fullRefold` queries the entire `task-store/<id>`
 *     stream, folds it via `projectTask`, stamps `lastReadSequence` to
 *     the tail event's sequence, and caches the result.
 *   - **Cache hit** → `loadTask` calls `EventStore.tailSequence(stream)`
 *     and compares against the cached `lastReadSequence`. If they match,
 *     the cached projection is returned verbatim. If the tail has
 *     advanced (a sibling process / instance appended `task.result` or
 *     `task.cancelled` since we cached), `refoldDelta` queries only the
 *     events newer than `lastReadSequence` (`sinceSequence` is exclusive
 *     in the backend) and applies them via `projectTaskIncremental`.
 *
 * This closes FINDING-2 (#1438) — multi-process scenarios (CLI + MCP
 * server on the same `stateDir`, hot-swap, two MCP instances) no longer
 * drift silently: the prose here now matches the code (closes DIM-8).
 *
 * ## TTL
 *
 * Per-task `expiresAt = createdAt + ttl` is computed from the
 * `task.created` event. Expired tasks are reaped on read (`getTask` /
 * `getTaskResult` / `listTasks`) — no background timers, no extra
 * substrate state. `ttl === null` means unlimited lifetime (per the
 * SDK contract). The per-task `task.polled` emit (FINDING-3, #1438) is
 * throttled to one event per `TASK_POLLED_THROTTLE_MS` window via an
 * in-memory `lastPolledAt` map that is cleaned up alongside the cache
 * on reap.
 *
 * ## listTasks ordering + cursor wire format (FINDING-5, #1438 T7)
 *
 * Pagination sorts by `(createdAt ASC, taskId ASC)`. `createdAt` is
 * the `task.created` event's ISO timestamp — deterministic and
 * present on every entry in the cache. `taskId` is the tie-break for
 * two events sharing a millisecond (a real race when two consumers
 * race against the same store at high QPS). Neither key depends on
 * Map insertion order, so the enumeration is identical across
 * processes, restarts, and replicas pointed at the same event store
 * — the prerequisite for the cursor contract below.
 *
 * The cursor is an OPAQUE string: callers MUST treat it as a
 * round-trip blob and MUST NOT parse it. Internally:
 *
 *   cursor = base64url(JSON.stringify({ createdAt, taskId }))
 *
 * where `createdAt` and `taskId` are the values of the LAST entry on
 * the page just returned. Decoding skips past every entry whose
 * `(createdAt, taskId)` tuple is `<=` the cursor under the same lex
 * ordering as the sort. `nextCursor` is only emitted when there is at
 * least one entry past the current page.
 *
 * Hydration (`hydrateFromEventStore`) is cursor-anchored and
 * incremental (FINDING-6, #1438 T8). Each `listTasks` call issues one
 * `EventStore.queryByType('task.created', ...)` round-trip filtered to
 * the `task-store/` prefix, anchored at `cursor.createdAt`
 * (`undefined` on cold-start), and capped at `PAGE_SIZE + LOOKAHEAD`.
 * Per-task projection folds only run for events that aren't already
 * cached, so steady-state cost is `O(new tasks since prior page)`
 * rather than `O(total durable tasks)`. The cursor's `createdAt`
 * field is therefore load-bearing for the hydration filter AND for
 * sort + offset.
 */
import { randomBytes } from 'node:crypto';
import type {
  Task,
  RequestId,
  Result,
  Request,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  TaskStore,
  CreateTaskOptions,
} from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';
import { isTerminal } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js';

import { EventStore, SequenceConflictError } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { ConcurrencyError } from '../event-store/concurrency-error.js';
import { taskStoreLogger } from '../logger.js';

/**
 * Per-task projected lifecycle state. The shape carries everything
 * `getTask` / `getTaskResult` / `listTasks` need; the original `request`
 * and `requestId` are kept so SDK consumers can reconstruct what was
 * originally asked (this mirrors `InMemoryTaskStore`'s `stored.request`
 * field).
 */
interface ProjectedTask {
  task: Task;
  request: Request;
  requestId: RequestId;
  result?: Result;
  /** Wall-clock expiration; undefined when ttl is null (unlimited). */
  expiresAt?: number;
  /**
   * FINDING-2 (#1438, PR 2): tail sequence at the last successful fold.
   * `loadTask` compares this against `EventStore.tailSequence(stream)` on
   * every cache hit; when the tail has advanced (a sibling process /
   * instance appended `task.result` / `task.cancelled` since we cached),
   * we incrementally re-fold the delta via `projectTaskIncremental`.
   * `projectTask` itself remains sequence-unaware (pure fold over event
   * content); the caller is responsible for stamping this field after a
   * successful projection.
   */
  lastReadSequence: number;
}

/**
 * Generates a unique task ID. Matches the SDK demo store's
 * 16-bytes-as-hex convention so consumers that hard-code an expected
 * id-length don't trip on the swap.
 */
function generateTaskId(): string {
  return randomBytes(16).toString('hex');
}

function taskStream(taskId: string): string {
  return `${TASK_STREAM_PREFIX}${taskId}`;
}

/**
 * FINDING-3 (#1438): throttle window for `task.polled` emit. The CLI
 * `--follow` loop and the SDK `tasks/poll` flow drive `getTask` at the
 * task's `pollInterval` cadence (often 250ms), which without throttling
 * appends one `task.polled` event per call and severely amplifies the
 * durable stream. A 5-second window collapses tight bursts to a single
 * emit while still preserving observability of long-running polls.
 */
const TASK_POLLED_THROTTLE_MS = 5_000;

/**
 * FINDING-4 (#1438): size-cap threshold for the TTL reap path. The
 * read-time reaper (`reapExpired`) used to fire ONLY from `listTasks`
 * — tasks created via `createTask` and never read accumulated in the
 * in-memory cache indefinitely. To bound the cache without adding a
 * background timer, `createTask` invokes `reapExpired` once the cache
 * strictly exceeds this threshold. The bound is intentionally generous
 * (steady-state worst case is `2 * threshold` immediately before the
 * sweep) so the hot path stays O(1) at small sizes; the O(n) sweep
 * cost is amortized across `threshold` creates between sweeps.
 */
const SIZE_CAP_REAP_THRESHOLD = 1024;

/**
 * FINDING-5 (#1438, T7): `listTasks` cursor — opaque, base64url-encoded
 * JSON of the `(createdAt, taskId)` tuple of the LAST entry on the
 * prior page. Anchoring on `(createdAt, taskId)` instead of Map
 * insertion order is what makes pagination stable across process
 * restarts and across multiple instances pointed at the same event
 * store. See the `listTasks` body for the sort + offset implementation
 * that consumes this shape.
 */
interface ListTasksCursor {
  readonly createdAt: string;
  readonly taskId: string;
}

/**
 * FINDING-5 (#1438, T7): page size for `listTasks` pagination. Module-
 * level so T8's hydration query can stay aligned with the cursor wire
 * format — the hydration window is bounded by `PAGE_SIZE + LOOKAHEAD`,
 * not by the total durable task count.
 */
const PAGE_SIZE = 10;

/**
 * FINDING-6 (#1438, T8): lookahead window on the cursor-anchored
 * hydration query. Each `listTasks` call queries the event store for at
 * most `PAGE_SIZE + LOOKAHEAD` `task.created` events anchored on the
 * cursor's `createdAt` (or from the beginning when no cursor is
 * supplied). The lookahead absorbs tie-break churn for events that
 * share a millisecond timestamp — the substrate orders by
 * `(timestamp, streamId, sequence)` so events with identical
 * timestamps fall through to `streamId` lex order; without the
 * lookahead the page slice could miss a same-millisecond sibling that
 * sorts after the page boundary by `taskId` but before by `streamId`.
 *
 * Concrete bound on pre-fix vs. post-fix work: with N durable tasks
 * pre-fix hydration paid N `eventStore.query` calls per `listTasks`
 * call (one full-refold per stream). Post-fix it pays at most
 * `PAGE_SIZE + LOOKAHEAD = 18` per-task `query` calls plus one
 * `queryByType` round-trip, regardless of N. The 8-entry lookahead
 * also pre-warms the cache for the next page (overlap of 1 between
 * consecutive query windows means page-2's hydration usually folds
 * only the genuinely new entries past page-1's tail).
 *
 * Configurability: the constant is module-private today. If
 * production telemetry shows tie-break churn exceeds 8 at observed
 * creation rates, raise the bound and re-run the cross-process
 * pagination acceptance tests (`ListTasks_AcrossSimulatedRestart_*`,
 * `ListTasks_TieBreakOnIdenticalCreatedAt_*`).
 */
const LOOKAHEAD = 8;

/**
 * FINDING-6 (#1438, T8): the namespaced stream prefix for per-task
 * lifecycle streams. Kept as a module-level const so `taskStream()`
 * (the writer side) and `hydrateFromEventStore` (the reader side) use
 * the exact same string — a divergence would silently break the
 * cross-stream `queryByType` prefix filter.
 */
const TASK_STREAM_PREFIX = 'task-store/';

function encodeListTasksCursor(c: ListTasksCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeListTasksCursor(s: string): ListTasksCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(s, 'base64url').toString('utf8'),
    ) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'createdAt' in parsed &&
      'taskId' in parsed &&
      typeof (parsed as Record<string, unknown>)['createdAt'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['taskId'] === 'string'
    ) {
      return parsed as ListTasksCursor;
    }
    throw new Error('Invalid cursor: missing or malformed fields');
  } catch (err) {
    // Preserve the legacy `Invalid cursor: ...` prefix that the prior
    // taskId-indexOf path produced. Callers (and downstream MCP error
    // wrappers) match on this string shape.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cursor: ${detail}`);
  }
}

/**
 * Optional constructor options for `EventSourcedTaskStore`.
 *
 * `clock` is the rate-limit clock for the FINDING-3 throttle gate.
 * Production callers omit it (defaults to `Date.now()`); tests inject a
 * counter-style function to make the throttle behavior deterministic.
 * NOTE: TTL/`expiresAt` math elsewhere in the class intentionally keeps
 * reading `Date.now()` directly — TTL is wall-clock semantics, throttle
 * is rate-limit semantics, and conflating them in one knob would muddy
 * blast radius.
 */
export interface EventSourcedTaskStoreOptions {
  clock?: () => number;
}

export class EventSourcedTaskStore implements TaskStore {
  private readonly store: EventStore;

  /**
   * Cache of materialized tasks. Authoritative state lives in the
   * event store — this is rebuilt lazily on miss via `loadTask()`.
   */
  private readonly tasks = new Map<string, ProjectedTask>();

  /**
   * FINDING-3 (#1438): per-task wall-clock timestamp of the last
   * `task.polled` emit. Used by the throttle gate in `getTask`. Cleared
   * when the task expires (read-time reap) or is otherwise reaped to
   * avoid unbounded growth.
   */
  private readonly lastPolledAt = new Map<string, number>();

  /**
   * FINDING-3 (#1438): injectable clock used ONLY by the `task.polled`
   * throttle gate. Defaults to `Date.now()`. See
   * `EventSourcedTaskStoreOptions.clock` for why this is scoped narrowly.
   */
  private readonly nowMs: () => number;

  constructor(eventStore: EventStore, options?: EventSourcedTaskStoreOptions) {
    this.store = eventStore;
    this.nowMs = options?.clock ?? Date.now.bind(Date);
  }

  // ─── SDK TaskStore interface ────────────────────────────────────────────

  async createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    _sessionId?: string,
  ): Promise<Task> {
    const taskId = generateTaskId();
    const ttl = taskParams.ttl ?? null;
    // CodeRabbit MAJOR #1431 follow-up: defensive normalization. The
    // dispatch boundary (`tasks-augmented.ts::extractTaskOptions`) already
    // filters non-positive/NaN/Infinity/non-integer values, but
    // `createTask` can be called directly by other SDK consumers (tests,
    // future in-process callers) without going through the extractor.
    // Normalise here so the durable `TaskCreatedData.pollInterval` schema
    // (`.int().positive().optional()`) never sees `0` / negative / NaN /
    // Infinity / fractional — those would otherwise fail event-append
    // validation and corrupt the event stream.
    const rawPollInterval = taskParams.pollInterval;
    const pollInterval =
      typeof rawPollInterval === 'number' &&
      Number.isInteger(rawPollInterval) &&
      rawPollInterval > 0
        ? rawPollInterval
        : 1000;
    const createdAt = new Date().toISOString();

    // Event-store first: the durable record IS the truth.
    // CodeRabbit MAJOR #1431 follow-up: include `pollInterval` in the
    // durable payload so REPLAY (`projectTask`) reconstructs the original
    // cadence. Pre-fix the value was only stored in the in-memory
    // projection; restarting the process silently reverted every task to
    // the 1000ms default.
    await this.store.append(taskStream(taskId), {
      type: 'task.created',
      timestamp: createdAt,
      data: {
        taskId,
        ttl,
        request,
        pollInterval,
        // FINDING-8 (#1438, T6): persist the JSON-RPC `requestId` so a
        // replaying process recovers the original outbound correlation
        // id verbatim. Pre-fix, the value lived only in this in-memory
        // entry and was lost across process restarts — `projectTask`
        // had to synthesize `replayed:${taskId}` for every fold. With
        // this field on new events the synthesizer becomes a strict
        // backward-compat fallback for historical (pre-T6) events
        // rather than a routine code path.
        requestId,
        // `createdBy` is left to upstream stamping (DispatchContext via
        // AsyncLocalStorage — see B1) when the call is inside a
        // dispatch boundary. The schema permits the field as optional.
      },
    });

    const task: Task = {
      taskId,
      status: 'working',
      ttl,
      createdAt,
      lastUpdatedAt: createdAt,
      pollInterval,
    };

    this.tasks.set(taskId, {
      task,
      request,
      requestId,
      // Bind `expiresAt` to the event timestamp (not `Date.now()`) so the
      // writer's in-memory cache matches what a replaying reader process
      // computes via `projectTask` / `projectTaskIncremental`. Otherwise
      // two processes folding the same stream could disagree on expiry.
      expiresAt: ttl !== null ? Date.parse(createdAt) + ttl : undefined,
      // FINDING-2 (#1438): the `task.created` event we just appended is
      // the only event on a fresh stream, so the cached projection's
      // last-read tail is sequence 1. Subsequent appends (`task.polled`,
      // `task.result`, `task.cancelled`) bump this via the cache-hit
      // path in `loadTask` after each successful fold.
      lastReadSequence: 1,
    });

    // FINDING-4 (#1438): size-cap reap. Without this, a creator-only
    // workload (no `listTasks` reads) lets `this.tasks` grow unbounded
    // — the read-time reaper only fires from `listTasks`. Sweep here
    // when the cache crosses the threshold so expired entries cannot
    // accumulate silently. The strict `>` keeps the gate idempotent
    // at the boundary: at exactly `threshold` entries we have NOT yet
    // paid the sweep cost; the 1025th create is what triggers it.
    if (this.tasks.size > SIZE_CAP_REAP_THRESHOLD) {
      this.reapExpired();
    }

    return task;
  }

  async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
    const stored = await this.loadTask(taskId);
    if (!stored) return null;
    if (this.isExpired(stored)) {
      this.tasks.delete(taskId);
      // FINDING-3 (#1438): keep the throttle map in lockstep with the
      // cache so reaped tasks don't leave dangling rate-limit entries.
      this.lastPolledAt.delete(taskId);
      return null;
    }
    // ─── #1273 / T29 — Emit task.polled on every successful read ──────────
    // The Tasks-augmented dispatch flow (C1) and the MCP `tasks/get`
    // method (C2) both route polls through `getTask`. Emitting here keeps
    // the `task.*` lifecycle complete on the namespaced stream so audit
    // queries can reconstruct the cadence + identity of every poll
    // (including the operationId of the dispatch that owned the parent
    // task — stamped automatically by the event store via the active
    // ALS scope from `runTasksAugmented`'s captured DispatchContext).
    //
    // Failure to emit is best-effort and intentionally swallowed: a
    // `getTask` read MUST NOT fail because the audit-trail emission hit
    // a transient I/O blip. The projection itself is unaffected (no
    // `task.polled` handler in `projectTask` — it is a pure observability
    // event, not a state transition).
    //
    // FINDING-3 throttle gate (#1438): collapse bursts of `getTask`
    // calls within `TASK_POLLED_THROTTLE_MS` down to a single emit.
    // Uses an injectable clock (`this.nowMs`) for the rate-limit
    // decision so tests can advance time deterministically; TTL and
    // event-timestamp wall-clock reads elsewhere intentionally remain
    // on `Date.now()` (TTL is wall-clock semantics, throttle is
    // rate-limit semantics — keep them disjoint).
    const now = this.nowMs();
    const last = this.lastPolledAt.get(taskId) ?? 0;
    if (now - last >= TASK_POLLED_THROTTLE_MS) {
      try {
        await this.store.append(taskStream(taskId), {
          type: 'task.polled',
          timestamp: new Date().toISOString(),
          data: { taskId },
        });
        this.lastPolledAt.set(taskId, now);
      } catch {
        // best-effort
      }
    }
    return { ...stored.task };
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    _sessionId?: string,
  ): Promise<void> {
    // FINDING-1 (#1438, PR 3): route the read→decide→append through
    // `commitWithOcc` so the durable layer enforces single-writer
    // semantics via `expectedSequence`. The terminal-check fires INSIDE
    // the decide closure so each retry re-evaluates against a freshly
    // refolded projection (a concurrent winner's `task.result` /
    // `task.cancelled` becomes visible on the next attempt).
    return this.commitWithOcc(taskId, 'storeTaskResult', async (stored) => {
      if (isTerminal(stored.task.status)) {
        throw new Error(
          `Cannot store result for task ${taskId} in terminal status '${stored.task.status}'. Task results can only be stored once.`,
        );
      }
      const now = new Date().toISOString();
      return {
        event: {
          type: 'task.result',
          timestamp: now,
          data: {
            taskId,
            status,
            result,
          },
        },
        mutate: (s: ProjectedTask) => {
          s.result = result;
          // CodeRabbit r3253903305 (#1444): drop any prior
          // `statusMessage` (typically a stale `input_required` prompt)
          // — `storeTaskResult` is a terminal transition with an
          // explicit result, so the prior diagnostic no longer applies.
          // Equally important: the projection a sibling process
          // computes from the durable stream NEVER sets `statusMessage`
          // for `task.result` (no field carries it), so without this
          // explicit clear the writer's cache would diverge from
          // replayers — the same INV-1 cross-process inconsistency the
          // `expiresAt` bump above also guards against.
          const {
            statusMessage: _staleStatusMessage,
            ...taskWithoutStatusMessage
          } = s.task;
          void _staleStatusMessage;
          s.task = {
            ...taskWithoutStatusMessage,
            status,
            lastUpdatedAt: now,
          };
          // TTL resets from terminal transition (matches SDK semantics).
          // Use the event's ISO timestamp — not `Date.now()` — so the
          // writer's cache stays in lockstep with the projection a
          // sibling process computes when it replays the same event.
          if (s.task.ttl !== null) {
            s.expiresAt = Date.parse(now) + s.task.ttl;
          }
        },
      };
    });
  }

  async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
    const stored = await this.loadTask(taskId);
    if (!stored) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    if (this.isExpired(stored)) {
      this.tasks.delete(taskId);
      // FINDING-3 (#1438): symmetric with getTask's reap branch.
      this.lastPolledAt.delete(taskId);
      throw new Error(`Task with ID ${taskId} not found`);
    }
    if (stored.result === undefined) {
      throw new Error(`Task ${taskId} has no result stored`);
    }
    return stored.result;
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    _sessionId?: string,
  ): Promise<void> {
    // CodeRabbit r3253903306 (#1444): `completed` / `failed` carry a
    // result payload and only have a faithful representation as a
    // durable `task.result` event via `storeTaskResult`. Allowing them
    // here would route through the `event: null` projection-only
    // fallback below — the transition would live in this process's
    // cache and disappear on replay or in any sibling process,
    // violating INV-1 (event-sourcing integrity). We reject loudly
    // BEFORE entering `commitWithOcc` so callers see the contract
    // violation directly rather than as a post-hoc divergence.
    if (status === 'completed' || status === 'failed') {
      throw new Error(
        `Cannot transition task ${taskId} to '${status}' via updateTaskStatus — terminal '${status}' carries a result payload and requires a durable task.result event. Use storeTaskResult() instead.`,
      );
    }
    // FINDING-1 (#1438, PR 3): route through `commitWithOcc`. The
    // cancellation branch returns a durable `task.cancelled` event and
    // gets full OCC enforcement; non-cancel transitions return
    // `event: null` (projection-only) and retain pre-PR-3 semantics —
    // see the inline note on `commitWithOcc` for why this asymmetry is
    // intentional (no durable event ⇒ no `expectedSequence` to enforce).
    return this.commitWithOcc(taskId, 'updateTaskStatus', async (stored) => {
      if (isTerminal(stored.task.status)) {
        throw new Error(
          `Cannot update task ${taskId} from terminal status '${stored.task.status}' to '${status}'. Terminal states (completed, failed, cancelled) cannot transition to other states.`,
        );
      }
      const now = new Date().toISOString();
      const mutate = (s: ProjectedTask) => {
        // CodeRabbit r3253903305 (#1444): explicitly drop the prior
        // `statusMessage` before re-assigning. The SDK Task contract
        // treats `statusMessage` as "the latest status update", so a
        // transition that doesn't carry a message MUST clear stale
        // text — otherwise an `input_required` prompt persists across
        // a return to `working`, and (for cancellation) the projection
        // a replayer computes from the durable `task.cancelled` event
        // would diverge from the writer's cache (the event only carries
        // `reason`, never the pre-cancel diagnostic).
        const {
          statusMessage: _staleStatusMessage,
          ...taskWithoutStatusMessage
        } = s.task;
        void _staleStatusMessage;
        s.task = {
          ...taskWithoutStatusMessage,
          status,
          lastUpdatedAt: now,
          ...(statusMessage !== undefined ? { statusMessage } : {}),
        };
        // See `storeTaskResult` for why this binds to the event ISO
        // timestamp rather than `Date.now()`.
        if (isTerminal(status) && s.task.ttl !== null) {
          s.expiresAt = Date.parse(now) + s.task.ttl;
        }
      };
      // The `cancelled` transition gets its own durable event so audit
      // can attribute the cancellation reason cleanly. Other status
      // transitions (working ↔ input_required) don't have a dedicated
      // event yet; they live only in the projection's
      // `lastUpdatedAt`/`statusMessage` until a downstream consumer
      // requires durable visibility.
      if (status === 'cancelled') {
        return {
          event: {
            type: 'task.cancelled',
            timestamp: now,
            data: {
              taskId,
              reason: statusMessage ?? 'unspecified',
            },
          },
          mutate,
        };
      }
      return { event: null, mutate };
    });
  }

  async listTasks(
    cursor?: string,
    _sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    // FINDING-6 (#1438, T8): decode the cursor BEFORE hydration so the
    // hydration query can be anchored on `cursor.createdAt`. This
    // collapses the per-call hydration cost from `O(total durable
    // tasks)` to `O(PAGE_SIZE + LOOKAHEAD)` — see
    // `hydrateFromEventStore`'s doc for the full rationale.
    const cursorObj = cursor ? decodeListTasksCursor(cursor) : undefined;

    // ─── Cold-start hydration (#1272 / CR PR #1432) ───────────────────────
    // The in-memory cache (`this.tasks`) is not authoritative; on a
    // freshly-constructed instance it is empty even if durable
    // `task-store/*` streams exist. Without hydration `listTasks` would
    // silently return `{tasks: [], nextCursor: undefined}` for a brand
    // new process, which violates the SDK `TaskStore` contract and
    // INV-1 (event-sourcing integrity — state derives from events).
    //
    // FINDING-6 (#1438, T8): hydration is now cursor-anchored. On
    // cold-start (`cursorObj === undefined`) the query window is the
    // first `PAGE_SIZE + LOOKAHEAD` `task.created` events under the
    // `task-store/` prefix. On subsequent paginated calls it is the
    // same window anchored at `cursor.createdAt` — same `inclusive`
    // semantic the `since` filter exposes — so same-millisecond
    // siblings of the prior-page tail are not silently dropped. The
    // cursor-offset filter below discards the already-paged entry.
    await this.hydrateFromEventStore(cursorObj?.createdAt);

    // Reap expired entries first so listings stay consistent with reads.
    this.reapExpired();

    // FINDING-5 (#1438, T7): sort by `(createdAt ASC, taskId ASC)`
    // BEFORE pagination. Map insertion order is set by
    // `hydrateFromEventStore` (backend-listing order) on cold start and
    // by `createTask` afterward — neither is content-derived nor stable
    // across processes. Sorting by the event's durable `createdAt`
    // (with `taskId` as the tie-break for sub-millisecond ties) gives
    // every instance an identical, deterministic enumeration.
    const sorted = Array.from(this.tasks.values()).sort((a, b) => {
      if (a.task.createdAt < b.task.createdAt) return -1;
      if (a.task.createdAt > b.task.createdAt) return 1;
      if (a.task.taskId < b.task.taskId) return -1;
      if (a.task.taskId > b.task.taskId) return 1;
      return 0;
    });

    // FINDING-5 (#1438, T7): cursor-anchored offset. The decoded cursor
    // is the `(createdAt, taskId)` tuple of the LAST entry on the prior
    // page; we keep entries strictly greater than that tuple under the
    // same lex ordering as the sort.
    const afterCursor = cursorObj
      ? sorted.filter(
          (p) =>
            p.task.createdAt > cursorObj.createdAt ||
            (p.task.createdAt === cursorObj.createdAt &&
              p.task.taskId > cursorObj.taskId),
        )
      : sorted;

    const page = afterCursor.slice(0, PAGE_SIZE);
    const tasks = page.map((p) => ({ ...p.task }));
    // `nextCursor` is emitted only when there is at least one more
    // entry past this page — i.e., the page is full AND something
    // followed it in `afterCursor`. Encoding the LAST entry's
    // `(createdAt, taskId)` lets the next call resume exactly past
    // it.
    const nextCursor =
      page.length === PAGE_SIZE && afterCursor.length > PAGE_SIZE
        ? encodeListTasksCursor({
            createdAt: page[page.length - 1].task.createdAt,
            taskId: page[page.length - 1].task.taskId,
          })
        : undefined;
    return { tasks, nextCursor };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * FINDING-1 (#1438, PR 3): optimistic-concurrency write helper.
   *
   * The single entry point for every state-mutating durable write. Wraps
   * the canonical read→decide→append pattern with `expectedSequence`
   * enforcement so a sibling writer's commit between our read and our
   * append surfaces as `SequenceConflictError` rather than silent
   * last-write-wins on the stream.
   *
   * Flow per attempt:
   *   1. `loadTask` — picks up the latest projection via PR 2's
   *      cache-validation path (full refold on miss, incremental fold on
   *      stale cache).
   *   2. `decide(stored)` — the caller's pure decision function. Returns
   *      either:
   *        - `{ event, mutate }` — durable event to append + mutation to
   *          apply to the cached projection on success.
   *        - `{ event: null, mutate }` — projection-only update (no
   *          durable event; no OCC enforcement). Used for `updateTaskStatus`
   *          transitions that don't carry their own event today.
   *   3. `store.append(..., { expectedSequence: stored.lastReadSequence })`
   *      — on conflict the backend throws `SequenceConflictError`; we
   *      invalidate the cache and loop. The decide closure MUST be
   *      idempotent w.r.t. its own throws (e.g. terminal-status check)
   *      because retries re-invoke it against the latest projection.
   *
   * Retry budget is 3 (mirrors the R-2 design's `withStateRetry`
   * convention for non-idempotent decisions). Past the budget we surface
   * a `ConcurrencyError` — the `mcp/format.ts::wrapError` boundary maps
   * this to `CONCURRENCY_CONFLICT` (validTargets: ['retry']) for MCP
   * callers, and the workflow `withStateRetry` middleware already
   * recognises the type at the inner layer (`workflow/state-retry.ts:59`).
   */
  private async commitWithOcc(
    taskId: string,
    opName: string,
    decide: (
      stored: ProjectedTask,
    ) => Promise<{
      event:
        | (Partial<Omit<WorkflowEvent, 'sequence' | 'streamId'>> & {
            type: string;
          })
        | null;
      mutate: (s: ProjectedTask) => void;
    }>,
    maxRetries = 3,
  ): Promise<void> {
    let lastConflict: SequenceConflictError | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const stored = await this.loadTask(taskId);
      if (!stored) {
        throw new Error(`Task with ID ${taskId} not found`);
      }
      const { event, mutate } = await decide(stored);
      if (event === null) {
        // Projection-only update: no durable event to append, no
        // expectedSequence to enforce. The caller has opted into the
        // pre-PR-3 semantics for this code path (e.g. non-cancel
        // `updateTaskStatus` transitions). PR 2's cache-validation in
        // `loadTask` already gives this branch read-time freshness; the
        // remaining "stale decision" risk is unchanged from the prior
        // implementation.
        mutate(stored);
        return;
      }
      try {
        await this.store.append(taskStream(taskId), event, {
          expectedSequence: stored.lastReadSequence,
        });
        mutate(stored);
        stored.lastReadSequence += 1;
        return;
      } catch (err) {
        if (err instanceof SequenceConflictError) {
          // Force a full refold next iteration: the cached
          // `lastReadSequence` is provably stale, and we want the next
          // `loadTask` to re-query from scratch (rather than walk through
          // the cache-hit-plus-tail-validation path with the now-known-
          // wrong sequence number).
          lastConflict = err;
          this.tasks.delete(taskId);
          if (attempt < maxRetries) continue;
          // Fall through to the post-loop ConcurrencyError on the final
          // attempt so the boundary sees the typed envelope, not the raw
          // `SequenceConflictError`.
          break;
        }
        throw err;
      }
    }
    // Retry budget exhausted — surface as a structured `ConcurrencyError`
    // so the MCP boundary (`format.ts::wrapError`) emits the canonical
    // `CONCURRENCY_CONFLICT` envelope. We log a warning for operational
    // visibility (DIM-2) before throwing because budget exhaustion is a
    // notable event — it implies sustained write contention on this
    // specific task stream.
    taskStoreLogger.warn(
      { taskId, op: opName, attempts: maxRetries + 1 },
      'OCC retry budget exhausted',
    );
    throw new ConcurrencyError({
      streamId: taskStream(taskId),
      reducerId: 'task-store',
      expectedVersion: lastConflict?.expected ?? -1,
      actualVersion: lastConflict?.actual ?? -1,
      operationId: opName,
    });
  }

  /**
   * FINDING-6 (#1438, T8): cursor-anchored incremental hydration.
   *
   * Pre-T8 this method enumerated EVERY `task-store/*` stream via
   * `EventStore.listStreams()` and folded each via `loadTask()` — N
   * per-stream queries per `listTasks` call, where N is the total
   * number of durable tasks the substrate has ever seen. With 1,000
   * historical tasks post-restart, every `listTasks` paid 1,000
   * `EventStore.query` round-trips before pagination even began.
   *
   * Post-T8 this is bounded by `PAGE_SIZE + LOOKAHEAD = 18` regardless
   * of N. The implementation:
   *
   *   1. Query the event store ONCE for `task.created` events under the
   *      `task-store/` prefix, anchored at `sinceCreatedAt` (the cursor's
   *      timestamp; `undefined` on cold-start = no time filter).
   *   2. Cap the result at `PAGE_SIZE + LOOKAHEAD` events. The lookahead
   *      absorbs tie-break churn at the page boundary AND pre-warms the
   *      cache by one window-overlap for the next page.
   *   3. For each event, extract the taskId from the envelope `streamId`
   *      and skip if already cached. Otherwise call `loadTask` to fold
   *      that single stream — same exact code path the pre-T8 hot path
   *      used, so REPLAY semantics (INV-1) are unchanged.
   *
   * `since` filter semantics: the backend SQL is `timestamp >= ?` (see
   * `SqliteBackend.queryEventsByType`). Inclusive `since` is REQUIRED:
   * when the cursor anchors mid-tie (multiple events at the same
   * millisecond), an exclusive filter would silently skip same-
   * millisecond siblings that follow the cursor entry under the
   * `(createdAt ASC, taskId ASC)` sort. The cursor-offset filter in
   * `listTasks` discards the already-paged entry without losing its
   * timestamp-tied siblings.
   *
   * Correctness fence: any `task.created` event whose `createdAt` is
   * `>= sinceCreatedAt` and falls within the substrate's natural
   * `(timestamp, streamId, sequence)` ordering's first
   * `PAGE_SIZE + LOOKAHEAD` matches is hydrated. Events past that
   * window are picked up by the next page's query (anchored on the new
   * cursor) — they are NOT silently dropped. The known under-shoot
   * case is documented in the design (`#1438 F-6`): when more than
   * `LOOKAHEAD` events share a single millisecond AND the cursor lands
   * inside that tie cluster, the page can be short. Per the design
   * risk register the mitigation is to raise `LOOKAHEAD`.
   *
   * Failures during a per-stream load are swallowed: one malformed
   * stream MUST NOT block enumeration of healthy ones (same contract
   * as the pre-T8 enumeration). The next targeted `getTask(taskId)`
   * will surface the underlying error.
   */
  private async hydrateFromEventStore(sinceCreatedAt?: string): Promise<void> {
    // Build the filter shape that `EventStore.queryByType` consumes.
    // `since` is the inclusive ISO-timestamp lower bound (see method
    // doc above for the inclusive-vs-exclusive rationale). `limit`
    // caps the per-call query window at `PAGE_SIZE + LOOKAHEAD`.
    let events: readonly WorkflowEvent[];
    try {
      events = await this.store.queryByType('task.created', {
        streamPrefix: TASK_STREAM_PREFIX.replace(/\/$/, ''),
        ...(sinceCreatedAt !== undefined ? { since: sinceCreatedAt } : {}),
        limit: PAGE_SIZE + LOOKAHEAD,
      });
    } catch {
      // If the backend cannot service the cross-stream query (exotic
      // test fixture without `queryByType` support, or a transient
      // backend error), fall back to whatever is already cached — same
      // best-effort contract as the pre-T8 `listStreams` catch branch.
      return;
    }

    for (const event of events) {
      // The envelope `streamId` is canonical (`task-store/<taskId>`).
      // Extracting the taskId from it — rather than reaching into
      // `event.data` — keeps this loop independent of any schema
      // drift on the `task.created` data shape.
      const streamId = event.streamId;
      if (!streamId.startsWith(TASK_STREAM_PREFIX)) continue;
      const taskId = streamId.slice(TASK_STREAM_PREFIX.length);
      if (taskId.length === 0) continue;
      if (this.tasks.has(taskId)) continue;
      try {
        await this.loadTask(taskId);
      } catch {
        // best-effort — see method doc
      }
    }
  }

  /**
   * Resolve a task by id. Cache-first, with a stream-projection
   * fallback so a fresh store (post-restart, post-replay) finds tasks
   * that were created against the same event store by a prior instance.
   * Returns `undefined` (not throw) when the task has never existed.
   */
  private async loadTask(taskId: string): Promise<ProjectedTask | undefined> {
    // FINDING-2 (#1438, PR 2): cache hits MUST be validated against the
    // live stream tail before being returned. The pre-PR-2 implementation
    // returned the cached projection unconditionally, which let a sibling
    // process's `task.result` / `task.cancelled` shadow the cached
    // `working` status indefinitely (silent drift). The design here is:
    //   1. Cache hit + tail matches  → return cached.
    //   2. Cache hit + tail moved    → incremental fold of the delta
    //      (`sinceSequence: cached.lastReadSequence` is exclusive in the
    //      backend query, so we get exactly the events newer than what
    //      we already folded).
    //   3. Cache miss                → full refold from the stream.
    const cached = this.tasks.get(taskId);
    if (cached) {
      const tail = await this.store.tailSequence(taskStream(taskId));
      if (tail === cached.lastReadSequence) return cached;
      return this.refoldDelta(taskId, cached, tail);
    }
    return this.fullRefold(taskId);
  }

  /**
   * FINDING-2 (#1438): cold-path refold — query the entire stream and
   * project from scratch. Used on cache miss and as a defensive fallback
   * when the tail advanced but the delta query came back empty (e.g.,
   * transient ordering between `tailSequence` and the next `query` call
   * against the same backend).
   */
  private async fullRefold(taskId: string): Promise<ProjectedTask | undefined> {
    const events = await this.store.query(taskStream(taskId));
    if (events.length === 0) return undefined;
    const projected = projectTask(taskId, events);
    if (!projected) return undefined;
    const full: ProjectedTask = {
      ...projected,
      lastReadSequence: events[events.length - 1].sequence,
    };
    this.tasks.set(taskId, full);
    return full;
  }

  /**
   * FINDING-2 (#1438): incremental refold from a cached projection. The
   * substrate's `EventStore.query` exposes a `sinceSequence` (exclusive)
   * filter — passing `cached.lastReadSequence` returns exactly the
   * delta. No `fromSequence` API exists; `sinceSequence`'s exclusive
   * semantics give us the right shape directly (no off-by-one).
   */
  private async refoldDelta(
    taskId: string,
    cached: ProjectedTask,
    _tail: number,
  ): Promise<ProjectedTask | undefined> {
    const delta = await this.store.query(taskStream(taskId), {
      sinceSequence: cached.lastReadSequence,
    });
    // Defensive: if tail moved but the delta query came back empty
    // (rare — would require a backend-internal ordering anomaly), fall
    // back to a full refold so we never return a known-stale projection.
    if (delta.length === 0) return this.fullRefold(taskId);
    const next = projectTaskIncremental(cached, delta);
    // Stamp from the LAST sequence actually applied — not the pre-read
    // tail captured before query(). Events can land between tailSequence()
    // and query(sinceSequence), so delta may include sequences > tail;
    // recording `tail` would under-stamp and cause duplicate refolds on
    // the next read. (CodeRabbit #1444.)
    next.lastReadSequence = delta[delta.length - 1]!.sequence;
    this.tasks.set(taskId, next);
    return next;
  }

  /**
   * Whether the task is past its TTL window. Unlimited-TTL tasks
   * (`expiresAt === undefined`) never expire.
   */
  private isExpired(stored: ProjectedTask): boolean {
    return stored.expiresAt !== undefined && Date.now() > stored.expiresAt;
  }

  /**
   * Read-time TTL reaper. Sweeps the cache, dropping entries past
   * their `expiresAt`. Used by `listTasks` to keep paged output
   * consistent with the per-key `getTask` semantics.
   */
  private reapExpired(): void {
    for (const [taskId, stored] of this.tasks) {
      if (this.isExpired(stored)) {
        this.tasks.delete(taskId);
        // FINDING-3 (#1438): drop the matching throttle entry so the
        // `lastPolledAt` map stays bounded by live tasks.
        this.lastPolledAt.delete(taskId);
      }
    }
  }
}

// ─── Stream-to-state projection ────────────────────────────────────────────

/**
 * Fold a task stream's events into a `ProjectedTask`. Pure function —
 * no I/O, no clock reads (timestamps come from the events themselves).
 * Returns `undefined` when the stream is empty or malformed (no
 * `task.created`). This is the function the REPLAY acceptance test in
 * `event-sourced-task-store.test.ts` validates end-to-end.
 *
 * FINDING-2 (#1438, PR 2) note: this function is intentionally
 * sequence-unaware — it folds over event *content* and returns a
 * `ProjectedTask`-minus-`lastReadSequence`. The caller stamps the
 * `lastReadSequence` field from `events.at(-1).sequence` (or the
 * `EventStore.tailSequence` value, depending on whether the caller is
 * doing a full refold or an incremental fold). Keeping the fold pure
 * lets `projectTaskIncremental` reuse the same per-event switch logic
 * without conflating projection semantics with cache-validation
 * bookkeeping.
 */
function projectTask(
  taskId: string,
  events: readonly WorkflowEvent[],
): Omit<ProjectedTask, 'lastReadSequence'> | undefined {
  // The first event must be `task.created`; everything else folds on top.
  const created = events.find((e) => e.type === 'task.created');
  if (!created) return undefined;

  const createdData = (created.data ?? {}) as Record<string, unknown>;
  const rawTtl = createdData['ttl'];
  const ttl: Task['ttl'] =
    typeof rawTtl === 'number' && Number.isFinite(rawTtl) ? rawTtl : null;
  // FINDING-7 (#1438, T5): tolerate-and-flag malformed `request` payloads.
  // The pre-fix `?? {}` coerce silently masked corrupt event payloads
  // (missing field, `null`, non-object, array). We still coerce to an
  // empty-object `Request` so REPLAY stays robust against historical
  // bad data, but we emit a structured `logger.warn` carrying the
  // `streamId` and the offending event's `sequence` so operators can
  // locate and audit the corrupt record. Behavior is unchanged on the
  // happy path (a real object payload bypasses the warn branch).
  let request: Request;
  const rawRequest = createdData['request'];
  if (
    rawRequest === undefined ||
    rawRequest === null ||
    typeof rawRequest !== 'object' ||
    Array.isArray(rawRequest)
  ) {
    taskStoreLogger.warn(
      {
        streamId: taskStream(taskId),
        sequence: created.sequence,
        requestType: rawRequest === null ? 'null' : typeof rawRequest,
      },
      'projectTask: coerced malformed request payload',
    );
    request = {} as Request;
  } else {
    request = rawRequest as Request;
  }
  // CodeRabbit MAJOR #1431 follow-up: replay the persisted pollInterval
  // so a process restart preserves the caller-supplied cadence. Older
  // events without the field (and any payload whose value fails the
  // schema's `.int().positive()` contract — e.g., 0, negative, NaN,
  // fractional) fall back to the SDK default (1000ms).
  const rawPollInterval = createdData['pollInterval'];
  const pollInterval =
    typeof rawPollInterval === 'number' &&
    Number.isInteger(rawPollInterval) &&
    rawPollInterval > 0
      ? rawPollInterval
      : 1000;

  const createdAt = created.timestamp;
  let expiresAt = ttl !== null ? Date.parse(createdAt) + ttl : undefined;

  let task: Task = {
    taskId,
    status: 'working',
    ttl,
    createdAt,
    lastUpdatedAt: createdAt,
    pollInterval,
  };
  let result: Result | undefined;

  for (const event of events) {
    if (event === created) continue;
    switch (event.type) {
      case 'task.result': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const status = data['status'];
        if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled'
        ) {
          // Defensive statusMessage clear — kept in lockstep with
          // `projectTaskIncremental`. In a well-formed stream a
          // `task.cancelled` would never precede a `task.result`
          // (writer-side OCC enforces single-terminal-event), so the
          // local `task` shouldn't carry statusMessage here; the
          // explicit clear keeps the fold robust against
          // hand-appended or out-of-order streams and prevents the
          // two folds from drifting structurally.
          const {
            statusMessage: _staleStatusMessage,
            ...taskWithoutStatusMessage
          } = task;
          void _staleStatusMessage;
          task = {
            ...taskWithoutStatusMessage,
            status,
            lastUpdatedAt: event.timestamp,
          };
          if (data['result'] !== undefined) {
            result = data['result'] as Result;
          }
          // Mirror the writer's mutate closure (`storeTaskResult` /
          // `updateTaskStatus`): a terminal transition resets TTL from
          // the event's wall-clock timestamp. Without this bump, a
          // sibling process replaying the stream would see the original
          // created-time expiry while the writer's local cache has the
          // post-terminal value — they would then disagree on `isExpired`.
          if (ttl !== null) {
            expiresAt = Date.parse(event.timestamp) + ttl;
          }
        }
        break;
      }
      case 'task.cancelled': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        // Same hygiene as the incremental fold: clear before
        // optionally re-setting from `reason`.
        const {
          statusMessage: _staleStatusMessage,
          ...taskWithoutStatusMessage
        } = task;
        void _staleStatusMessage;
        task = {
          ...taskWithoutStatusMessage,
          status: 'cancelled',
          lastUpdatedAt: event.timestamp,
          ...(typeof data['reason'] === 'string'
            ? { statusMessage: data['reason'] }
            : {}),
        };
        if (ttl !== null) {
          expiresAt = Date.parse(event.timestamp) + ttl;
        }
        break;
      }
      default:
        // `task.polled` and unknown types are no-op for state projection.
        break;
    }
  }

  // FINDING-8 (#1438, T6): prefer the persisted `requestId` from the
  // `task.created` event payload — new events carry it verbatim so a
  // replaying process recovers the original JSON-RPC correlation id.
  // Historical events emitted before the persistence fix do NOT have
  // the field; they fall back to the `replayed:${taskId}` synthesizer
  // below. KEEP THE FALLBACK: per the F-8 design disposition, the
  // synthesizer is read-side-only and load-bearing for old events —
  // removing it would require INV-1-violating event mutation (events
  // are immutable). The SDK `RequestId` is `string | number`, so we
  // accept either shape from the payload.
  const persistedRequestId = createdData['requestId'];
  const requestId: RequestId =
    typeof persistedRequestId === 'string' ||
    typeof persistedRequestId === 'number'
      ? persistedRequestId
      : `replayed:${taskId}`;

  return {
    task,
    request,
    requestId,
    result,
    expiresAt,
  };
}

/**
 * FINDING-2 (#1438, PR 2): incremental fold from a cached projection.
 *
 * Given a previously-cached `ProjectedTask` and a `delta` of events
 * that arrived AFTER the cached `lastReadSequence`, returns a fresh
 * `ProjectedTask` reflecting the combined state. The `task.created`
 * event by construction lives at sequence 1 and is therefore never in
 * the delta (the cache always carries at least the created-state); the
 * switch body below mirrors `projectTask`'s post-created loop exactly
 * — same handlers for `task.result`, `task.cancelled`, and the no-op
 * default for `task.polled` / unknown.
 *
 * Pure function — no I/O, no clock reads. Does NOT mutate `cached`.
 * The caller is responsible for stamping the new `lastReadSequence`
 * (typically `EventStore.tailSequence(stream)` at the moment of read).
 */
function projectTaskIncremental(
  cached: ProjectedTask,
  delta: readonly WorkflowEvent[],
): ProjectedTask {
  let task: Task = { ...cached.task };
  let result: Result | undefined = cached.result;
  let expiresAt: number | undefined = cached.expiresAt;

  for (const event of delta) {
    switch (event.type) {
      case 'task.result': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        const status = data['status'];
        if (
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled'
        ) {
          // CodeRabbit r3253923003 (#1444): drop any stale
          // projection-only `statusMessage` carried on `cached.task`
          // (e.g. an `input_required` prompt set on this process via
          // `updateTaskStatus`, which never emits a durable event).
          // The `task.result` event has no statusMessage field, so a
          // fresh-process replayer (`projectTask` on the same stream)
          // produces a terminal task with NO `statusMessage` — without
          // this explicit clear, the incremental fold path would
          // diverge from the full-refold path on exactly this case,
          // violating INV-1 cross-process consistency.
          const {
            statusMessage: _staleStatusMessage,
            ...taskWithoutStatusMessage
          } = task;
          void _staleStatusMessage;
          task = {
            ...taskWithoutStatusMessage,
            status,
            lastUpdatedAt: event.timestamp,
          };
          if (data['result'] !== undefined) {
            result = data['result'] as Result;
          }
          // Terminal-transition TTL bump — see `projectTask` for the
          // why. The two folds must stay observationally equivalent.
          if (task.ttl !== null) {
            expiresAt = Date.parse(event.timestamp) + task.ttl;
          }
        }
        break;
      }
      case 'task.cancelled': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        // Same statusMessage-hygiene as `task.result`: clear any stale
        // value before optionally setting from the event's `reason`.
        // Cancellation may carry a fresh diagnostic; absent that, the
        // prior projection-only prompt MUST not leak through.
        const {
          statusMessage: _staleStatusMessage,
          ...taskWithoutStatusMessage
        } = task;
        void _staleStatusMessage;
        task = {
          ...taskWithoutStatusMessage,
          status: 'cancelled',
          lastUpdatedAt: event.timestamp,
          ...(typeof data['reason'] === 'string'
            ? { statusMessage: data['reason'] }
            : {}),
        };
        if (task.ttl !== null) {
          expiresAt = Date.parse(event.timestamp) + task.ttl;
        }
        break;
      }
      default:
        // `task.polled` and unknown types are no-op for state projection
        // — same as `projectTask`. Keep both branches in lockstep.
        break;
    }
  }

  return {
    task,
    request: cached.request,
    requestId: cached.requestId,
    result,
    expiresAt,
    lastReadSequence: cached.lastReadSequence,
  };
}

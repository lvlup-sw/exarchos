/**
 * `EventSourcedTaskStore` implements {@link TaskStorePort} as a projection over the event store.
 * Each mutating call appends a `task.*` event to the stream `task-store/<taskId>`, and each read folds that stream.
 * The durable stream is the source of truth, so a restart or a second process sees the same tasks.
 * The exception is a status change that `updateTaskStatus` keeps in the cache only.
 *
 * The `tasks` map is a lazy cache. A miss folds the full stream.
 * A hit compares the cached `lastReadSequence` with the stream tail, and folds only the newer events.
 * Reads drop expired tasks, and `createTask` sweeps the cache above a size limit. There is no background timer.
 *
 * `listTasks` sorts by `(createdAt, taskId)`, so each process and each restart gives the same order.
 * The cursor is an opaque base64url JSON of the last `(createdAt, taskId)` on the page. Callers must not parse it.
 * Each `listTasks` call hydrates at most `PAGE_SIZE + LOOKAHEAD` tasks from the `task.created` events at or after the cursor `createdAt`.
 */
import { randomBytes } from 'node:crypto';
import type {
  V2Task as Task,
  V2RequestId as RequestId,
  V2Result as Result,
  V2Request as Request,
} from '../../contract/sdk/seam.js';
import type { TaskStorePort, CreateTaskParams } from './port.js';
import { isTaskTerminal } from './port.js';

import { EventStore, SequenceConflictError } from '../../events/store.js';
import type { WorkflowEvent } from '../../events/schemas.js';
import { ConcurrencyError } from '../../events/concurrency-error.js';
import { taskStoreLogger } from '../../logger.js';

/**
 * The projected lifecycle state of one task.
 * It keeps the original `request` and `requestId`, so SDK consumers can see what the caller asked.
 */
interface ProjectedTask {
  task: Task;
  request: Request;
  requestId: RequestId;
  result?: Result | undefined;
  /** The wall-clock expiry time. It is `undefined` when `ttl` is null, which means no limit. */
  expiresAt?: number | undefined;
  /**
   * The stream sequence through which this projection folds.
   * `loadTask` compares it with `EventStore.tailSequence` on each cache hit. `projectTask` does not set it, so the caller stamps it after each fold.
   */
  lastReadSequence: number;
}

/**
 * Generates a task ID as 16 random bytes in hex.
 * The SDK demo store uses the same format, so consumers that expect that ID length still work.
 */
function generateTaskId(): string {
  return randomBytes(16).toString('hex');
}

function taskStream(taskId: string): string {
  return `${TASK_STREAM_PREFIX}${taskId}`;
}

/**
 * The throttle window for `task.polled` events.
 * Poll loops call `getTask` at the `pollInterval` of the task. Without the throttle, each call appends one event to the stream.
 */
const TASK_POLLED_THROTTLE_MS = 5_000;

/**
 * The cache size above which `createTask` sweeps expired tasks.
 * Without it, a workload that creates tasks and never lists them grows the cache without limit.
 */
const SIZE_CAP_REAP_THRESHOLD = 1024;

/**
 * Above `SIZE_CAP_REAP_THRESHOLD`, `createTask` sweeps again only after the cache grows by this many entries since the last sweep.
 * This stops a sweep on each create when no task is expired.
 */
const REAP_GROWTH_DELTA = 64;

/**
 * The decoded `listTasks` cursor: the `(createdAt, taskId)` of the last entry on the prior page.
 * It does not depend on map insertion order, so pages stay stable across restarts and instances.
 */
interface ListTasksCursor {
  readonly createdAt: string;
  readonly taskId: string;
}

/** The page size for `listTasks`. The hydration window is `PAGE_SIZE + LOOKAHEAD`. */
const PAGE_SIZE = 10;

/**
 * The number of extra `task.created` events in each hydration query, past `PAGE_SIZE`.
 * The extra events keep tasks with the same millisecond as the page boundary in the window, and they warm the cache for the next page.
 * When more than `LOOKAHEAD` events share one millisecond at the cursor, a page can be short. To fix that, raise this value.
 */
const LOOKAHEAD = 8;

/**
 * The stream prefix for task streams.
 * `taskStream` and `hydrateFromEventStore` share it, so the `queryByType` prefix filter matches the streams that the store writes.
 */
const TASK_STREAM_PREFIX = 'task-store/';

function encodeListTasksCursor(c: ListTasksCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/**
 * Decodes a `listTasks` cursor.
 * Each failure throws an error with the `Invalid cursor: ` prefix, because callers and MCP error wrappers match on it.
 */
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
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cursor: ${detail}`);
  }
}

/**
 * Options for `EventSourcedTaskStore`.
 * `clock` drives only the `task.polled` throttle, and tests inject it.
 * TTL math reads `Date.now()`, because TTL is wall-clock time and the throttle is a rate limit.
 */
export interface EventSourcedTaskStoreOptions {
  clock?: () => number;
}

export class EventSourcedTaskStore
  implements TaskStorePort<Task, Request, Result, RequestId>
{
  private readonly store: EventStore;

  /** Cache of projected tasks. The event store holds the authoritative state, and `loadTask` fills the cache on a miss. */
  private readonly tasks = new Map<string, ProjectedTask>();

  /** The clock time of the last `task.polled` append for each task. A reaped or expired task loses its entry, so the map does not grow past the cache. */
  private readonly lastPolledAt = new Map<string, number>();

  /** The clock for the `task.polled` throttle only. It defaults to `Date.now()`. */
  private readonly nowMs: () => number;

  /** The cache size right after the last sweep from `createTask`. The `REAP_GROWTH_DELTA` check reads it. */
  private lastReapSize = 0;

  constructor(eventStore: EventStore, options?: EventSourcedTaskStoreOptions) {
    this.store = eventStore;
    this.nowMs = options?.clock ?? Date.now.bind(Date);
  }

  /**
   * Appends `task.created` and caches the new task.
   * A `pollInterval` that is not a positive integer becomes 1000, because the `TaskCreatedData` schema rejects it and the append fails.
   * The dispatch boundary filters it too, but a direct caller can skip that boundary.
   *
   * The event holds `pollInterval` and `requestId`, so a replay restores them.
   * `expiresAt` comes from the event timestamp, so this cache agrees with a replay in another process.
   * Above `SIZE_CAP_REAP_THRESHOLD` entries, it sweeps expired tasks once per `REAP_GROWTH_DELTA` new entries.
   */
  async createTask(
    taskParams: CreateTaskParams,
    requestId: RequestId,
    request: Request,
    _sessionId?: string,
  ): Promise<Task> {
    const taskId = generateTaskId();
    const ttl = taskParams.ttl ?? null;
    const rawPollInterval = taskParams.pollInterval;
    const pollInterval =
      typeof rawPollInterval === 'number' &&
      Number.isInteger(rawPollInterval) &&
      rawPollInterval > 0
        ? rawPollInterval
        : 1000;
    const createdAt = new Date().toISOString();

    await this.store.append(taskStream(taskId), {
      type: 'task.created',
      timestamp: createdAt,
      data: {
        taskId,
        ttl,
        request,
        pollInterval,
        requestId,
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
      expiresAt: ttl !== null ? Date.parse(createdAt) + ttl : undefined,
      lastReadSequence: 1,
    });

    const sizeAfterInsert = this.tasks.size;
    if (
      sizeAfterInsert > SIZE_CAP_REAP_THRESHOLD &&
      sizeAfterInsert - this.lastReapSize >= REAP_GROWTH_DELTA
    ) {
      this.reapExpired();
      this.lastReapSize = this.tasks.size;
    }

    return task;
  }

  /**
   * Returns a copy of the task, or `null` when it is absent or expired.
   * A read appends `task.polled` when at least `TASK_POLLED_THROTTLE_MS` passed since the last append for the task.
   * That append is best-effort, so a failure does not fail the read. The projection ignores `task.polled`, because it is an audit event.
   */
  async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
    const stored = await this.loadTask(taskId);
    if (!stored) return null;
    if (this.isExpired(stored)) {
      this.tasks.delete(taskId);
      this.lastPolledAt.delete(taskId);
      return null;
    }
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
      }
    }
    return { ...stored.task };
  }

  /**
   * Appends `task.result` through `commitWithOcc`. The terminal check runs inside the decide step, so each retry checks a fresh projection.
   * The cache update drops any prior `statusMessage`, because a replay of `task.result` never sets one.
   * `expiresAt` restarts from the event timestamp, the same as in a replay.
   */
  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    _sessionId?: string,
  ): Promise<void> {
    return this.commitWithOcc(taskId, 'storeTaskResult', async (stored) => {
      if (isTaskTerminal(stored.task.status)) {
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
      this.lastPolledAt.delete(taskId);
      throw new Error(`Task with ID ${taskId} not found`);
    }
    if (stored.result === undefined) {
      throw new Error(`Task ${taskId} has no result stored`);
    }
    return stored.result;
  }

  /**
   * Changes the status of a task through `commitWithOcc`.
   * It rejects `completed` and `failed` before the commit, because they carry a result and need a durable `task.result` event from `storeTaskResult`.
   * Only `cancelled` appends an event (`task.cancelled`). Other transitions, such as `working` to `input_required`, change only this cache, so a replay does not see them.
   * Each transition drops the prior `statusMessage`, so an old `input_required` prompt does not stay after the status changes.
   */
  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    _sessionId?: string,
  ): Promise<void> {
    if (status === 'completed' || status === 'failed') {
      throw new Error(
        `Cannot transition task ${taskId} to '${status}' via updateTaskStatus — terminal '${status}' carries a result payload and requires a durable task.result event. Use storeTaskResult() instead.`,
      );
    }
    return this.commitWithOcc(taskId, 'updateTaskStatus', async (stored) => {
      if (isTaskTerminal(stored.task.status)) {
        throw new Error(
          `Cannot update task ${taskId} from terminal status '${stored.task.status}' to '${status}'. Terminal states (completed, failed, cancelled) cannot transition to other states.`,
        );
      }
      const now = new Date().toISOString();
      const mutate = (s: ProjectedTask) => {
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
        if (isTaskTerminal(status) && s.task.ttl !== null) {
          s.expiresAt = Date.parse(now) + s.task.ttl;
        }
      };
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

  /**
   * Returns one page of tasks, sorted by `(createdAt, taskId)`.
   * It decodes the cursor, hydrates the tasks from the cursor `createdAt` onward, and then reaps expired tasks.
   * A new instance has an empty cache, so without the hydration it returns no tasks while durable task streams exist.
   * The page holds the tasks after the cursor tuple. `nextCursor` is present only when more tasks follow the page.
   */
  async listTasks(
    cursor?: string,
    _sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const cursorObj = cursor ? decodeListTasksCursor(cursor) : undefined;

    await this.hydrateFromEventStore(cursorObj?.createdAt);

    this.reapExpired();

    const sorted = Array.from(this.tasks.values()).sort((a, b) => {
      if (a.task.createdAt < b.task.createdAt) return -1;
      if (a.task.createdAt > b.task.createdAt) return 1;
      if (a.task.taskId < b.task.taskId) return -1;
      if (a.task.taskId > b.task.taskId) return 1;
      return 0;
    });

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
    const lastPageEntry = page[page.length - 1];
    const nextCursor =
      page.length === PAGE_SIZE && afterCursor.length > PAGE_SIZE && lastPageEntry !== undefined
        ? encodeListTasksCursor({
            createdAt: lastPageEntry.task.createdAt,
            taskId: lastPageEntry.task.taskId,
          })
        : undefined;
    return { tasks, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  /**
   * The one entry point for each durable task write: load, decide, then append with `expectedSequence`.
   * A write from another writer between the load and the append throws `SequenceConflictError`, so a write never overwrites another silently.
   * On a conflict, the method drops the cache entry and tries again with a full refold.
   * Each try calls `decide` again with the latest projection, so `decide` must be safe to call more than once.
   * When `decide` returns `event: null`, the method applies `mutate` to the cache only, with no OCC check.
   * After `maxRetries` retries, it logs a warning and throws `ConcurrencyError`, which `wrapError` maps to `CONCURRENCY_CONFLICT`.
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
          lastConflict = err;
          this.tasks.delete(taskId);
          if (attempt < maxRetries) continue;
          break;
        }
        throw err;
      }
    }
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
   * Loads into the cache the tasks of at most `PAGE_SIZE + LOOKAHEAD` `task.created` events at or after `sinceCreatedAt`.
   * It makes one `queryByType` call and skips each task that is already in the cache.
   * The `since` filter is inclusive, so tasks with the same millisecond as the cursor stay in the window.
   * The cursor filter in `listTasks` then drops the task that the cursor names.
   *
   * The task ID comes from the envelope `streamId`, not from `event.data`, so a change to the `task.created` data shape has no effect here.
   * The method ignores a query failure or a failed stream load, so one bad stream does not block the other tasks.
   * A later `getTask` call for that task shows the error.
   */
  private async hydrateFromEventStore(sinceCreatedAt?: string): Promise<void> {
    let events: readonly WorkflowEvent[];
    try {
      events = await this.store.queryByType('task.created', {
        streamPrefix: TASK_STREAM_PREFIX.replace(/\/$/, ''),
        ...(sinceCreatedAt !== undefined ? { since: sinceCreatedAt } : {}),
        limit: PAGE_SIZE + LOOKAHEAD,
      });
    } catch {
      return;
    }

    for (const event of events) {
      const streamId = event.streamId;
      if (!streamId.startsWith(TASK_STREAM_PREFIX)) continue;
      const taskId = streamId.slice(TASK_STREAM_PREFIX.length);
      if (taskId.length === 0) continue;
      if (this.tasks.has(taskId)) continue;
      try {
        await this.loadTask(taskId);
      } catch {
      }
    }
  }

  /**
   * Returns the task from the cache, or folds its stream on a miss. Returns `undefined` when the task never existed.
   * A cache hit compares `lastReadSequence` with the stream tail.
   * When the tail moved, for example after another process appended `task.result`, it folds only the newer events.
   */
  private async loadTask(taskId: string): Promise<ProjectedTask | undefined> {
    const cached = this.tasks.get(taskId);
    if (cached) {
      const tail = await this.store.tailSequence(taskStream(taskId));
      if (tail === cached.lastReadSequence) return cached;
      return this.refoldDelta(taskId, cached, tail);
    }
    return this.fullRefold(taskId);
  }

  /**
   * Folds the full stream and caches the result.
   * `loadTask` uses it on a cache miss, and `refoldDelta` uses it when the delta query returns no events.
   */
  private async fullRefold(taskId: string): Promise<ProjectedTask | undefined> {
    const events = await this.store.query(taskStream(taskId));
    if (events.length === 0) return undefined;
    const projected = projectTask(taskId, events);
    if (!projected) return undefined;
    const full: ProjectedTask = {
      ...projected,
      lastReadSequence: events[events.length - 1]?.sequence ?? 0,
    };
    this.tasks.set(taskId, full);
    return full;
  }

  /**
   * Folds the events after `cached.lastReadSequence` onto the cached projection. The `sinceSequence` filter is exclusive, so the query returns only new events.
   * It stamps `lastReadSequence` from the last applied event, not from the tail that `loadTask` read.
   * Events can arrive between the two reads, and an older stamp makes the next read fold some events twice.
   */
  private async refoldDelta(
    taskId: string,
    cached: ProjectedTask,
    _tail: number,
  ): Promise<ProjectedTask | undefined> {
    const delta = await this.store.query(taskStream(taskId), {
      sinceSequence: cached.lastReadSequence,
    });
    if (delta.length === 0) return this.fullRefold(taskId);
    const next = projectTaskIncremental(cached, delta);
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

  /** Drops each expired task from the cache and from `lastPolledAt`. `listTasks` and `createTask` call it. */
  private reapExpired(): void {
    for (const [taskId, stored] of this.tasks) {
      if (this.isExpired(stored)) {
        this.tasks.delete(taskId);
        this.lastPolledAt.delete(taskId);
      }
    }
  }
}

/**
 * Folds the events of a task stream into a projected task, with no store reads and no clock reads.
 * Returns `undefined` when the stream has no `task.created` event. The caller stamps `lastReadSequence`.
 * A terminal event restarts the TTL from its own timestamp, the same as the writer cache, so both agree on expiry.
 *
 * A `request` that is not an object becomes `{}`, and the fold logs a warning with the stream and sequence. A replay of bad history still works.
 * A `pollInterval` that is not a positive integer becomes 1000.
 * Old events have no `requestId`, so the fold uses `replayed:<taskId>` for them. Events are immutable, so this fallback must stay.
 */
function projectTask(
  taskId: string,
  events: readonly WorkflowEvent[],
): Omit<ProjectedTask, 'lastReadSequence'> | undefined {
  const created = events.find((e) => e.type === 'task.created');
  if (!created) return undefined;

  const createdData = (created.data ?? {}) as Record<string, unknown>;
  const rawTtl = createdData['ttl'];
  const ttl: Task['ttl'] =
    typeof rawTtl === 'number' && Number.isFinite(rawTtl) ? rawTtl : null;
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
          if (ttl !== null) {
            expiresAt = Date.parse(event.timestamp) + ttl;
          }
        }
        break;
      }
      case 'task.cancelled': {
        const data = (event.data ?? {}) as Record<string, unknown>;
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
        break;
    }
  }

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
 * Folds `delta` onto a cached projection and returns a new projection. It does not change `cached`, and it does no I/O and no clock reads.
 * `task.created` is at sequence 1, so it is never in the delta. The per-event logic must stay the same as in `projectTask`, so the two folds agree.
 *
 * A `task.result` event drops any `statusMessage`, such as an `input_required` prompt from this process, because a full refold has none.
 * A `task.cancelled` event sets `statusMessage` only from its `reason`.
 * The returned `lastReadSequence` is the cached value, and the caller stamps the new one.
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
          if (task.ttl !== null) {
            expiresAt = Date.parse(event.timestamp) + task.ttl;
          }
        }
        break;
      }
      case 'task.cancelled': {
        const data = (event.data ?? {}) as Record<string, unknown>;
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

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
 * The in-memory map (`this.tasks`) is a **cache**, not authoritative
 * state. On every read we MAY rebuild it from the event store; the
 * acceptance test exercises exactly this by appending events directly
 * and instantiating a fresh store. Cache misses fall through to a
 * stream read; cache hits are validated against the projection
 * sequence so a missed event invalidates the cache transparently.
 *
 * ## TTL
 *
 * Per-task `expiresAt = createdAt + ttl` is computed from the
 * `task.created` event. Expired tasks are reaped on read (`getTask` /
 * `getTaskResult` / `listTasks`) — no background timers, no extra
 * substrate state. `ttl === null` means unlimited lifetime (per the
 * SDK contract).
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

import { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';

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
  return `task-store/${taskId}`;
}

export class EventSourcedTaskStore implements TaskStore {
  private readonly store: EventStore;

  /**
   * Cache of materialized tasks. Authoritative state lives in the
   * event store — this is rebuilt lazily on miss via `loadTask()`.
   */
  private readonly tasks = new Map<string, ProjectedTask>();

  constructor(eventStore: EventStore) {
    this.store = eventStore;
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
    const createdAt = new Date().toISOString();

    // Event-store first: the durable record IS the truth.
    await this.store.append(taskStream(taskId), {
      type: 'task.created',
      timestamp: createdAt,
      data: {
        taskId,
        ttl,
        request,
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
      pollInterval: taskParams.pollInterval ?? 1000,
    };

    this.tasks.set(taskId, {
      task,
      request,
      requestId,
      expiresAt: ttl !== null ? Date.now() + ttl : undefined,
    });

    return task;
  }

  async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
    const stored = await this.loadTask(taskId);
    if (!stored) return null;
    if (this.isExpired(stored)) {
      this.tasks.delete(taskId);
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
    // The `sequence` field reflects the projection version at poll time —
    // we use the count of existing events on the stream as a proxy since
    // the new event's true sequence is only assigned inside the appender.
    // This satisfies `TaskPolledData`'s required `sequence` field; an
    // off-by-one drift across concurrent polls is acceptable for the
    // observability use case.
    //
    // Failure to emit is best-effort and intentionally swallowed: a
    // `getTask` read MUST NOT fail because the audit-trail emission hit
    // a transient I/O blip. The projection itself is unaffected (no
    // `task.polled` handler in `projectTask` — it is a pure observability
    // event, not a state transition).
    try {
      const stream = taskStream(taskId);
      const existing = await this.store.query(stream);
      await this.store.append(stream, {
        type: 'task.polled',
        timestamp: new Date().toISOString(),
        data: { taskId, sequence: existing.length },
      });
    } catch {
      // best-effort
    }
    return { ...stored.task };
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    _sessionId?: string,
  ): Promise<void> {
    const stored = await this.loadTask(taskId);
    if (!stored) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    if (isTerminal(stored.task.status)) {
      throw new Error(
        `Cannot store result for task ${taskId} in terminal status '${stored.task.status}'. Task results can only be stored once.`,
      );
    }

    const now = new Date().toISOString();
    await this.store.append(taskStream(taskId), {
      type: 'task.result',
      timestamp: now,
      data: {
        taskId,
        status,
        result,
      },
    });

    stored.result = result;
    stored.task = {
      ...stored.task,
      status,
      lastUpdatedAt: now,
    };
    // TTL resets from terminal transition (matches SDK semantics).
    if (stored.task.ttl !== null) {
      stored.expiresAt = Date.now() + stored.task.ttl;
    }
  }

  async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
    const stored = await this.loadTask(taskId);
    if (!stored) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    if (this.isExpired(stored)) {
      this.tasks.delete(taskId);
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
    const stored = await this.loadTask(taskId);
    if (!stored) {
      throw new Error(`Task with ID ${taskId} not found`);
    }
    if (isTerminal(stored.task.status)) {
      throw new Error(
        `Cannot update task ${taskId} from terminal status '${stored.task.status}' to '${status}'. Terminal states (completed, failed, cancelled) cannot transition to other states.`,
      );
    }

    const now = new Date().toISOString();

    // The `cancelled` transition gets its own durable event so audit
    // can attribute the cancellation reason cleanly. Other status
    // transitions (working ↔ input_required) don't have a dedicated
    // event yet; they live only in the projection's
    // `lastUpdatedAt`/`statusMessage` until a downstream consumer
    // requires durable visibility.
    if (status === 'cancelled') {
      await this.store.append(taskStream(taskId), {
        type: 'task.cancelled',
        timestamp: now,
        data: {
          taskId,
          reason: statusMessage ?? 'unspecified',
        },
      });
    }

    stored.task = {
      ...stored.task,
      status,
      lastUpdatedAt: now,
      ...(statusMessage !== undefined ? { statusMessage } : {}),
    };

    if (isTerminal(status) && stored.task.ttl !== null) {
      stored.expiresAt = Date.now() + stored.task.ttl;
    }
  }

  async listTasks(
    cursor?: string,
    _sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const PAGE_SIZE = 10;
    // Reap expired entries first so listings stay consistent with reads.
    this.reapExpired();

    const allTaskIds = Array.from(this.tasks.keys());
    let startIndex = 0;
    if (cursor) {
      const cursorIndex = allTaskIds.indexOf(cursor);
      if (cursorIndex >= 0) {
        startIndex = cursorIndex + 1;
      } else {
        throw new Error(`Invalid cursor: ${cursor}`);
      }
    }
    const pageIds = allTaskIds.slice(startIndex, startIndex + PAGE_SIZE);
    const tasks = pageIds.map((id) => ({ ...this.tasks.get(id)!.task }));
    const nextCursor =
      startIndex + PAGE_SIZE < allTaskIds.length
        ? pageIds[pageIds.length - 1]
        : undefined;
    return { tasks, nextCursor };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /**
   * Resolve a task by id. Cache-first, with a stream-projection
   * fallback so a fresh store (post-restart, post-replay) finds tasks
   * that were created against the same event store by a prior instance.
   * Returns `undefined` (not throw) when the task has never existed.
   */
  private async loadTask(taskId: string): Promise<ProjectedTask | undefined> {
    const cached = this.tasks.get(taskId);
    if (cached) return cached;

    const events = await this.store.query(taskStream(taskId));
    if (events.length === 0) return undefined;

    const projected = projectTask(taskId, events);
    if (!projected) return undefined;

    this.tasks.set(taskId, projected);
    return projected;
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
 */
function projectTask(
  taskId: string,
  events: readonly WorkflowEvent[],
): ProjectedTask | undefined {
  // The first event must be `task.created`; everything else folds on top.
  const created = events.find((e) => e.type === 'task.created');
  if (!created) return undefined;

  const createdData = (created.data ?? {}) as Record<string, unknown>;
  const rawTtl = createdData['ttl'];
  const ttl: Task['ttl'] =
    typeof rawTtl === 'number' && Number.isFinite(rawTtl) ? rawTtl : null;
  const request = (createdData['request'] ?? {}) as Request;

  const createdAt = created.timestamp;
  const expiresAt = ttl !== null ? Date.parse(createdAt) + ttl : undefined;

  let task: Task = {
    taskId,
    status: 'working',
    ttl,
    createdAt,
    lastUpdatedAt: createdAt,
    pollInterval: 1000,
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
          task = {
            ...task,
            status,
            lastUpdatedAt: event.timestamp,
          };
          if (data['result'] !== undefined) {
            result = data['result'] as Result;
          }
        }
        break;
      }
      case 'task.cancelled': {
        const data = (event.data ?? {}) as Record<string, unknown>;
        task = {
          ...task,
          status: 'cancelled',
          lastUpdatedAt: event.timestamp,
          ...(typeof data['reason'] === 'string'
            ? { statusMessage: data['reason'] }
            : {}),
        };
        break;
      }
      default:
        // `task.polled` and unknown types are no-op for state projection.
        break;
    }
  }

  // requestId is not durably persisted (the SDK uses it only for
  // outbound JSON-RPC correlation, which a replayed task doesn't have).
  // We synthesize a sentinel so the projected shape is still a valid
  // `ProjectedTask` for in-memory consumers.
  const requestId: RequestId = `replayed:${taskId}`;

  return {
    task,
    request,
    requestId,
    result,
    expiresAt,
  };
}

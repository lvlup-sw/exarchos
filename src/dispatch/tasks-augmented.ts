/**
 * The Tasks-augmented dispatch branch. The MCP `tools/call` adapter and the CLI `--follow` loop build
 * on this surface. They must not implement task creation again.
 *
 * A `task` object on the dispatched args is the augmentation signal. Without it, the one-shot path
 * applies. `runTasksAugmented` creates the task, starts `execute()` in the background, and returns
 * the `CreateTaskResult` envelope at once. `taskStore.storeTaskResult()` then records the result as
 * a `task.result` event.
 *
 * The background run re-enters the dispatch context that was active at the call. Its events thus
 * share the `operationId` of the parent dispatch, after the parent returns.
 * `tests/outcome/tasks-dispatch-lifecycle.test.ts` covers this.
 *
 * `CreateTaskParams` comes from the task-store port, not the SDK seam, because no SDK generation
 * supplies it.
 */
import type {
  V2Request as Request,
  V2RequestId as RequestId,
  V2Result as Result,
} from '../contract/sdk/seam.js';
import type { CreateTaskParams } from '../projections/task-store/port.js';

import type { ToolResult } from '../format.js';
import type { EventSourcedTaskStore } from '../projections/task-store/event-sourced-task-store.js';
import {
  getDispatchContext,
  runWithDispatchContext,
} from './dispatch-context.js';

/**
 * True when the dispatched args carry `task` as a non-array object. Dispatch sees raw args before a
 * Zod parse, so the check rejects null, primitives, and arrays.
 */
export function isTaskAugmented(args: Record<string, unknown>): boolean {
  if (!('task' in args)) return false;
  const value = args.task;
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return true;
}

/** A type guard for a finite, non-negative number. */
function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * A type guard for a positive integer. It must match the `TaskCreatedData.pollInterval` schema,
 * `.int().positive()`. A looser check admits `0.5` or `0`, and the event append then fails without
 * a report.
 */
function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Extract typed `CreateTaskParams` from a raw `args.task` value. A malformed input gives an empty
 * object. The field checks match the `TaskCreatedData` schema: `ttl` is non-negative, and
 * `pollInterval` is a positive integer. The function drops an invalid field, so the `createTask`
 * default applies. It uses conditional spreads because the `CreateTaskParams` fields are `readonly`.
 */
export function extractTaskOptions(value: unknown): CreateTaskParams {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const rec = value as Record<string, unknown>;
  return {
    ...(isNonNegativeNumber(rec.ttl) ? { ttl: rec.ttl } : {}),
    ...(isPositiveInteger(rec.pollInterval) ? { pollInterval: rec.pollInterval } : {}),
  };
}

export interface RunTasksAugmentedArgs {
  readonly taskStore: EventSourcedTaskStore;
  readonly taskOptions: CreateTaskParams;
  readonly requestId: RequestId;
  readonly request: Request;
  /**
   * The one-shot handler. It runs in the background after the `CreateTaskResult` envelope returns.
   * Its outcome goes into a `task.result` event.
   */
  readonly execute: () => Promise<ToolResult>;
  /** The session id for the task store. Direct in-process callers, such as the CLI, have none. */
  readonly sessionId?: string;
}

/**
 * Create the task, start the handler in the background, and return the task in a `ToolResult`. The
 * `task.created` event is appended before the return, so an immediate `tasks/get` finds the task.
 * The run starts on a later microtask, so the response returns before the handler starts.
 *
 * A successful result stores `completed`, and a failure or a throw stores `failed`. The store keeps
 * the full `ToolResult` under `_toolResult`. If the result store itself fails, the error is dropped,
 * and pollers see `working` until the TTL expires.
 */
export async function runTasksAugmented(
  args: RunTasksAugmentedArgs,
): Promise<ToolResult> {
  const { taskStore, taskOptions, requestId, request, execute, sessionId } = args;

  const task = await taskStore.createTask(taskOptions, requestId, request, sessionId);

  const dispatchCtx = getDispatchContext();

  const run = async (): Promise<void> => {
    let outcome: { status: 'completed' | 'failed'; result: Result };
    try {
      const handlerResult = await execute();
      if (handlerResult.success) {
        outcome = {
          status: 'completed',
          result: { _toolResult: handlerResult } as unknown as Result,
        };
      } else {
        outcome = {
          status: 'failed',
          result: { _toolResult: handlerResult } as unknown as Result,
        };
      }
    } catch (err) {
      outcome = {
        status: 'failed',
        result: {
          _toolResult: {
            success: false,
            error: {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : String(err),
            },
          },
        } as unknown as Result,
      };
    }

    try {
      await taskStore.storeTaskResult(task.taskId, outcome.status, outcome.result, sessionId);
    } catch {
    }
  };

  if (dispatchCtx) {
    void Promise.resolve().then(() => runWithDispatchContext(dispatchCtx, run));
  } else {
    void Promise.resolve().then(run);
  }

  return {
    success: true,
    data: {
      task,
    },
  };
}

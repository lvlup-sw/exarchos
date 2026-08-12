/**
 * Tasks-augmented dispatch branch — synthesis surface (#1273, T28).
 *
 * Wave C / PR 1 (dispatch-core only). The MCP `tools/call` adapter (C2) and
 * the CLI `--follow` polling loop (C3) layer on top of the surface this
 * module exports; they MUST NOT re-implement the task-creation pattern.
 *
 * ## Branch detection
 *
 * The MCP SDK's `TaskAugmentedRequestParams` introduces an optional
 * `task: { ttl?: number }` field on a request. Presence of `task` (as an
 * object value, irrespective of `ttl`) is the augmentation signal —
 * absence preserves the legacy one-shot contract. `isTaskAugmented`
 * captures exactly that test (defensive against non-object stray values,
 * since dispatch-core sees raw args before any Zod parse).
 *
 * ## Synthesis surface
 *
 * `runTasksAugmented` accepts:
 *
 *   - `taskStore`: an `EventSourcedTaskStore` (from B3 / #1272) — the
 *     canonical owner of `task.*` lifecycle events. Reusing the store
 *     keeps the lifecycle disjoint from workflow lifecycle (per the
 *     stream-layout comment in `event-sourced-task-store.ts`) and
 *     guarantees the projection in B3 remains the single source of truth.
 *   - `taskOptions`: `{ ttl?: number }` extracted from the dispatched args.
 *   - `requestId`, `request`: the MCP request that triggered this dispatch.
 *     For direct in-process callers (CLI cold-start, tests) these may be
 *     synthesised — the store records them for replay/audit; they are not
 *     load-bearing on the wire shape.
 *   - `execute`: the underlying one-shot handler. The synthesis path
 *     creates the task, kicks off `execute()` in the background, and
 *     returns the `CreateTaskResult` envelope immediately. When
 *     `execute()` resolves, the result is stamped into a `task.result`
 *     event via `taskStore.storeTaskResult()` (which emits the event on
 *     the same stream and folds it into the projection — T29).
 *
 * ## Operation-id parity
 *
 * The Tasks-augmented branch executes inside the same AsyncLocalStorage
 * scope as the parent dispatch (B1 / #1291), so every event emitted by
 * `taskStore.createTask`, `taskStore.storeTaskResult`, and the underlying
 * `execute()` call shares the dispatch's operationId. We do NOT mint a
 * separate id here; the parent `runWithDispatchContext` scope wraps this
 * call.
 *
 * The background `execute()` future is intentionally NOT awaited by the
 * synthesis surface itself — the caller's polling loop (or the
 * `tasks/result` MCP method) drives result retrieval. However, the
 * background execution must run inside the same ALS scope so its emitted
 * events share `operationId`. We capture the active ALS context at the
 * point of `runTasksAugmented` invocation and re-enter it before invoking
 * `execute()` so the background callback inherits the operationId even
 * though the parent dispatch may have already unwound. This is the load-
 * bearing detail tested in `tests/outcome/tasks-dispatch-lifecycle.test.ts`.
 */
import type {
  V2Request as Request,
  V2RequestId as RequestId,
  V2Result as Result,
} from '../sdk/seam.js';
// DR-0 / task 051: v2 DELETED `CreateTaskOptions` with the rest of the
// experimental Tasks store seam, so the replacement is the OWNED
// `CreateTaskParams` — field-for-field identical, generation-neutral, and
// imported from a module that imports nothing. It is deliberately NOT
// re-exported through the SDK seam: routing it there would claim it is drawn
// from a generation, and it is drawn from neither.
import type { CreateTaskParams } from '../projections/task-store/port.js';

import type { ToolResult } from '../format.js';
import type { EventSourcedTaskStore } from '../projections/task-store/event-sourced-task-store.js';
import {
  getDispatchContext,
  runWithDispatchContext,
} from './dispatch-context.js';

/**
 * Returns true when the caller threaded `task: <object>` into the
 * dispatched args. Presence of the `task` key with a plain-object value
 * is the augmentation signal — absence (or non-object values) preserves
 * the legacy one-shot path.
 */
export function isTaskAugmented(args: Record<string, unknown>): boolean {
  if (!('task' in args)) return false;
  const value = args.task;
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  // Arrays are `typeof === 'object'` but are not the SDK
  // `TaskAugmentedRequestParams.task` shape — reject them defensively so a
  // stray `{ task: [...] }` is not mistaken for the augmentation signal.
  if (Array.isArray(value)) return false;
  return true;
}

/**
 * Type-guard for option fields that must be finite, non-negative numbers.
 * Rejects `NaN`, `Infinity`, negative values, and non-numeric types. Used
 * to defend the `CreateTaskParams` extractor against malformed callers
 * (dispatch-core sees raw args before any Zod parse — the augmentation
 * payload is peeled off the `task` field by `isTaskAugmented` first).
 */
function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Type-guard for option fields that must be strictly positive integers.
 * Distinguished from {@link isNonNegativeNumber} because the durable
 * `TaskCreatedData.pollInterval` schema is `.int().positive().optional()`
 * — it rejects `0`, negatives, NaN, Infinity, AND non-integer floats. A
 * lax boundary that admits `0.5` or `0` would pass extraction and then
 * silently fail event-append validation inside the best-effort emit
 * (which catches every error to keep `getTask` non-fatal). Aligning the
 * extractor's validity contract with the schema's prevents that class of
 * silent failure.
 *
 * CodeRabbit MAJOR #1431: "Align pollInterval validity contract across
 * layers" — schema enforces `.int().positive()`, so the boundary must too.
 */
function isPositiveInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Extract typed `CreateTaskParams` from a raw args.task value. Returns
 * an empty options object if the input is malformed — callers should gate
 * on `isTaskAugmented` first, so this is only ever called with an object.
 * Numeric fields are validated against the same constraints the durable
 * schema (`TaskCreatedData`) enforces: `ttl` is non-negative; `pollInterval`
 * is strictly positive integer. Bogus values (negative, NaN, non-number,
 * and `0` / non-integer for `pollInterval`) are dropped silently so the
 * createTask defaults apply instead of propagating downstream where they
 * would surface as opaque setTimeout / TTL-expiry bugs or silent
 * event-append rejections.
 *
 * Built by conditional spread rather than by mutating a fresh literal (task
 * 053): the owned `CreateTaskParams` declares its fields `readonly`, which the
 * deleted `CreateTaskOptions` did not. Assigning through would need an `as`,
 * and the whole wave's remaining cast budget is five sites — a shape change
 * this local is not worth one.
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
   * The underlying one-shot handler. The synthesis surface invokes this
   * in the background after returning the CreateTaskResult envelope; its
   * resolved/rejected value is stamped into a `task.result` event.
   */
  readonly execute: () => Promise<ToolResult>;
  /**
   * Optional session id (passed through to the SDK TaskStore). Optional
   * because direct in-process callers (CLI, tests) operate without a
   * session boundary.
   */
  readonly sessionId?: string;
}

/**
 * Synthesise a CreateTaskResult envelope and dispatch the underlying
 * handler in the background. Returns immediately with the SDK-shaped
 * `{ task: { taskId, status: 'working', ttl, ... } }` payload wrapped in
 * a ToolResult so the outer dispatch surface keeps a single return type.
 *
 * Background execution semantics:
 *
 *   - The `execute()` promise runs inside the same AsyncLocalStorage
 *     dispatch context that was active at call time, so every event it
 *     emits inherits the parent dispatch's operationId (B1 / #1291).
 *   - On `execute()` fulfilment: `taskStore.storeTaskResult('completed', ...)`
 *     emits a `task.result` event with `status: 'completed'`.
 *   - On `execute()` rejection or one-shot `{ success: false }`:
 *     `storeTaskResult('failed', ...)` emits with `status: 'failed'`.
 *   - Background errors thrown by the task-store path itself (storage I/O,
 *     unexpected types) are intentionally swallowed — they have no
 *     fail-loud surface (the caller has already received the
 *     CreateTaskResult envelope). They are surfaced via the absence of a
 *     `task.result` event on the stream, which downstream pollers
 *     interpret as `working` until TTL expiry.
 */
export async function runTasksAugmented(
  args: RunTasksAugmentedArgs,
): Promise<ToolResult> {
  const { taskStore, taskOptions, requestId, request, execute, sessionId } = args;

  // Create the task synchronously — this is the event-store-first
  // ordering from B3 (`event-sourced-task-store.ts`): the `task.created`
  // event lands before the synthesised CreateTaskResult is returned, so
  // a same-tick caller polling `tasks/get` immediately after a synthesised
  // CreateTaskResult is guaranteed to find the task.
  const task = await taskStore.createTask(taskOptions, requestId, request, sessionId);

  // Capture the active dispatch context (B1 ALS scope) so the background
  // execution can re-enter it. If we are NOT inside a dispatch scope (some
  // direct in-process tests), `getDispatchContext()` returns `undefined`
  // and the background callback runs without ALS — emitted events fall
  // back to the legacy correlation defaults.
  const dispatchCtx = getDispatchContext();

  // Fire-and-poll background execution. Use a microtask boundary so the
  // synchronous return below lands first; the parent dispatch's response
  // envelope reaches the caller before any `task.result` event is appended.
  const run = async (): Promise<void> => {
    let outcome: { status: 'completed' | 'failed'; result: Result };
    try {
      const handlerResult = await execute();
      if (handlerResult.success) {
        outcome = {
          status: 'completed',
          // The SDK `Result` type permits arbitrary key/value content. We
          // pass through the handler's `data` and surface the full
          // ToolResult shape under a `_toolResult` extension so consumers
          // that need the original envelope (warnings, hints) can recover
          // it on `tasks/result`.
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
      // Storing the terminal result is best-effort; failure here means
      // pollers see the task as `working` until TTL expiry. The original
      // dispatch envelope has already been returned to the caller — this
      // is the explicit error-budget choice documented in the module
      // header.
    }
  };

  if (dispatchCtx) {
    // Schedule on the microtask queue so the caller's CreateTaskResult
    // envelope reaches them first; re-enter the ALS scope so emitted
    // events inherit operationId.
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

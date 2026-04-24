import { handleInit, handleGet, handleSet, handleReconcileState, handleCheckpoint } from './tools.js';
import { handleCancel } from './cancel.js';
import { handleCleanup } from './cleanup.js';
import { handleDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';

const workflowActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!.actions;

/**
 * HATEOAS envelope wrapping for successful tool responses (T036, DR-7).
 *
 * Successful results are re-shaped into `Envelope<T>` at the tool
 * boundary so agents see a stable contract with `next_actions`, `_meta`,
 * and `_perf` on every response. Internal callers of the underlying
 * handlers (e.g. orchestrate/prune-stale-workflows, orchestrate/finalize-
 * oneshot) continue to see the raw `ToolResult` they depend on.
 *
 * `next_actions` is populated by T040/T041's `computeNextActions` — for
 * T036 it defaults to `[]` so the field is always present.
 *
 * Error responses pass through unchanged so structured `error` payloads
 * (error codes, valid transition targets, suggested fixes) remain
 * accessible to callers for auto-correction flows.
 */
function envelopeWrap(result: ToolResult, startedAt: number): ToolResult {
  if (!result.success) return result;

  // Start with the original result's own keys (preserves `warnings`,
  // `_eventHints`, `_corrections`, etc.) then overlay envelope fields.
  const wrapped: Record<string, unknown> = { ...(result as Record<string, unknown>) };
  wrapped.success = true;
  wrapped.data = result.data;
  wrapped.next_actions = [];
  wrapped._meta = (result._meta ?? {}) as Record<string, unknown>;
  wrapped._perf = result._perf ?? { ms: Date.now() - startedAt, bytes: 0, tokens: 0 };
  return wrapped as ToolResult;
}

/**
 * Composite handler that routes `action` to the appropriate workflow handler.
 * Replaces individual init/get/set/cancel tools with a single discriminated-union tool.
 */
export async function handleWorkflow(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const { stateDir, eventStore } = ctx;
  const { action, ...rest } = args;

  switch (action) {
    case 'init':
      return envelopeWrap(await handleInit(rest as Parameters<typeof handleInit>[0], stateDir, eventStore), startedAt);
    case 'get':
      return envelopeWrap(await handleGet(rest as Parameters<typeof handleGet>[0], stateDir, eventStore), startedAt);
    case 'set': {
      const skipPhases = ctx.projectConfig?.workflow.skipPhases;
      const requiredReviews = ctx.projectConfig?.workflow.requiredReviews;
      const checkpoint = ctx.projectConfig?.checkpoint;
      const setOptions: Record<string, unknown> = {};
      if (skipPhases?.length) setOptions.skipPhases = skipPhases;
      if (requiredReviews?.length) setOptions.requiredReviews = requiredReviews;
      if (checkpoint) setOptions.checkpoint = checkpoint;
      return envelopeWrap(
        await handleSet(
          rest as Parameters<typeof handleSet>[0],
          stateDir,
          eventStore,
          Object.keys(setOptions).length > 0
            ? setOptions as Parameters<typeof handleSet>[3]
            : undefined,
        ),
        startedAt,
      );
    }
    case 'cancel':
      return envelopeWrap(await handleCancel(rest as Parameters<typeof handleCancel>[0], stateDir, eventStore), startedAt);
    case 'cleanup':
      return envelopeWrap(await handleCleanup(rest as Parameters<typeof handleCleanup>[0], stateDir, eventStore), startedAt);
    case 'reconcile':
      return envelopeWrap(await handleReconcileState(rest as Parameters<typeof handleReconcileState>[0], stateDir, eventStore), startedAt);
    case 'checkpoint':
      return envelopeWrap(await handleCheckpoint(rest as Parameters<typeof handleCheckpoint>[0], stateDir, eventStore), startedAt);
    case 'describe':
      return envelopeWrap(
        await handleDescribe(
          rest as { actions?: string[]; topology?: string; playbook?: string; config?: boolean },
          workflowActions,
          { includeStateSchema: true, projectConfig: ctx.projectConfig },
        ),
        startedAt,
      );
    default:
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${String(action)}. Valid actions: init, get, set, cancel, cleanup, reconcile, checkpoint, describe`,
        },
      };
  }
}

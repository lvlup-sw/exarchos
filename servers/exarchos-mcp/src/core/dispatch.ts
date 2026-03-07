import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { ExarchosConfig } from '../config/define.js';
import { withTelemetry } from '../telemetry/middleware.js';
import { hasCustomToolHandlers, getCustomToolActionHandler } from '../registry.js';

// Composite handlers
import { handleWorkflow } from '../workflow/composite.js';
import { handleEvent } from '../event-store/composite.js';
import { handleOrchestrate } from '../orchestrate/composite.js';
import { handleView } from '../views/composite.js';
import { handleSync } from '../sync/composite.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CompositeHandler = (
  args: Record<string, unknown>,
  stateDir: string,
) => Promise<ToolResult>;

export interface DispatchContext {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly enableTelemetry: boolean;
  readonly config?: ExarchosConfig;
}

// ─── Composite Handler Map ──────────────────────────────────────────────────

export const COMPOSITE_HANDLERS: Readonly<Record<string, CompositeHandler>> = {
  exarchos_workflow: handleWorkflow,
  exarchos_event: handleEvent,
  exarchos_orchestrate: handleOrchestrate,
  exarchos_view: handleView,
  exarchos_sync: handleSync,
};

// ─── Dispatch Function ──────────────────────────────────────────────────────

/**
 * Creates a handler for custom tools that routes to per-action handlers
 * stored in the registry. Mirrors the action-routing pattern used by
 * built-in composite handlers.
 */
function createCustomToolHandler(
  toolName: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const actionName = args.action as string | undefined;
    if (!actionName) {
      return {
        success: false,
        error: {
          code: 'MISSING_ACTION',
          message: `Custom tool "${toolName}" requires an "action" field`,
        },
      };
    }

    const actionHandler = getCustomToolActionHandler(toolName, actionName);
    if (!actionHandler) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Custom tool "${toolName}" has no handler for action "${actionName}"`,
        },
      };
    }

    const result = await actionHandler(args);
    // If the handler already returns a ToolResult, pass it through
    if (
      result !== null &&
      typeof result === 'object' &&
      'success' in (result as Record<string, unknown>)
    ) {
      return result as ToolResult;
    }
    // Otherwise wrap the result
    return { success: true, data: result };
  };
}

/**
 * Transport-agnostic dispatch: routes tool calls to composite handlers.
 *
 * 1. Looks up the tool in COMPOSITE_HANDLERS
 * 2. If not found, returns an UNKNOWN_TOOL error
 * 3. Creates a CoreHandler that binds stateDir
 * 4. Optionally wraps with telemetry
 * 5. Returns the ToolResult
 */
export async function dispatch(
  tool: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const builtInHandler = COMPOSITE_HANDLERS[tool];

  // Fall back to custom tool dispatch if not a built-in handler
  if (!builtInHandler && !hasCustomToolHandlers(tool)) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${tool}. Available tools: ${Object.keys(COMPOSITE_HANDLERS).join(', ')}`,
      },
    };
  }

  const coreHandler = builtInHandler
    ? async (a: Record<string, unknown>) => builtInHandler(a, ctx.stateDir)
    : createCustomToolHandler(tool);

  try {
    if (ctx.enableTelemetry) {
      const wrappedHandler = withTelemetry(coreHandler, tool, ctx.eventStore);
      return await wrappedHandler(args);
    }

    return await coreHandler(args);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unhandled dispatch error',
      },
    };
  }
}

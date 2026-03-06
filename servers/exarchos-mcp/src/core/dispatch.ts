import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { ExarchosConfig } from '../config/define.js';
import { withTelemetry } from '../telemetry/middleware.js';

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
  const handler = COMPOSITE_HANDLERS[tool];
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${tool}. Available tools: ${Object.keys(COMPOSITE_HANDLERS).join(', ')}`,
      },
    };
  }

  const coreHandler = async (a: Record<string, unknown>) => handler(a, ctx.stateDir);

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

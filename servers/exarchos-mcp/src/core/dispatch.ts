import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';
import type { ExarchosConfig } from '../config/define.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import type { VcsProvider } from '../vcs/provider.js';
import type { ConfigHookRunner } from '../hooks/config-hooks.js';
import type { Outbox } from '../sync/outbox.js';
import type { ChannelEmitter } from '../channel/emitter.js';
import { withTelemetry } from '../telemetry/middleware.js';
import { hasCustomToolHandlers, getCustomToolActionHandler, getFullRegistry } from '../registry.js';
import {
  formatValidationError,
  buildInvalidInput,
} from '../adapters/schema-to-flags.js';

// Composite handlers
import { handleWorkflow } from '../workflow/composite.js';
import { handleEvent } from '../event-store/composite.js';
import { handleOrchestrate } from '../orchestrate/composite.js';
import { handleView } from '../views/composite.js';
import { handleSync } from '../sync/composite.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type CompositeHandler = (
  args: Record<string, unknown>,
  ctx: DispatchContext,
) => Promise<ToolResult>;

export interface DispatchContext {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly enableTelemetry: boolean;
  readonly config?: ExarchosConfig;
  readonly projectConfig?: ResolvedProjectConfig;
  readonly vcsProvider?: VcsProvider;
  readonly hookRunner?: ConfigHookRunner;
  readonly slimRegistration?: boolean;
  readonly outbox?: Outbox;
  readonly channelEmitter?: ChannelEmitter;
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
 * Type guard for ToolResult — validates structural shape rather than
 * relying on a simple `'success' in obj` check that could match any
 * object with a `success` property.
 */
function isToolResult(value: unknown): value is ToolResult {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.success === 'boolean' &&
    (
      'data' in candidate ||
      'error' in candidate ||
      'warnings' in candidate ||
      '_meta' in candidate ||
      '_perf' in candidate ||
      '_eventHints' in candidate ||
      '_corrections' in candidate
    );
}

/**
 * Creates a handler for custom tools that routes to per-action handlers
 * stored in the registry. Mirrors the action-routing pattern used by
 * built-in composite handlers.
 */
function createCustomToolHandler(
  toolName: string,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    const actionName = args.action;
    if (typeof actionName !== 'string' || !actionName) {
      return {
        success: false,
        error: {
          code: 'MISSING_ACTION',
          message: `Custom tool "${toolName}" requires an "action" field (string)`,
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
    if (isToolResult(result)) {
      return result;
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
 * 3. Creates a CoreHandler that binds ctx
 * 4. Optionally wraps with telemetry
 * 5. Returns the ToolResult
 */
export async function dispatch(
  tool: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const builtInHandler = COMPOSITE_HANDLERS[tool];

  const registeredTool = getFullRegistry().find((t) => t.name === tool);

  // Fall back to custom tool dispatch if not a built-in handler
  // Require both registry presence AND handlers to prevent leaked handlers from bypassing registration
  if (!builtInHandler && (!registeredTool || !hasCustomToolHandlers(tool))) {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${tool}. Available tools: ${getFullRegistry().map((t) => t.name).join(', ')}`,
      },
    };
  }

  // ─── DR-5: Per-Action Schema Validation ─────────────────────────────────
  // Validate `args` against the matching action's Zod schema BEFORE routing
  // to the composite handler. This gives the MCP adapter the same
  // INVALID_INPUT rejection contract as the CLI adapter — any malformed
  // input (missing required field, wrong type, unknown action name) is
  // surfaced through a single `formatValidationError` code-path so both
  // facades emit byte-identical `error.code` values.
  //
  // Custom-tool dispatch is excluded from this validation pass because
  // custom-tool handlers may apply their own arg shaping before the
  // per-action schema is relevant.
  // Note: `builtInHandler` is typed non-nullable by the Record lookup, but
  // the earlier `!builtInHandler && ...` branch returns UNKNOWN_TOOL if the
  // tool is not built-in — so here we gate on whether the tool has a
  // built-in composite handler (not a custom one) by checking the map
  // directly against the composite-tool key set.
  const isBuiltIn = Object.prototype.hasOwnProperty.call(COMPOSITE_HANDLERS, tool);
  if (isBuiltIn && registeredTool) {
    const actionName = args.action;
    if (typeof actionName !== 'string' || !actionName) {
      return {
        success: false,
        error: buildInvalidInput(
          `${tool}: required field "action" is missing or not a string`,
        ),
      };
    }

    const matchingAction = registeredTool.actions.find((a) => a.name === actionName);
    if (!matchingAction) {
      const valid = registeredTool.actions.map((a) => a.name).join(', ');
      return {
        success: false,
        error: buildInvalidInput(
          `${tool}: unknown action "${actionName}". Valid actions: ${valid}`,
        ),
      };
    }

    const { action: _action, ...rest } = args;
    const parsed = matchingAction.schema.safeParse(rest);
    if (!parsed.success) {
      const context = `${tool}/${actionName}`;
      return {
        success: false,
        error: formatValidationError(parsed.error, context),
      };
    }

    // Thread the validated args forward so downstream handlers get the
    // coerced shape (z.preprocess effects, defaults, etc.).
    args = { action: actionName, ...parsed.data } as Record<string, unknown>;
  }

  const coreHandler = builtInHandler
    ? async (a: Record<string, unknown>) => builtInHandler(a, ctx)
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


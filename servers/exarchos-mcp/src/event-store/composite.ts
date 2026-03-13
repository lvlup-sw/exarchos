import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';
import { handleEventAppend, handleEventQuery, handleBatchAppend } from './tools.js';
import { handleEventDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';

const VALID_ACTIONS = ['append', 'query', 'batch_append', 'describe'] as const;
type EventAction = (typeof VALID_ACTIONS)[number];

const eventActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_event')!.actions;

/** Composite handler that routes `action` to the appropriate event-store handler. */
export async function handleEvent(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const { stateDir, eventStore } = ctx;
  const action = args.action as string | undefined;

  switch (action as EventAction) {
    case 'append': {
      const { action: _, ...rest } = args;
      return handleEventAppend(
        rest as Parameters<typeof handleEventAppend>[0],
        stateDir,
        eventStore,
      );
    }
    case 'query': {
      const { action: _, ...rest } = args;
      return handleEventQuery(
        rest as Parameters<typeof handleEventQuery>[0],
        stateDir,
        eventStore,
      );
    }
    case 'batch_append': {
      const { action: _, ...rest } = args;
      return handleBatchAppend(
        rest as Parameters<typeof handleBatchAppend>[0],
        stateDir,
        eventStore,
      );
    }
    case 'describe': {
      const { action: _, ...rest } = args;
      return handleEventDescribe(
        rest as { actions?: string[]; eventTypes?: string[]; emissionGuide?: boolean },
        eventActions,
      );
    }
    default:
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${action}. Valid actions: ${VALID_ACTIONS.join(', ')}`,
        },
      };
  }
}

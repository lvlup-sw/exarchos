import type { ToolResult } from '../format.js';
import { handleEventAppend, handleEventQuery, handleBatchAppend } from './tools.js';

const VALID_ACTIONS = ['append', 'query', 'batch_append'] as const;
type EventAction = (typeof VALID_ACTIONS)[number];

/** Composite handler that routes `action` to the appropriate event-store handler. */
export async function handleEvent(
  args: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  const action = args.action as string | undefined;

  switch (action as EventAction) {
    case 'append': {
      const { action: _, ...rest } = args;
      return handleEventAppend(
        rest as Parameters<typeof handleEventAppend>[0],
        stateDir,
      );
    }
    case 'query': {
      const { action: _, ...rest } = args;
      return handleEventQuery(
        rest as Parameters<typeof handleEventQuery>[0],
        stateDir,
      );
    }
    case 'batch_append': {
      const { action: _, ...rest } = args;
      return handleBatchAppend(
        rest as Parameters<typeof handleBatchAppend>[0],
        stateDir,
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

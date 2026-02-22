import { handleInit, handleGet, handleSet, handleReconcileState } from './tools.js';
import { handleCancel } from './cancel.js';
import { handleCleanup } from './cleanup.js';
import type { ToolResult } from '../format.js';

/**
 * Composite handler that routes `action` to the appropriate workflow handler.
 * Replaces individual init/get/set/cancel tools with a single discriminated-union tool.
 */
export async function handleWorkflow(
  args: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  const { action, ...rest } = args;

  switch (action) {
    case 'init':
      return handleInit(rest as Parameters<typeof handleInit>[0], stateDir);
    case 'get':
      return handleGet(rest as Parameters<typeof handleGet>[0], stateDir);
    case 'set':
      return handleSet(rest as Parameters<typeof handleSet>[0], stateDir);
    case 'cancel':
      return handleCancel(rest as Parameters<typeof handleCancel>[0], stateDir);
    case 'cleanup':
      return handleCleanup(rest as Parameters<typeof handleCleanup>[0], stateDir);
    case 'reconcile':
      return handleReconcileState(rest as Parameters<typeof handleReconcileState>[0], stateDir);
    default:
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${String(action)}. Valid actions: init, get, set, cancel, cleanup, reconcile`,
        },
      };
  }
}

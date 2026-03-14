import { handleInit, handleGet, handleSet, handleReconcileState } from './tools.js';
import { handleCancel } from './cancel.js';
import { handleCleanup } from './cleanup.js';
import { handleDescribe } from '../describe/handler.js';
import { TOOL_REGISTRY } from '../registry.js';
import type { ToolResult } from '../format.js';
import type { DispatchContext } from '../core/dispatch.js';

const workflowActions = TOOL_REGISTRY.find(t => t.name === 'exarchos_workflow')!.actions;

/**
 * Composite handler that routes `action` to the appropriate workflow handler.
 * Replaces individual init/get/set/cancel tools with a single discriminated-union tool.
 */
export async function handleWorkflow(
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const { stateDir, eventStore } = ctx;
  const { action, ...rest } = args;

  switch (action) {
    case 'init':
      return handleInit(rest as Parameters<typeof handleInit>[0], stateDir, eventStore);
    case 'get':
      return handleGet(rest as Parameters<typeof handleGet>[0], stateDir, eventStore);
    case 'set': {
      const skipPhases = ctx.projectConfig?.workflow.skipPhases;
      return handleSet(
        rest as Parameters<typeof handleSet>[0],
        stateDir,
        eventStore,
        skipPhases?.length ? { skipPhases } : undefined,
      );
    }
    case 'cancel':
      return handleCancel(rest as Parameters<typeof handleCancel>[0], stateDir, eventStore);
    case 'cleanup':
      return handleCleanup(rest as Parameters<typeof handleCleanup>[0], stateDir, eventStore);
    case 'reconcile':
      return handleReconcileState(rest as Parameters<typeof handleReconcileState>[0], stateDir, eventStore);
    case 'describe':
      return handleDescribe(
        rest as { actions?: string[]; topology?: string; playbook?: string; config?: boolean },
        workflowActions,
        { includeStateSchema: true, projectConfig: ctx.projectConfig },
      );
    default:
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${String(action)}. Valid actions: init, get, set, cancel, cleanup, reconcile, describe`,
        },
      };
  }
}

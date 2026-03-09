import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolAction } from '../registry.js';
import type { ToolResult } from '../format.js';

/**
 * Handles the `describe` action for composite tools.
 * Returns full schemas, descriptions, gate metadata, and phase/role info
 * for the requested action names.
 */
export async function handleDescribe(
  args: { actions: string[] },
  toolActions: readonly ToolAction[],
): Promise<ToolResult> {
  if (!Array.isArray(args.actions) || !args.actions.every((a: unknown) => typeof a === 'string')) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'describe requires actions: string[]',
        expectedShape: { actions: ['action_name_1', 'action_name_2'] },
      },
    };
  }

  const results: Record<string, unknown> = {};

  for (const actionName of args.actions) {
    const action = toolActions.find(a => a.name === actionName);
    if (!action) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Unknown action: ${actionName}`,
          validTargets: toolActions.map(a => a.name),
        },
      };
    }

    results[actionName] = {
      description: action.description,
      schema: zodToJsonSchema(action.schema),
      gate: (action as ToolAction & { gate?: unknown }).gate ?? null,
      phases: [...action.phases],
      roles: [...action.roles],
    };
  }

  return { success: true, data: results };
}

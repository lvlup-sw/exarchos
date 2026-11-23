/**
 * The closed table of retired actions. The registry and the generated contracts do not hold a retired action.
 * The CLI and MCP adapters read this table before contract or schema validation.
 * A retired call gets the code and the message of its row.
 * It makes no claim, configuration read, event append or process start.
 */
import type { ToolResult } from '../format.js';

/** One retired action: its composite tool, its action name, and the refusal that a call of it gets. */
export interface RetiredAction {
  readonly tool: string;
  readonly action: string;
  readonly code: string;
  readonly message: string;
}

/** The closed table. Each row names one pair of tool and action, and no registered action is in it. */
export const RETIRED_ACTIONS: readonly RetiredAction[] = Object.freeze([
  Object.freeze({
    tool: 'exarchos_orchestrate',
    action: 'mutation-adequacy',
    code: 'MUTATION_TESTING_RETIRED',
    message:
      'Exarchos retires mutation testing. A provisioned verifier runs no mutation adequacy check, and no local Stryker run replaces it.',
  }),
]);

/** The row that a call of `tool` with `args` names, or undefined when `args` names no retired action. */
export function retiredActionOf(tool: string, args: unknown): RetiredAction | undefined {
  if (typeof args !== 'object' || args === null || !('action' in args)) return undefined;
  const { action } = args;
  return RETIRED_ACTIONS.find((entry) => entry.tool === tool && entry.action === action);
}

/** The failed result of a retired call. It carries the code and the message of the row. */
export function retiredActionResult(entry: RetiredAction): ToolResult {
  return { success: false, error: { code: entry.code, message: entry.message } };
}

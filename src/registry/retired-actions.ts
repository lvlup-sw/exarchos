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

/** The one code of a retired provider write. */
const PROVIDER_WRITE_RETIRED = 'PROVIDER_WRITE_RETIRED';

/** The one message of a retired provider write. It names the harness as the owner of the write. */
const PROVIDER_WRITE_MESSAGE =
  'Exarchos retires pull request and issue writes. The harness opens, merges and comments on pull requests and opens issues with its own tools.';

/** The one code of a retired provider read. */
const PROVIDER_READ_RETIRED = 'PROVIDER_READ_RETIRED';

/** The one message of a retired provider read. It names the harness as the owner of the read. */
const PROVIDER_READ_MESSAGE =
  'Exarchos retires pull request, CI and review comment reads. The harness reads pull requests, CI checks and review comments with its own tools.';

/** The closed table. Each row names one pair of tool and action, and no registered action is in it. */
export const RETIRED_ACTIONS: readonly RetiredAction[] = Object.freeze([
  Object.freeze({
    tool: 'exarchos_orchestrate',
    action: 'mutation-adequacy',
    code: 'MUTATION_TESTING_RETIRED',
    message:
      'Exarchos retires mutation testing. A provisioned verifier runs no mutation adequacy check, and no local Stryker run replaces it.',
  }),
  Object.freeze({
    tool: 'exarchos_orchestrate',
    action: 'check_test_adequacy',
    code: 'TEST_ADEQUACY_RETIRED',
    message:
      'Exarchos retires the source-revert kill probe. No per-task gate reverts the source to judge the tests. ' +
      'Use testgen and the test-campaign skill to build and judge tests for a correctness obligation.',
  }),
  ...['create_pr', 'merge_pr', 'add_pr_comment', 'create_issue'].map((action) => Object.freeze({
    tool: 'exarchos_orchestrate',
    action,
    code: PROVIDER_WRITE_RETIRED,
    message: PROVIDER_WRITE_MESSAGE,
  })),
  ...['check_ci', 'list_prs', 'get_pr_comments', 'check_pr_comments', 'check_coderabbit', 'validate_pr_stack'].map((action) => Object.freeze({
    tool: 'exarchos_orchestrate',
    action,
    code: PROVIDER_READ_RETIRED,
    message: PROVIDER_READ_MESSAGE,
  })),
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

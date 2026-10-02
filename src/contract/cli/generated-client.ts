/**
 * The generated CLI client. It is the one CLI-side module that imports the runtime `dispatch` value.
 * The CLI addresses an action by its contract `ActionId` (`<tool>.<action>`). The seam checks the id
 * against `generated/cli-action-ids.ts` before any dispatch runs. An id that the compiled contract
 * does not contain fails at the seam, and nothing is dispatched.
 *
 * The addressing set is a static generated module that the bundler inlines. The seam does not
 * compile the contract, because the compiler pulls several MB that the CLI keeps out of its
 * cold-start import graph.
 */

import { dispatch } from '../../dispatch/core/dispatch.js';
import type { DispatchContext } from '../../dispatch/core/dispatch.js';
import type { ToolResult } from '../../format.js';
import { CLI_ACTION_IDS } from './generated/cli-action-ids.js';

/**
 * The diagnostic for an ActionId that is not in the compiled contract surface.
 * {@link invokeContractAction} returns its message in an `UNKNOWN_ACTION` error envelope, not as a throw.
 * An unknown id is a build-time drift bug, not a user-input condition.
 */
export class UnknownContractActionError extends Error {
  override readonly name = 'UnknownContractActionError';

  constructor(readonly actionId: string) {
    super(
      `ActionId "${actionId}" is not part of the compiled contract surface — ` +
        `the generated CLI client can only address actions in the generated ` +
        `contract surface (generated/cli-action-ids.ts, regenerated with the golden). ` +
        `If the action was renamed or removed, update the caller; if it is new, ` +
        `regenerate the surface before it can be addressed.`,
    );
  }
}

/** The memoized addressing set. */
let actionIds: ReadonlySet<string> | undefined;

/**
 * The ActionId set of the compiled contract surface, from `generated/cli-action-ids.ts`.
 * The dispatch path does no contract compile and no filesystem read.
 * The return type is a Promise, so call sites do not depend on the source of the set.
 */
export function contractActionIds(): Promise<ReadonlySet<string>> {
  actionIds ??= new Set(CLI_ACTION_IDS);
  return Promise.resolve(actionIds);
}

/**
 * Invokes one contract action through the shared dispatch core.
 * An `actionId` that is not in the contract surface returns an `UNKNOWN_ACTION` envelope and
 * dispatches nothing. Otherwise the function splits `(tool, action)` at the first `.` of the
 * verified id. It sends `{ action, ...args }`, which is the payload shape that the MCP wire delivers.
 */
export async function invokeContractAction(
  actionId: string,
  args: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<ToolResult> {
  const known = await contractActionIds();
  if (!known.has(actionId)) {
    const diagnostic = new UnknownContractActionError(actionId);
    const separator = actionId.indexOf('.');
    return {
      success: false,
      error: {
        code: 'UNKNOWN_ACTION',
        message: diagnostic.message,
        ...(separator > 0
          ? { tool: actionId.slice(0, separator), action: actionId.slice(separator + 1) }
          : {}),
      },
    };
  }
  const separator = actionId.indexOf('.');
  const tool = actionId.slice(0, separator);
  const action = actionId.slice(separator + 1);
  return dispatch(tool, { action, ...args }, ctx);
}

// Fixture: registrations with a handler shape that no known shape of the rule resolves.
// The rule must report each through `unresolvedHandler`, and not drop it from the census.
// It covers both census channels: an `ACTION_HANDLERS` map entry and a derived
// special-branch dispatch.
//
// It has its own file, so these reports do not change the exact count of the violating fixture.

type ToolResult =
  | { success: true; data?: unknown }
  | { success: false; error: { code: string; message: string; [key: string]: unknown } };

interface DispatchContext {
  eventStore?: unknown;
}

type ActionHandler = (
  args: Record<string, unknown>,
  stateDir: string,
  ctx?: DispatchContext,
) => Promise<ToolResult>;

function makeHandlerExternally(): ActionHandler {
  return async () => ({ success: true });
}

/**
 * A zero-arg factory that returns the result of another call, not a function literal.
 * The factory unwrap follows only a returned function literal, so this shape is unresolvable.
 */
function adaptViaIndirectReturn(): ActionHandler {
  return makeHandlerExternally();
}

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  indirect_factory_return: adaptViaIndirectReturn(),
};

function envelopeWrap(result: ToolResult, _startedAt: number): ToolResult {
  return result;
}

/**
 * A module-level binding to a handler value made elsewhere, so it has no body to scan.
 * A real branch dispatches it, so the census can name it (`unresolved_branch`) but cannot scan it.
 */
const handleUnresolvableBranch: ActionHandler = makeHandlerExternally();

async function dispatchUnresolvableBranch(
  action: string,
  rest: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  const startedAt = Date.now();
  if (action === 'unresolved_branch') {
    return envelopeWrap(await handleUnresolvableBranch(rest, stateDir), startedAt);
  }
  return { success: false, error: { code: 'UNKNOWN_ACTION', message: action } };
}

export { ACTION_HANDLERS, dispatchUnresolvableBranch };

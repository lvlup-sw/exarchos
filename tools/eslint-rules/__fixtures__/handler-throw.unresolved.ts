// Fixture: registrations whose handler shape is GENUINELY unresolvable by any
// of the rule's known shapes — proves the `unresolvedHandler` fail-loud path
// reports a rule error instead of silently dropping a registered handler from
// the census. Both census channels are covered: an ACTION_HANDLERS map entry
// (#1706 review M1) and a DERIVED special-branch dispatch, which used to fail
// open through `if (!fnNode) return;`.
//
// Kept as its OWN file (not folded into handler-throw.violating.ts) so these
// dedicated reports don't perturb that fixture's exact-count assertion.

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

// Zero-arg factory whose body does NOT `return` a function/arrow literal
// directly — it returns the RESULT of calling another function. The rule's
// factory-return unwrap only follows a literal function/arrow returned
// directly (the real composite.ts `adaptSetupWorktree()` shape); this
// indirect shape is intentionally unresolvable.
function adaptViaIndirectReturn(): ActionHandler {
  return makeHandlerExternally();
}

const ACTION_HANDLERS: Readonly<Record<string, ActionHandler>> = {
  indirect_factory_return: adaptViaIndirectReturn(),
};

function envelopeWrap(result: ToolResult, _startedAt: number): ToolResult {
  return result;
}

// A module-scoped binding that holds a handler VALUE produced elsewhere — no
// function/arrow literal declaration for the resolver to reach, so no body to
// scan. Dispatched from a real branch, so the census can NAME it
// (`unresolved_branch`) but cannot SCAN it: that is a hole, and the branch
// channel now reports it rather than returning silently.
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

// Fixture: an ACTION_HANDLERS entry whose value shape is GENUINELY
// unresolvable by any of the rule's known shapes — proves the
// `unresolvedHandler` fail-loud path (#1706 review M1) reports a rule error
// on the entry instead of silently dropping a registered handler from the
// census.
//
// Kept as its OWN file (not folded into handler-throw.violating.ts) so this
// dedicated report doesn't perturb that fixture's exact-count assertion.

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

export { ACTION_HANDLERS };

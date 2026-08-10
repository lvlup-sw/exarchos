// Two dispatch shapes the rule used to EXEMPT rather than scan. Both reach a
// real handler, and neither was ever attributed to an action — so a throw
// inside either handler would have been invisible to the gate.
//
// Its own fixture, like handler-throw.unattributed.ts, so these reports do not
// perturb another fixture's exact-count assertion.

type ToolResult =
  | { success: true; data?: unknown }
  | { success: false; error: { code: string; message: string; [key: string]: unknown } };

function envelopeWrap(result: ToolResult, _startedAt: number): ToolResult {
  return result;
}

async function handleAliased(args: { id?: string }): Promise<ToolResult> {
  if (!args.id) {
    return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
  }
  return { success: true };
}

const handlers = {
  handleNamespaced: async (args: { id?: string }): Promise<ToolResult> => {
    if (!args.id) {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'id is required' } };
    }
    return { success: true };
  },
};

// (1) A member-expression callee. `dispatchedCalleeIdentifier` could not name
// it, and the caller read that as "a pre-built envelope, nothing dispatched" —
// so this call was skipped entirely rather than reported as unscannable.
async function dispatchThroughNamespace(rest: Record<string, unknown>): Promise<ToolResult> {
  const startedAt = Date.now();
  return envelopeWrap(await handlers.handleNamespaced(rest as { id?: string }), startedAt);
}

// (2) A plain local ALIAS. The table-dispatch exemption accepted any
// function-local binding, so this qualified as though it came from
// `ACTION_HANDLERS[action]` — it does not, and nothing censuses it.
async function dispatchThroughAlias(rest: Record<string, unknown>): Promise<ToolResult> {
  const startedAt = Date.now();
  const handler = handleAliased;
  return envelopeWrap(await handler(rest as { id?: string }), startedAt);
}

export { dispatchThroughNamespace, dispatchThroughAlias };
